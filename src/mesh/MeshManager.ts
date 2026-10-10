/**
 * MeshManager — the routing brain of GhostMesh.
 *
 * Responsibilities
 *  • Own the local identity (via the E2EE worker) and advertise it.
 *  • Orchestrate transports with automatic fallback:
 *        internet ➜ wifi-direct ➜ ble ➜ simulated (web demo)
 *  • Maintain the node table + next-hop routing table (distance-vector lite).
 *  • Verify / decrypt every inbound packet through SecurityBot + E2EE.
 *  • Encrypt / sign / route outbound messages & file chunks (multi-path).
 *  • Feed AnalyticsEngine with bytes, RTTs, loss and hop counts.
 *
 * Everything UI-related subscribes through `on(...)`; the manager never
 * imports React.
 */
import type { ChatMessage, FileTransfer, MeshNode, MeshPacket, NetworkSample, NodeId, PacketType, ThreatEvent, TransportKind } from '@/types'
import type { PacketHeader } from '@/crypto/E2EEWorker'
import { base64ToBytes, bytesToBase64, utf8ToBytes } from '@/crypto/encoding'
import { sha256 as sha256Bytes } from '@/crypto/E2EECore'
import { AnalyticsEngine } from '@/services/AnalyticsEngine'
import { SecurityBot } from '@/services/SecurityBot'
import type { PeerAdvert, Transport } from './Transport'

/** Subset of E2EEClient the manager needs — lets tests inject an in-process crypto. */
export interface CryptoProvider {
  init(alias: string): Promise<{ nodeId: string; signPublicKey: string; boxPublicKey: string }>
  establishSession(peerId: string, peerBoxPublicKey: string): Promise<unknown>
  dropSession(peerId: string): Promise<unknown>
  encryptMessage(peerId: string, plaintext: string, aad?: string): Promise<{ iv: string; ciphertext: string }>
  decryptMessage(peerId: string, iv: string, ciphertext: string, aad?: string): Promise<{ plaintext: string }>
  signPacket(header: PacketHeader): Promise<{ signature: string }>
  verifyPacket(header: PacketHeader, signature: string, signerPublicKey: string): Promise<{ valid: boolean }>
  chunkFile(transferId: string, data: ArrayBuffer, chunkSize?: number): Promise<{ totalChunks: number; sha256: string }>
  encryptChunk(transferId: string, index: number): Promise<{ index: number; iv: string; ciphertext: ArrayBuffer }>
  decryptChunk(transferId: string, index: number, iv: string, ciphertext: ArrayBuffer): Promise<{ index: number; plaintext: ArrayBuffer }>
  exportFileKey(transferId: string): Promise<{ rawKey: string }>
  importFileKey(transferId: string, rawKey: string): Promise<unknown>
  purgeTransfer(transferId: string): Promise<unknown>
  wipeAll(): Promise<unknown>
}

export interface MeshEvents {
  identity: (id: { nodeId: NodeId; alias: string; signPublicKey: string; boxPublicKey: string }) => void
  nodeUpdate: (node: MeshNode, isNew: boolean) => void
  nodeLost: (nodeId: NodeId) => void
  message: (msg: ChatMessage) => void
  messageStatus: (id: string, status: ChatMessage['status'], hops?: number) => void
  threat: (event: ThreatEvent) => void
  sample: (s: NetworkSample) => void
  transport: (kind: TransportKind, state: string) => void
  transfer: (t: FileTransfer) => void
  log: (line: string) => void
}

interface HelloPayload {
  alias: string
  signPublicKey: string
  boxPublicKey: string
  lat?: number
  lon?: number
}

interface PendingAck {
  resolve: (hops: number) => void
  timer: ReturnType<typeof setTimeout>
}

/** File metadata sent inside the E2EE MSG channel (carries the per-file AES key). */
interface FileManifest {
  transferId: string
  name: string
  size: number
  mime: string
  totalChunks: number
  sha256: string
  rawKey: string
}

/** Receiver-side reassembly state for one incoming file. */
interface InboundFile {
  peer: NodeId
  manifest: FileManifest | null
  ready: Promise<void> | null
  /** Chunks that arrived before the manifest (and therefore the key). */
  pending: Map<number, { iv: string; ct: Uint8Array }>
  plain: Array<Uint8Array | undefined>
  done: number
  routes: Record<number, NodeId>
  transfer: FileTransfer | null
}

const newInbound = (peer: NodeId): InboundFile => ({
  peer,
  manifest: null,
  ready: null,
  pending: new Map(),
  plain: [],
  done: 0,
  routes: {},
  transfer: null,
})

const PING_INTERVAL = 5000
const ACK_TIMEOUT = 4000
const DEFAULT_TTL = 8
const CHUNK_SIZE = 32 * 1024

export class MeshManager {
  readonly nodes = new Map<NodeId, MeshNode>()
  /** destination -> next hop neighbour */
  readonly routes = new Map<NodeId, NodeId>()
  readonly security: SecurityBot
  readonly analytics = new AnalyticsEngine()
  readonly transfers = new Map<string, FileTransfer>()

  self: MeshNode | null = null
  private advert: PeerAdvert | null = null
  private transports: Transport[] = []
  private active: Transport[] = []
  private peerTransport = new Map<NodeId, Transport>()
  private pendingAcks = new Map<string, PendingAck>()
  private pendingPings = new Map<string, number>()
  private inbound = new Map<string, InboundFile>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private listeners = new Map<keyof MeshEvents, Set<(...args: never[]) => void>>()
  private unsubs: Array<() => void> = []
  private started = false

  constructor(
    private crypto: CryptoProvider,
    opts: { transports: Transport[]; notify?: boolean },
  ) {
    this.transports = opts.transports
    this.security = new SecurityBot({ notify: opts.notify ?? true })
    this.security.onThreat((e) => this.emit('threat', e))
    this.analytics.onSample((s) => this.emit('sample', s))
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  async start(alias: string, coord: { lat: number; lon: number }): Promise<MeshNode> {
    if (this.started) return this.self!
    const id = await this.crypto.init(alias)
    this.self = {
      id: id.nodeId,
      alias,
      signPublicKey: id.signPublicKey,
      boxPublicKey: id.boxPublicKey,
      transport: 'internet',
      status: 'trusted',
      coord,
      rssi: 0,
      latencyMs: 0,
      hops: 0,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      isSelf: true,
    }
    this.advert = {
      nodeId: id.nodeId,
      alias,
      signPublicKey: id.signPublicKey,
      boxPublicKey: id.boxPublicKey,
      rssi: 0,
      lat: coord.lat,
      lon: coord.lon,
    }
    this.nodes.set(this.self.id, this.self)
    this.emit('identity', { nodeId: id.nodeId, alias, signPublicKey: id.signPublicKey, boxPublicKey: id.boxPublicKey })
    this.emit('nodeUpdate', this.self, false) // so the globe can render "YOU" at our location
    this.log(`identity ${id.nodeId.slice(0, 8)} online as "${alias}"`)

    // Transport fallback chain — start every available transport; the first
    // one that comes up "active" is preferred, others act as offline relays.
    for (const t of this.transports) {
      this.unsubs.push(t.on('stateChange', (s) => this.emit('transport', t.kind, s)))
      const ok = await t.isAvailable().catch(() => false)
      if (!ok) {
        this.emit('transport', t.kind, 'unavailable')
        this.log(`transport ${t.kind}: unavailable on this platform`)
        continue
      }
      this.bindTransport(t)
      try {
        await t.start(this.advert)
        this.active.push(t)
        this.log(`transport ${t.kind}: ${t.state}`)
      } catch (e) {
        // One failing radio (e.g. BLE permission denied) must not abort the other transports.
        this.emit('transport', t.kind, 'unavailable')
        this.log(`transport ${t.kind} failed to start: ${(e as Error).message}`)
      }
    }
    if (this.active.length === 0) this.log('WARNING: no transport available — running dark')
    this.analytics.start()
    this.pingTimer = setInterval(() => void this.pingNeighbours(), PING_INTERVAL)
    this.started = true
    return this.self
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    this.analytics.stop()
    for (const t of this.active) await t.stop().catch(() => {})
    this.unsubs.forEach((u) => u())
    this.unsubs = []
    this.active = []
    this.nodes.clear()
    this.routes.clear()
    this.peerTransport.clear()
    this.pendingAcks.forEach((p) => clearTimeout(p.timer))
    this.pendingAcks.clear()
    this.inbound.clear()
    for (const t of this.transfers.values()) if (t.blobUrl) URL.revokeObjectURL(t.blobUrl)
    this.transfers.clear()
    this.security.reset()
    await this.crypto.wipeAll()
    this.self = null
    this.started = false
    this.log('mesh stopped, keys wiped')
  }

  on<K extends keyof MeshEvents>(evt: K, cb: MeshEvents[K]): () => void {
    let set = this.listeners.get(evt)
    if (!set) {
      set = new Set()
      this.listeners.set(evt, set)
    }
    const fn = cb as (...args: never[]) => void
    set.add(fn)
    return () => set.delete(fn)
  }

  private emit<K extends keyof MeshEvents>(evt: K, ...args: Parameters<MeshEvents[K]>): void {
    const set = this.listeners.get(evt) as Set<(...a: Parameters<MeshEvents[K]>) => void> | undefined
    set?.forEach((cb) => {
      try {
        cb(...args)
      } catch (e) {
        console.error(`[mesh:${evt}] listener threw`, e)
      }
    })
  }

  private log(line: string) {
    this.emit('log', `[${new Date().toISOString().slice(11, 19)}] ${line}`)
  }

  /* ---------------------------------------------------------------------- */
  /* Transport binding & discovery                                           */
  /* ---------------------------------------------------------------------- */

  private bindTransport(t: Transport) {
    this.unsubs.push(
      t.on('peerDiscovered', (p) => void this.onPeerDiscovered(p, t)),
      t.on('peerLost', (id) => this.onPeerLost(id, t)),
      t.on('packet', (pkt, via, bytes) => void this.onPacket(pkt, via, bytes, t)),
      t.on('error', (e) => this.log(`${t.kind} error: ${e.message}`)),
    )
  }

  private async onPeerDiscovered(p: PeerAdvert, t: Transport) {
    if (!this.self || p.nodeId === this.self.id) return
    if (this.security.isBlocked(p.nodeId)) return
    const pin = this.security.pinKey(p.nodeId, p.signPublicKey, t.kind)
    if (!pin.allow) return

    const existing = this.nodes.get(p.nodeId)
    const now = Date.now()
    const node: MeshNode = existing
      ? { ...existing, rssi: p.rssi, lastSeen: now, transport: t.kind }
      : {
          id: p.nodeId,
          alias: p.alias,
          signPublicKey: p.signPublicKey,
          boxPublicKey: p.boxPublicKey,
          transport: t.kind,
          status: 'handshaking',
          coord: { lat: p.lat ?? this.fuzz(this.self.coord.lat, 8), lon: p.lon ?? this.fuzz(this.self.coord.lon, 8) },
          rssi: p.rssi,
          latencyMs: 0,
          hops: 1,
          firstSeen: now,
          lastSeen: now,
        }
    this.nodes.set(node.id, node)
    this.peerTransport.set(node.id, t)
    this.routes.set(node.id, node.id) // direct neighbour
    this.analytics.setActiveNodes(this.nodes.size - 1)
    this.emit('nodeUpdate', node, !existing)

    if (!existing) {
      // Establish E2EE session (X25519 -> HKDF -> AES-256-GCM) and handshake.
      try {
        await this.crypto.establishSession(node.id, node.boxPublicKey)
        await this.sendPacket({ type: 'HANDSHAKE', to: node.id, payloadPlain: JSON.stringify(this.helloPayload()) })
        node.status = 'trusted'
        this.nodes.set(node.id, node)
        this.emit('nodeUpdate', node, false)
        this.log(`peer ${node.alias} (${node.id.slice(0, 6)}) trusted via ${t.kind} rssi=${p.rssi.toFixed(0)}`)
      } catch (e) {
        this.log(`handshake with ${node.id.slice(0, 6)} failed: ${(e as Error).message}`)
      }
    }
  }

  private onPeerLost(id: NodeId, t: Transport) {
    if (this.peerTransport.get(id) !== t) return
    this.nodes.delete(id)
    this.peerTransport.delete(id)
    this.routes.delete(id)
    // Any multi-hop route through this neighbour is now stale
    for (const [dst, hop] of this.routes) if (hop === id) this.routes.delete(dst)
    void this.crypto.dropSession(id)
    this.analytics.setActiveNodes(this.nodes.size - 1)
    this.emit('nodeLost', id)
    this.log(`peer ${id.slice(0, 6)} out of range`)
  }

  private helloPayload(): HelloPayload {
    const s = this.self!
    return {
      alias: s.alias,
      signPublicKey: s.signPublicKey,
      boxPublicKey: s.boxPublicKey,
      lat: this.fuzz(s.coord.lat, 0.5),
      lon: this.fuzz(s.coord.lon, 0.5),
    }
  }

  private fuzz(v: number, range: number) {
    return v + (Math.random() - 0.5) * range
  }

  /* ---------------------------------------------------------------------- */
  /* Inbound pipeline                                                        */
  /* ---------------------------------------------------------------------- */

  private async onPacket(pkt: MeshPacket, via: NodeId, bytes: number, t: Transport) {
    if (!this.self) return
    this.analytics.recordRx(bytes)
    const src = this.nodes.get(pkt.from)
    const verdict = this.security.inspectInbound(pkt, via, t.kind, src?.status === 'trusted')
    if (!verdict.allow) return

    // Signature verification — origin key from node table or from the HELLO payload itself
    let signer = src?.signPublicKey
    if (!signer && (pkt.type === 'HELLO' || pkt.type === 'HANDSHAKE' || pkt.type === 'HANDSHAKE_ACK')) {
      try {
        signer = (JSON.parse(pkt.payload) as HelloPayload).signPublicKey
      } catch {
        signer = undefined
      }
    }
    if (!signer) return
    const header = this.header(pkt)
    const { valid } = await this.crypto.verifyPacket(header, pkt.signature, signer)
    if (!valid) {
      this.security.signatureFailed(pkt, t.kind)
      return
    }

    // Not for us -> relay
    if (pkt.to !== '*' && pkt.to !== this.self.id) {
      await this.relay(pkt, via)
      return
    }

    this.learnRoute(pkt, via)
    switch (pkt.type) {
      case 'HELLO':
      case 'HANDSHAKE':
      case 'HANDSHAKE_ACK':
        await this.onHandshake(pkt, t, via)
        break
      case 'PING':
        await this.sendPacket({ type: 'PONG', to: pkt.from, payloadPlain: pkt.id })
        break
      case 'PONG': {
        const sentAt = this.pendingPings.get(pkt.payload)
        if (sentAt) {
          const rtt = Date.now() - sentAt
          this.pendingPings.delete(pkt.payload)
          this.analytics.recordRtt(rtt)
          const n = this.nodes.get(pkt.from)
          if (n) {
            n.latencyMs = Math.round(n.latencyMs ? n.latencyMs * 0.6 + rtt * 0.4 : rtt)
            n.hops = pkt.hopCount
            n.lastSeen = Date.now()
            this.emit('nodeUpdate', n, false)
          }
        }
        break
      }
      case 'ACK':
      case 'CHUNK_ACK': {
        const p = this.pendingAcks.get(pkt.payload)
        if (p) {
          clearTimeout(p.timer)
          this.pendingAcks.delete(pkt.payload)
          this.analytics.recordHops(pkt.hopCount)
          p.resolve(pkt.hopCount)
        }
        break
      }
      case 'MSG':
        await this.onEncryptedMessage(pkt, t)
        break
      case 'CHUNK':
        if (this.nodes.get(pkt.from)?.status !== 'trusted') break
        await this.onChunk(pkt, via)
        await this.sendPacket({ type: 'CHUNK_ACK', to: pkt.from, payloadPlain: pkt.id })
        break
      case 'ROUTE_ADV':
        break
    }
  }

  private async onHandshake(pkt: MeshPacket, t: Transport, via: NodeId) {
    let hello: HelloPayload
    try {
      hello = JSON.parse(pkt.payload) as HelloPayload
    } catch {
      return
    }
    if (!this.self || !hello.signPublicKey || !hello.boxPublicKey) return
    const pin = this.security.pinKey(pkt.from, hello.signPublicKey, t.kind)
    if (!pin.allow) return

    let n = this.nodes.get(pkt.from)
    if (!n && via === pkt.from) {
      // Direct neighbour whose discovery we have not processed yet: adopt its signed identity.
      const now = Date.now()
      n = {
        id: pkt.from,
        alias: hello.alias || pkt.from.slice(0, 6),
        signPublicKey: hello.signPublicKey,
        boxPublicKey: hello.boxPublicKey,
        transport: t.kind,
        status: 'handshaking',
        coord: { lat: hello.lat ?? this.fuzz(this.self.coord.lat, 8), lon: hello.lon ?? this.fuzz(this.self.coord.lon, 8) },
        rssi: -50,
        latencyMs: 0,
        hops: 1,
        firstSeen: now,
        lastSeen: now,
      }
      this.nodes.set(n.id, n)
      this.peerTransport.set(n.id, t)
      this.routes.set(n.id, n.id)
    }
    if (!n) return

    // The session key is derived from the box key inside the SIGNED handshake (the
    // discovery advert is unauthenticated). Re-deriving with the same key is idempotent.
    await this.crypto.establishSession(n.id, hello.boxPublicKey)
    n.boxPublicKey = hello.boxPublicKey
    n.alias = hello.alias || n.alias
    if (hello.lat !== undefined && hello.lon !== undefined) n.coord = { lat: hello.lat, lon: hello.lon }
    n.hops = Math.max(1, pkt.hopCount)
    n.status = 'trusted'
    n.lastSeen = Date.now()
    this.emit('nodeUpdate', n, false)
    this.log(`peer ${n.alias} (${n.id.slice(0, 6)}) trusted via ${t.kind}`)

    if (pkt.type === 'HANDSHAKE') {
      await this.sendPacket({ type: 'HANDSHAKE_ACK', to: pkt.from, payloadPlain: JSON.stringify(this.helloPayload()) })
    }
  }

  private async onEncryptedMessage(pkt: MeshPacket, t: Transport) {
    if (!this.self) return
    if (this.nodes.get(pkt.from)?.status !== 'trusted') {
      // No session yet: an early packet, not an attack. Drop without a threat alarm.
      this.log(`dropped message from untrusted node ${pkt.from.slice(0, 6)}`)
      return
    }
    let body: { text: string; ttlMs: number; attachment?: ChatMessage['attachment']; manifest?: FileManifest }
    try {
      const { plaintext } = await this.crypto.decryptMessage(pkt.from, pkt.iv, pkt.payload, this.aad(pkt))
      body = JSON.parse(plaintext)
    } catch {
      this.security.payloadTampered(pkt, t.kind)
      return
    }
    if (body.manifest) {
      // File manifest: not a chat message. Sets up reassembly for the chunks that follow.
      await this.onManifest(pkt.from, body.manifest)
      await this.sendPacket({ type: 'ACK', to: pkt.from, payloadPlain: pkt.id })
      return
    }
    const now = Date.now()
    const msg: ChatMessage = {
      id: pkt.id,
      conversationId: pkt.from,
      from: pkt.from,
      to: this.self.id,
      body: body.text ?? '',
      createdAt: pkt.timestamp,
      ttlMs: body.ttlMs ?? 60_000,
      expiresAt: now + (body.ttlMs ?? 60_000),
      direction: 'in',
      status: 'delivered',
      hops: pkt.hopCount,
      attachment: body.attachment,
    }
    this.emit('message', msg)
    await this.sendPacket({ type: 'ACK', to: pkt.from, payloadPlain: pkt.id })
  }

  private learnRoute(pkt: MeshPacket, via: NodeId) {
    if (pkt.from !== via && !this.routes.has(pkt.from)) this.routes.set(pkt.from, via)
  }

  private async relay(pkt: MeshPacket, via: NodeId) {
    if (!this.self || pkt.ttl <= 0) return
    if (pkt.path.includes(this.self.id)) return // loop guard
    const next = this.nextHop(pkt.to)
    const fwd: MeshPacket = { ...pkt, ttl: pkt.ttl - 1, hopCount: pkt.hopCount + 1, path: [...pkt.path, this.self.id] }
    const t = next ? this.peerTransport.get(next) : undefined
    if (next && t && next !== via) {
      const bytes = await t.send(next, fwd).catch(() => 0)
      this.analytics.recordTx(bytes)
    } else {
      // Unknown destination: controlled flood to all neighbours except the one we got it from
      for (const [id, tr] of this.peerTransport) {
        if (id === via) continue
        this.analytics.recordTx(await tr.send(id, fwd).catch(() => 0))
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Outbound                                                                */
  /* ---------------------------------------------------------------------- */

  private header(p: MeshPacket): PacketHeader {
    return { id: p.id, type: p.type, from: p.from, to: p.to, timestamp: p.timestamp, iv: p.iv, payload: p.payload }
  }

  /** Additional authenticated data binds ciphertext to (id, from, to) — foils splice attacks. */
  private aad(p: { id: string; from: string; to: string }): string {
    return bytesToBase64(utf8ToBytes(`${p.id}|${p.from}|${p.to}`))
  }

  private nextHop(dst: NodeId | '*'): NodeId | undefined {
    if (dst === '*') return undefined
    const hop = this.routes.get(dst)
    if (hop && this.peerTransport.has(hop)) return hop
    // Fallback: strongest neighbour
    let best: MeshNode | undefined
    for (const id of this.peerTransport.keys()) {
      const n = this.nodes.get(id)
      if (n && (!best || n.rssi > best.rssi)) best = n
    }
    return best?.id
  }

  /**
   * Build, (optionally) encrypt, sign, and push a packet onto the mesh.
   * Returns packet id and bytes transmitted.
   */
  private async sendPacket(opts: {
    type: PacketType
    to: NodeId | '*'
    payloadPlain: string
    encrypt?: boolean
    id?: string
    viaNeighbour?: NodeId
  }): Promise<{ id: string; bytes: number }> {
    if (!this.self) throw new Error('mesh not started')
    const id = opts.id ?? crypto.randomUUID()
    let iv = ''
    let payload = opts.payloadPlain
    if (opts.encrypt && opts.to !== '*') {
      const enc = await this.crypto.encryptMessage(opts.to, opts.payloadPlain, this.aad({ id, from: this.self.id, to: opts.to }))
      iv = enc.iv
      payload = enc.ciphertext
    }
    const draft: Omit<MeshPacket, 'signature'> = {
      id,
      type: opts.type,
      from: this.self.id,
      to: opts.to,
      ttl: DEFAULT_TTL,
      hopCount: 0,
      path: [],
      timestamp: Date.now(),
      iv,
      payload,
    }
    const { signature } = await this.crypto.signPacket(draft)
    const pkt: MeshPacket = { ...draft, signature }

    let bytes = 0
    if (opts.to === '*') {
      for (const t of this.active) bytes += await t.broadcast(pkt).catch(() => 0)
    } else {
      const hop = opts.viaNeighbour ?? this.nextHop(opts.to)
      const t = hop ? this.peerTransport.get(hop) : undefined
      if (!hop || !t) throw new Error('no route to destination')
      bytes = await t.send(hop, pkt)
    }
    this.analytics.recordTx(bytes)
    return { id, bytes }
  }

  private awaitAck(id: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id)
        this.analytics.recordLoss()
        reject(new Error('ack timeout'))
      }, ACK_TIMEOUT)
      this.pendingAcks.set(id, { resolve, timer })
    })
  }

  /** Send an E2EE self-destructing chat message. Resolves when the peer ACKs. */
  async sendMessage(to: NodeId, text: string, ttlMs: number, attachment?: ChatMessage['attachment']): Promise<ChatMessage> {
    if (!this.self) throw new Error('mesh not started')
    const peer = this.nodes.get(to)
    if (!peer || peer.status !== 'trusted') throw new Error('peer not trusted')
    const now = Date.now()
    const { id } = await this.sendPacket({
      type: 'MSG',
      to,
      encrypt: true,
      payloadPlain: JSON.stringify({ text, ttlMs, attachment }),
    })
    const msg: ChatMessage = {
      id,
      conversationId: to,
      from: this.self.id,
      to,
      body: text,
      createdAt: now,
      ttlMs,
      expiresAt: now + ttlMs,
      direction: 'out',
      status: 'sent',
      attachment,
    }
    this.emit('message', msg)
    this.awaitAck(id)
      .then((hops) => this.emit('messageStatus', id, 'delivered', hops))
      .catch(() => this.emit('messageStatus', id, 'failed'))
    return msg
  }

  private async pingNeighbours() {
    if (!this.self) return
    for (const id of this.peerTransport.keys()) {
      try {
        const { id: pid } = await this.sendPacket({ type: 'PING', to: id, payloadPlain: '', viaNeighbour: id })
        this.pendingPings.set(pid, Date.now())
        setTimeout(() => {
          if (this.pendingPings.delete(pid)) this.analytics.recordLoss()
        }, ACK_TIMEOUT)
      } catch {
        /* neighbour vanished between iterations */
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Encrypted chunked file sharing (multi-path)                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Split a file into AES-256-GCM encrypted chunks and route each chunk via a
   * neighbour (round-robin over the strongest N links). No single relay ever
   * sees the whole ciphertext, and the per-file key travels only inside the
   * E2EE MSG channel to the final recipient. Lost chunks are retried; if any
   * chunk is still unacknowledged the transfer is reported as failed.
   */
  async sendFile(to: NodeId, file: { name: string; size: number; type: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<FileTransfer> {
    if (!this.self) throw new Error('mesh not started')
    const peer = this.nodes.get(to)
    if (!peer || peer.status !== 'trusted') throw new Error('peer not trusted')
    const relays = [...this.peerTransport.keys()]
      .map((id) => this.nodes.get(id))
      .filter((n): n is MeshNode => !!n)
      .sort((a, b) => b.rssi - a.rssi)
      .slice(0, 4)
      .map((n) => n.id)
    if (relays.length === 0) throw new Error('no relays available')

    const transferId = crypto.randomUUID()
    const data = await file.arrayBuffer()
    const { totalChunks, sha256 } = await this.crypto.chunkFile(transferId, data, CHUNK_SIZE)
    const transfer: FileTransfer = {
      id: transferId,
      name: file.name,
      size: file.size,
      mime: file.type,
      totalChunks,
      chunksDone: 0,
      direction: 'out',
      peer: to,
      status: 'routing',
      chunkRoutes: {},
      sha256,
      startedAt: Date.now(),
    }
    this.transfers.set(transferId, transfer)
    this.emit('transfer', { ...transfer })

    let failed = 0
    try {
      // File key + manifest travel through the E2EE message channel first.
      const { rawKey } = await this.crypto.exportFileKey(transferId)
      await this.sendPacket({
        type: 'MSG',
        to,
        encrypt: true,
        payloadPlain: JSON.stringify({
          text: `[file-manifest] ${file.name}`,
          ttlMs: 10 * 60_000,
          manifest: { transferId, name: file.name, size: file.size, mime: file.type, totalChunks, sha256, rawKey },
        }),
      })

      const inflight: Promise<boolean>[] = []
      for (let i = 0; i < totalChunks; i++) {
        const relay = relays[i % relays.length]!
        const { iv, ciphertext } = await this.crypto.encryptChunk(transferId, i)
        const payloadPlain = JSON.stringify({ transferId, index: i, iv, data: bytesToBase64(new Uint8Array(ciphertext)) })
        inflight.push(this.deliverChunk(to, relay, payloadPlain, transfer, i))
        // Back-pressure: at most 8 chunks in flight.
        if (inflight.length >= 8) {
          for (const ok of await Promise.all(inflight.splice(0))) if (!ok) failed++
        }
      }
      for (const ok of await Promise.all(inflight)) if (!ok) failed++
    } finally {
      await this.crypto.purgeTransfer(transferId).catch(() => {})
    }

    transfer.status = failed === 0 ? 'complete' : 'failed'
    this.emit('transfer', { ...transfer })
    if (failed > 0) throw new Error(`${failed}/${totalChunks} chunks were not acknowledged`)
    this.log(`file ${file.name} sent in ${totalChunks} chunks over ${relays.length} paths`)
    return transfer
  }

  /** Send one chunk, retrying up to 3 times if its ACK never arrives. */
  private async deliverChunk(to: NodeId, relay: NodeId, payloadPlain: string, transfer: FileTransfer, index: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { id } = await this.sendPacket({ type: 'CHUNK', to, viaNeighbour: relay, payloadPlain })
        const acked = await this.awaitAck(id).then(
          () => true,
          () => false,
        )
        if (acked) {
          transfer.chunkRoutes[index] = relay
          transfer.chunksDone++
          this.emit('transfer', { ...transfer })
          return true
        }
      } catch {
        /* relay vanished mid-send — retry */
      }
    }
    return false
  }

  /* ---------------------------------------------------------------------- */
  /* Inbound file transfer (receiver side)                                   */
  /* ---------------------------------------------------------------------- */

  private async onManifest(from: NodeId, m: FileManifest) {
    if (!m || typeof m.transferId !== 'string' || !Number.isInteger(m.totalChunks) || m.totalChunks < 1 || m.totalChunks > 100_000) return
    let f = this.inbound.get(m.transferId)
    if (!f) {
      f = newInbound(from)
      this.inbound.set(m.transferId, f)
    }
    if (f.manifest) return // duplicate manifest
    f.manifest = m
    f.peer = from
    f.plain = new Array<Uint8Array | undefined>(m.totalChunks)
    // Set the promise synchronously so chunks arriving meanwhile wait for the key.
    f.ready = this.crypto.importFileKey(m.transferId, m.rawKey).then(() => undefined)
    try {
      await f.ready
    } catch (e) {
      this.failInbound(m.transferId, f, `bad file key: ${(e as Error).message}`)
      return
    }
    f.transfer = {
      id: m.transferId,
      name: m.name,
      size: m.size,
      mime: m.mime,
      totalChunks: m.totalChunks,
      chunksDone: 0,
      direction: 'in',
      peer: from,
      status: 'reassembling',
      chunkRoutes: { ...f.routes },
      sha256: m.sha256,
      startedAt: Date.now(),
    }
    this.transfers.set(m.transferId, f.transfer)
    this.emit('transfer', { ...f.transfer })
    this.log(`incoming file ${m.name} (${m.totalChunks} chunks) from ${from.slice(0, 6)}`)
    const early = [...f.pending.entries()]
    f.pending.clear()
    for (const [idx, p] of early) await this.decryptInbound(m.transferId, f, idx, p.iv, p.ct)
  }

  private async onChunk(pkt: MeshPacket, via: NodeId) {
    let body: { transferId: string; index: number; iv: string; data: string }
    try {
      body = JSON.parse(pkt.payload)
    } catch {
      return
    }
    if (typeof body.transferId !== 'string' || !Number.isInteger(body.index) || body.index < 0) return
    let f = this.inbound.get(body.transferId)
    if (!f) {
      f = newInbound(pkt.from)
      this.inbound.set(body.transferId, f)
    }
    if (f.routes[body.index] === undefined) f.routes[body.index] = via
    const ct = base64ToBytes(body.data)
    if (f.manifest) await this.decryptInbound(body.transferId, f, body.index, body.iv, ct)
    else f.pending.set(body.index, { iv: body.iv, ct })
  }

  private async decryptInbound(transferId: string, f: InboundFile, index: number, iv: string, ct: Uint8Array) {
    const m = f.manifest
    if (!m || index >= m.totalChunks || f.plain[index]) return
    try {
      await f.ready
      const { plaintext } = await this.crypto.decryptChunk(transferId, index, iv, ct.slice().buffer)
      if (f.plain[index]) return
      f.plain[index] = new Uint8Array(plaintext)
      f.done++
      if (f.transfer) {
        f.transfer.chunksDone = f.done
        f.transfer.chunkRoutes = { ...f.routes }
        this.emit('transfer', { ...f.transfer })
      }
      if (f.done === m.totalChunks) await this.finishInbound(transferId, f)
    } catch (e) {
      // Wrong key or tampered chunk (GCM tag failure): fail the transfer loudly.
      this.failInbound(transferId, f, `chunk ${index} rejected: ${(e as Error).message}`)
    }
  }

  private async finishInbound(transferId: string, f: InboundFile) {
    const m = f.manifest!
    const total = f.plain.reduce((n, part) => n + (part?.length ?? 0), 0)
    const full = new Uint8Array(total)
    let off = 0
    for (const part of f.plain) {
      if (part) {
        full.set(part, off)
        off += part.length
      }
    }
    f.plain = []
    void this.crypto.purgeTransfer(transferId).catch(() => {})
    const digest = bytesToBase64(await sha256Bytes(full))
    if (total !== m.size || digest !== m.sha256) {
      this.failInbound(transferId, f, 'hash mismatch — file discarded')
      return
    }
    const url = URL.createObjectURL(new Blob([full], { type: m.mime || 'application/octet-stream' }))
    if (f.transfer) {
      f.transfer.status = 'complete'
      f.transfer.blobUrl = url
      this.emit('transfer', { ...f.transfer })
    }
    this.inbound.delete(transferId)
    this.log(`file ${m.name} received and verified (sha256 ok)`)
  }

  private failInbound(transferId: string, f: InboundFile, reason: string) {
    f.plain = []
    f.pending.clear()
    void this.crypto.purgeTransfer(transferId).catch(() => {})
    if (f.transfer) {
      f.transfer.status = 'failed'
      this.emit('transfer', { ...f.transfer })
    }
    this.inbound.delete(transferId)
    this.log(`file transfer ${transferId.slice(0, 8)} failed: ${reason}`)
  }

  /* ---------------------------------------------------------------------- */
  /* Introspection                                                           */
  /* ---------------------------------------------------------------------- */

  activeTransports(): TransportKind[] {
    return this.active.filter((t) => t.state === 'active').map((t) => t.kind)
  }

  topology(): Array<[NodeId, NodeId]> {
    const edges: Array<[NodeId, NodeId]> = []
    if (!this.self) return edges
    for (const [dst, hop] of this.routes) {
      edges.push(hop === dst ? [this.self.id, dst] : [hop, dst])
    }
    return edges
  }
}
