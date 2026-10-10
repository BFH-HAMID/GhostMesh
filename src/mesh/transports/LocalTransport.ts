/**
 * LocalTransport — REAL peer link between GhostMesh instances running in the
 * same browser (other tabs / windows of the same origin) via BroadcastChannel.
 *
 * Every instance beacons its signed-key advert. Packets are addressed by
 * nodeId and only the addressed instance processes them. This is genuine
 * message passing: every packet is E2EE-encrypted/signed by MeshManager
 * exactly as it would be over BLE or Wi-Fi Direct.
 *
 * Use it on the web where no radio is available. It is NOT a simulation.
 */
import type { MeshPacket, NodeId } from '@/types'
import { packetBytes, TransportEmitter, type PeerAdvert, type Transport, type TransportState } from '../Transport'

export const LOCAL_CHANNEL = 'ghostmesh-local-mesh-v1'
const BEACON_MS = 2000
const PEER_TTL_MS = 6000

type Wire =
  | { k: 'beacon'; advert: PeerAdvert }
  | { k: 'pkt'; src: NodeId; dst: NodeId | '*'; packet: MeshPacket }
  | { k: 'bye'; src: NodeId }

interface LocalPeer {
  advert: PeerAdvert
  seen: number
}

export class LocalTransport implements Transport {
  readonly kind = 'local' as const
  state: TransportState = 'idle'
  private em = new TransportEmitter()
  private channel: BroadcastChannel | null = null
  private local: PeerAdvert | null = null
  private peers = new Map<NodeId, LocalPeer>()
  private timer: ReturnType<typeof setInterval> | null = null

  on: Transport['on'] = (evt, cb) => this.em.on(evt, cb)

  neighbours() {
    return [...this.peers.keys()]
  }

  async isAvailable() {
    return typeof BroadcastChannel !== 'undefined'
  }

  async start(localAdvert: PeerAdvert) {
    this.local = localAdvert
    this.setState('starting')
    this.channel = new BroadcastChannel(LOCAL_CHANNEL)
    this.channel.onmessage = (ev: MessageEvent<Wire>) => this.onWire(ev.data)
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide)
    this.beacon()
    this.timer = setInterval(() => {
      this.beacon()
      this.sweep()
    }, BEACON_MS)
    this.setState('active')
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide)
    if (this.local) this.post({ k: 'bye', src: this.local.nodeId })
    this.channel?.close()
    this.channel = null
    for (const id of this.peers.keys()) this.em.emit('peerLost', id)
    this.peers.clear()
    this.setState('stopped')
  }

  async send(to: NodeId, packet: MeshPacket) {
    if (!this.local) throw new Error('local transport not started')
    if (!this.peers.has(to)) throw new Error(`peer ${to.slice(0, 6)} not reachable`)
    this.post({ k: 'pkt', src: this.local.nodeId, dst: to, packet })
    return packetBytes(packet)
  }

  async broadcast(packet: MeshPacket) {
    if (!this.local) return 0
    this.post({ k: 'pkt', src: this.local.nodeId, dst: '*', packet })
    return packetBytes(packet) * this.peers.size
  }

  /* ---------------------------------------------------------------------- */

  private onPageHide = () => {
    if (this.local) this.post({ k: 'bye', src: this.local.nodeId })
  }

  private setState(s: TransportState) {
    this.state = s
    this.em.emit('stateChange', s)
  }

  private post(w: Wire) {
    try {
      this.channel?.postMessage(w)
    } catch {
      /* channel closed */
    }
  }

  private beacon() {
    if (this.local) this.post({ k: 'beacon', advert: this.local })
  }

  private onWire(w: Wire) {
    if (!this.local || !w) return
    switch (w.k) {
      case 'beacon': {
        const id = w.advert.nodeId
        if (id === this.local.nodeId) return
        const known = this.peers.has(id)
        const advert: PeerAdvert = { ...w.advert, rssi: -50 } // same room: treat as a strong link
        this.peers.set(id, { advert, seen: Date.now() })
        if (!known) {
          this.em.emit('peerDiscovered', { ...advert })
          // Answer immediately so the newcomer discovers us without waiting a full beacon period.
          this.beacon()
        }
        return
      }
      case 'pkt': {
        if (w.src === this.local.nodeId) return
        if (w.dst !== '*' && w.dst !== this.local.nodeId) return
        this.em.emit('packet', w.packet, w.src, packetBytes(w.packet))
        return
      }
      case 'bye': {
        if (this.peers.delete(w.src)) this.em.emit('peerLost', w.src)
        return
      }
    }
  }

  private sweep() {
    const now = Date.now()
    for (const [id, p] of this.peers) {
      if (now - p.seen > PEER_TTL_MS) {
        this.peers.delete(id)
        this.em.emit('peerLost', id)
      }
    }
  }
}
