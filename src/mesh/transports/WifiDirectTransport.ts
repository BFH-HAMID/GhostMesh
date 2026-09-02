/**
 * WifiDirectTransport — Wi-Fi P2P (Wi-Fi Direct) link for Android.
 *
 * Discovery uses DNS-SD service records (`_ghostmesh._tcp`) so peers can
 * exchange their public advert *before* forming a P2P group. Once connected,
 * packets flow over a TCP socket owned by the native plugin. High bandwidth
 * (tens of Mbps) — preferred for chunked file transfer when available.
 */
import type { MeshPacket, NodeId } from '@/types'
import { WifiDirect, type WifiDirectPeer } from '@/native/WifiDirectPlugin'
import { isNative } from '@/native/platform'
import { packetBytes, TransportEmitter, type PeerAdvert, type Transport, type TransportState } from '../Transport'
import type { PluginListenerHandle } from '@capacitor/core'

export const WFD_SERVICE = '_ghostmesh._tcp'

export class WifiDirectTransport implements Transport {
  readonly kind = 'wifi-direct' as const
  state: TransportState = 'idle'
  private em = new TransportEmitter()
  private handles: PluginListenerHandle[] = []
  private addrToNode = new Map<string, NodeId>()
  private nodeToAddr = new Map<NodeId, string>()

  on: Transport['on'] = (evt, cb) => this.em.on(evt, cb)
  neighbours() {
    return [...this.nodeToAddr.keys()]
  }

  async isAvailable() {
    if (!isNative()) return false
    try {
      return (await WifiDirect.isAvailable()).available
    } catch {
      return false
    }
  }

  async start(localAdvert: PeerAdvert) {
    if (!(await this.isAvailable())) {
      this.setState('unavailable')
      return
    }
    this.setState('starting')
    const perm = await WifiDirect.requestPermissions()
    if (!perm.granted) {
      this.setState('unavailable')
      return
    }
    this.handles.push(
      await WifiDirect.addListener('peerFound', (p) => void this.onPeerFound(p)),
      await WifiDirect.addListener('peerLost', ({ deviceAddress }) => {
        const nodeId = this.addrToNode.get(deviceAddress)
        if (!nodeId) return
        this.addrToNode.delete(deviceAddress)
        this.nodeToAddr.delete(nodeId)
        this.em.emit('peerLost', nodeId)
      }),
      await WifiDirect.addListener('data', ({ deviceAddress, data }) => {
        const nodeId = this.addrToNode.get(deviceAddress)
        if (!nodeId) return
        try {
          const packet = JSON.parse(data) as MeshPacket
          this.em.emit('packet', packet, nodeId, packetBytes(packet))
        } catch {
          this.em.emit('error', new Error('WFD frame decode failed'))
        }
      }),
      await WifiDirect.addListener('stateChanged', ({ enabled }) => this.setState(enabled ? 'active' : 'degraded')),
    )
    await WifiDirect.startDiscovery({
      serviceName: WFD_SERVICE,
      txt: {
        id: localAdvert.nodeId,
        a: localAdvert.alias,
        s: localAdvert.signPublicKey,
        b: localAdvert.boxPublicKey,
      },
    })
    this.setState('active')
  }

  async stop() {
    await WifiDirect.stopDiscovery().catch(() => {})
    for (const h of this.handles) await h.remove()
    this.handles = []
    for (const nodeId of this.nodeToAddr.keys()) this.em.emit('peerLost', nodeId)
    this.addrToNode.clear()
    this.nodeToAddr.clear()
    this.setState('stopped')
  }

  async send(to: NodeId, packet: MeshPacket) {
    const addr = this.nodeToAddr.get(to)
    if (!addr) throw new Error('WFD peer not connected')
    const { bytes } = await WifiDirect.send({ deviceAddress: addr, data: JSON.stringify(packet) })
    return bytes
  }

  async broadcast(packet: MeshPacket) {
    let n = 0
    for (const id of this.neighbours()) n += await this.send(id, packet).catch(() => 0)
    return n
  }

  private setState(s: TransportState) {
    this.state = s
    this.em.emit('stateChange', s)
  }

  private async onPeerFound(p: WifiDirectPeer) {
    const nodeId = p.txt['id']
    if (!nodeId || this.addrToNode.has(p.deviceAddress)) return
    try {
      await WifiDirect.connect({ deviceAddress: p.deviceAddress })
      this.addrToNode.set(p.deviceAddress, nodeId)
      this.nodeToAddr.set(nodeId, p.deviceAddress)
      this.em.emit('peerDiscovered', {
        nodeId,
        alias: p.txt['a'] ?? p.deviceName,
        signPublicKey: p.txt['s'] ?? '',
        boxPublicKey: p.txt['b'] ?? '',
        rssi: -50, // WFD does not expose RSSI pre-connect; treated as strong link
      })
    } catch (e) {
      this.em.emit('error', e instanceof Error ? e : new Error(String(e)))
    }
  }
}
