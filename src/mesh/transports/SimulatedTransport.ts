/**
 * SimulatedTransport — an in-memory mesh swarm for browser demos and tests.
 *
 * It spawns virtual peers with real Ed25519/X25519 keys, spreads them across
 * the globe, randomly walks their signal strength, drops some out of range
 * and brings new ones in. Every forwarded packet is bounced back through the
 * swarm with realistic latency so routing/throughput code paths are exercised
 * exactly as they would be over BLE / Wi-Fi Direct.
 */
import nacl from 'tweetnacl'
import type { MeshPacket, NodeId } from '@/types'
import { deriveNodeId } from '@/crypto/E2EECore'
import { bytesToBase64 } from '@/crypto/encoding'
import { packetBytes, TransportEmitter, type PeerAdvert, type Transport, type TransportState } from '../Transport'

interface VirtualPeer extends PeerAdvert {
  signSecret: Uint8Array
  boxSecret: Uint8Array
  driftDir: number
  latency: number
}

const ALIASES = [
  'wraith', 'specter', 'phantom', 'shade', 'revenant', 'banshee', 'poltergeist', 'haunt',
  'echo', 'vapor', 'cipher', 'null', 'onyx', 'nyx', 'umbra', 'static', 'glitch', 'raven',
]

const CITY_SEEDS: Array<[number, number]> = [
  [23.81, 90.41], [35.68, 139.69], [51.51, -0.13], [40.71, -74.01], [-33.87, 151.21],
  [55.75, 37.62], [1.35, 103.82], [19.08, 72.88], [52.52, 13.41], [-23.55, -46.63],
  [37.77, -122.42], [30.04, 31.24], [48.86, 2.35], [25.20, 55.27], [6.52, 3.38],
]

export class SimulatedTransport implements Transport {
  readonly kind = 'simulated' as const
  state: TransportState = 'idle'
  private em = new TransportEmitter()
  private peers = new Map<NodeId, VirtualPeer>()
  private local: PeerAdvert | null = null
  private tick: ReturnType<typeof setInterval> | null = null
  /** Test hook — when provided, called for every packet the sim "receives" */
  onOutbound?: (to: NodeId | '*', packet: MeshPacket) => void

  constructor(private opts: { initialPeers?: number; maxPeers?: number; churnMs?: number } = {}) {}

  async isAvailable() {
    return true
  }

  on: Transport['on'] = (evt, cb) => this.em.on(evt, cb)

  neighbours() {
    return [...this.peers.keys()]
  }

  async start(localAdvert: PeerAdvert) {
    this.local = localAdvert
    this.setState('starting')
    const n = this.opts.initialPeers ?? 6
    for (let i = 0; i < n; i++) await this.spawnPeer()
    this.setState('active')
    this.tick = setInterval(() => void this.churn(), this.opts.churnMs ?? 4000)
  }

  async stop() {
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    for (const id of this.peers.keys()) this.em.emit('peerLost', id)
    this.peers.clear()
    this.setState('stopped')
  }

  async send(to: NodeId, packet: MeshPacket) {
    const peer = this.peers.get(to)
    if (!peer) throw new Error(`peer ${to.slice(0, 6)} not reachable`)
    this.onOutbound?.(to, packet)
    const bytes = packetBytes(packet)
    // Simulate radio: occasional packet loss scales with weak RSSI
    const lossProb = peer.rssi < -85 ? 0.18 : peer.rssi < -70 ? 0.06 : 0.01
    if (Math.random() < lossProb) return bytes
    setTimeout(() => this.reply(peer, packet), peer.latency)
    return bytes
  }

  async broadcast(packet: MeshPacket) {
    this.onOutbound?.('*', packet)
    let total = 0
    for (const id of this.peers.keys()) total += await this.send(id, packet).catch(() => 0)
    return total
  }

  /* ---------------------------------------------------------------------- */

  private setState(s: TransportState) {
    this.state = s
    this.em.emit('stateChange', s)
  }

  private async spawnPeer() {
    const s = nacl.sign.keyPair()
    const b = nacl.box.keyPair()
    const nodeId = await deriveNodeId(s.publicKey)
    const seed = CITY_SEEDS[Math.floor(Math.random() * CITY_SEEDS.length)] ?? [0, 0]
    const peer: VirtualPeer = {
      nodeId,
      alias: `${ALIASES[Math.floor(Math.random() * ALIASES.length)]}-${nodeId.slice(0, 3)}`,
      signPublicKey: bytesToBase64(s.publicKey),
      boxPublicKey: bytesToBase64(b.publicKey),
      signSecret: s.secretKey,
      boxSecret: b.secretKey,
      rssi: -45 - Math.random() * 45,
      lat: seed[0] + (Math.random() - 0.5) * 6,
      lon: seed[1] + (Math.random() - 0.5) * 6,
      driftDir: Math.random() > 0.5 ? 1 : -1,
      latency: 20 + Math.random() * 180,
    }
    this.peers.set(nodeId, peer)
    this.em.emit('peerDiscovered', { ...peer })
  }

  private async churn() {
    const max = this.opts.maxPeers ?? 12
    // Random walk RSSI
    for (const p of this.peers.values()) {
      p.rssi += p.driftDir * Math.random() * 4
      if (Math.random() < 0.15) p.driftDir *= -1
      if (p.rssi > -35) p.rssi = -35
      if (p.rssi < -100) {
        this.peers.delete(p.nodeId)
        this.em.emit('peerLost', p.nodeId)
      } else {
        this.em.emit('peerDiscovered', { ...p })
      }
    }
    if (this.peers.size < max && Math.random() < 0.45) await this.spawnPeer()
  }

  /** Virtual peer reacts to packets: answers PING, ACKs MSG/CHUNK, echoes HELLO. */
  private reply(peer: VirtualPeer, incoming: MeshPacket) {
    if (!this.local || this.state !== 'active') return
    const base = {
      from: peer.nodeId,
      to: this.local.nodeId,
      ttl: 8,
      hopCount: 1 + (Math.random() < 0.3 ? Math.floor(Math.random() * 3) : 0),
      timestamp: Date.now(),
      iv: '',
      payload: '',
      signature: '',
    }
    const relayPath = (): NodeId[] => {
      const others = [...this.peers.keys()].filter((id) => id !== peer.nodeId)
      const hops = base.hopCount - 1
      return [peer.nodeId, ...others.slice(0, hops)]
    }
    let out: MeshPacket | null = null
    switch (incoming.type) {
      case 'PING':
        out = { ...base, id: crypto.randomUUID(), type: 'PONG', payload: incoming.id, path: relayPath() }
        break
      case 'MSG':
        out = { ...base, id: crypto.randomUUID(), type: 'ACK', payload: incoming.id, path: relayPath() }
        break
      case 'CHUNK':
        out = { ...base, id: crypto.randomUUID(), type: 'CHUNK_ACK', payload: incoming.id, path: relayPath() }
        break
      case 'HELLO':
      case 'HANDSHAKE':
        out = {
          ...base,
          id: crypto.randomUUID(),
          type: incoming.type === 'HELLO' ? 'HELLO' : 'HANDSHAKE_ACK',
          path: [peer.nodeId],
          payload: JSON.stringify({
            alias: peer.alias,
            signPublicKey: peer.signPublicKey,
            boxPublicKey: peer.boxPublicKey,
          }),
        }
        break
      default:
        return
    }
    if (out) {
      // Sign with the virtual peer's real Ed25519 key so verification passes
      const header = { id: out.id, type: out.type, from: out.from, to: out.to, timestamp: out.timestamp, iv: out.iv, payload: out.payload }
      const bytes = new TextEncoder().encode(
        `${header.id}\u0000${header.type}\u0000${header.from}\u0000${header.to}\u0000${header.timestamp}\u0000${header.iv}\u0000${header.payload}`,
      )
      out.signature = bytesToBase64(nacl.sign.detached(bytes, peer.signSecret))
      this.em.emit('packet', out, peer.nodeId, packetBytes(out))
    }
  }

  /** Test/demo hook: inject a hostile packet (e.g. forged signature). */
  injectHostile(kind: 'forged' | 'flood' | 'replay', lastPacket?: MeshPacket) {
    if (!this.local) return
    const attacker = [...this.peers.values()][0]
    if (!attacker) return
    if (kind === 'replay' && lastPacket) {
      this.em.emit('packet', { ...lastPacket }, attacker.nodeId, packetBytes(lastPacket))
      return
    }
    const count = kind === 'flood' ? 12 : 1
    for (let i = 0; i < count; i++) {
      const p: MeshPacket = {
        id: crypto.randomUUID(),
        type: 'HANDSHAKE',
        from: kind === 'flood' ? attacker.nodeId : attacker.nodeId,
        to: this.local.nodeId,
        ttl: 4,
        hopCount: 1,
        path: [attacker.nodeId],
        timestamp: Date.now(),
        iv: '',
        payload: JSON.stringify({ alias: 'intruder', signPublicKey: attacker.signPublicKey, boxPublicKey: attacker.boxPublicKey }),
        signature: bytesToBase64(crypto.getRandomValues(new Uint8Array(64))), // garbage sig
      }
      this.em.emit('packet', p, attacker.nodeId, packetBytes(p))
    }
  }
}
