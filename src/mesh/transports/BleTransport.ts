/**
 * BleTransport — Bluetooth Low Energy mesh link (Android via Capacitor).
 *
 * GATT layout (central role — we scan & connect; peers run a GATT server via
 * the native `GhostMeshBlePeripheral` companion plugin, see docs):
 *
 *   Service  0000gm01-0000-1000-8000-00805f9b34fb  (GHOSTMESH_SERVICE)
 *   ├─ Char  ...gm02  ADVERT   (read)   -> JSON PeerAdvert (public keys only)
 *   ├─ Char  ...gm03  INBOX    (write w/o response) <- framed packets
 *   └─ Char  ...gm04  OUTBOX   (notify) -> framed packets
 *
 * Packets larger than the negotiated MTU are split into `[seq:1][total:1][data]`
 * frames and reassembled here.
 */
import type { MeshPacket, NodeId } from '@/types'
import { isNative } from '@/native/platform'
import { packetBytes, TransportEmitter, type PeerAdvert, type Transport, type TransportState } from '../Transport'

export const BLE_SERVICE = '0000a1b2-0000-1000-8000-00805f9b34fb'
export const BLE_CHAR_ADVERT = '0000a1b3-0000-1000-8000-00805f9b34fb'
export const BLE_CHAR_INBOX = '0000a1b4-0000-1000-8000-00805f9b34fb'
export const BLE_CHAR_OUTBOX = '0000a1b5-0000-1000-8000-00805f9b34fb'
const FRAME_DATA = 180 // conservative for MTU 185 (Android default after negotiation ~ 247)

type Ble = typeof import('@capacitor-community/bluetooth-le').BleClient

interface BlePeer {
  deviceId: string
  nodeId: NodeId
  rssi: number
  connected: boolean
  reassembly: Map<number, Uint8Array[]>
}

export class BleTransport implements Transport {
  readonly kind = 'ble' as const
  state: TransportState = 'idle'
  private em = new TransportEmitter()
  private ble: Ble | null = null
  private peers = new Map<NodeId, BlePeer>()
  private byDevice = new Map<string, NodeId>()
  private local: PeerAdvert | null = null

  on: Transport['on'] = (evt, cb) => this.em.on(evt, cb)
  neighbours() {
    return [...this.peers.values()].filter((p) => p.connected).map((p) => p.nodeId)
  }

  async isAvailable() {
    if (!isNative()) return false
    try {
      const { BleClient } = await import('@capacitor-community/bluetooth-le')
      this.ble = BleClient
      await BleClient.initialize({ androidNeverForLocation: true })
      return await BleClient.isEnabled()
    } catch {
      return false
    }
  }

  async start(localAdvert: PeerAdvert) {
    this.local = localAdvert
    if (!this.ble && !(await this.isAvailable())) {
      this.setState('unavailable')
      return
    }
    const ble = this.ble!
    this.setState('starting')
    await ble.requestLEScan({ services: [BLE_SERVICE], allowDuplicates: true }, (result) => {
      void this.onScanResult(result.device.deviceId, result.rssi ?? -90)
    })
    this.setState('active')
  }

  async stop() {
    await this.ble?.stopLEScan().catch(() => {})
    for (const p of this.peers.values()) {
      if (p.connected) await this.ble?.disconnect(p.deviceId).catch(() => {})
      this.em.emit('peerLost', p.nodeId)
    }
    this.peers.clear()
    this.byDevice.clear()
    this.setState('stopped')
  }

  async send(to: NodeId, packet: MeshPacket) {
    const peer = this.peers.get(to)
    if (!peer?.connected || !this.ble) throw new Error('BLE peer not connected')
    const bytes = new TextEncoder().encode(JSON.stringify(packet))
    const total = Math.ceil(bytes.length / FRAME_DATA)
    for (let seq = 0; seq < total; seq++) {
      const slice = bytes.subarray(seq * FRAME_DATA, (seq + 1) * FRAME_DATA)
      const frame = new Uint8Array(2 + slice.length)
      frame[0] = seq
      frame[1] = total
      frame.set(slice, 2)
      await this.ble.writeWithoutResponse(peer.deviceId, BLE_SERVICE, BLE_CHAR_INBOX, new DataView(frame.buffer))
    }
    return bytes.length
  }

  async broadcast(packet: MeshPacket) {
    let n = 0
    for (const id of this.neighbours()) n += await this.send(id, packet).catch(() => 0)
    return n
  }

  /* ---------------------------------------------------------------------- */

  private setState(s: TransportState) {
    this.state = s
    this.em.emit('stateChange', s)
  }

  private async onScanResult(deviceId: string, rssi: number) {
    const known = this.byDevice.get(deviceId)
    if (known) {
      const p = this.peers.get(known)
      if (p) {
        p.rssi = rssi
        if (rssi < -95) {
          this.byDevice.delete(deviceId)
          this.peers.delete(known)
          this.em.emit('peerLost', known)
        }
      }
      return
    }
    if (!this.ble || !this.local) return
    try {
      await this.ble.connect(deviceId, () => this.onDisconnect(deviceId))
      const advRaw = await this.ble.read(deviceId, BLE_SERVICE, BLE_CHAR_ADVERT)
      const adv = JSON.parse(new TextDecoder().decode(advRaw)) as PeerAdvert
      const peer: BlePeer = { deviceId, nodeId: adv.nodeId, rssi, connected: true, reassembly: new Map() }
      this.peers.set(adv.nodeId, peer)
      this.byDevice.set(deviceId, adv.nodeId)
      await this.ble.startNotifications(deviceId, BLE_SERVICE, BLE_CHAR_OUTBOX, (dv) => this.onFrame(peer, dv))
      // Push our advert so the peripheral learns about us too
      const mine = new TextEncoder().encode(JSON.stringify(this.local))
      await this.ble.write(deviceId, BLE_SERVICE, BLE_CHAR_ADVERT, new DataView(mine.buffer)).catch(() => {})
      this.em.emit('peerDiscovered', { ...adv, rssi })
    } catch (e) {
      this.em.emit('error', e instanceof Error ? e : new Error(String(e)))
      await this.ble.disconnect(deviceId).catch(() => {})
    }
  }

  private onDisconnect(deviceId: string) {
    const nodeId = this.byDevice.get(deviceId)
    if (!nodeId) return
    const p = this.peers.get(nodeId)
    if (p) p.connected = false
    this.byDevice.delete(deviceId)
    this.peers.delete(nodeId)
    this.em.emit('peerLost', nodeId)
  }

  private onFrame(peer: BlePeer, dv: DataView) {
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
    const seq = bytes[0] ?? 0
    const total = bytes[1] ?? 1
    const key = total // simple: one in-flight packet per peer per size class
    const parts = peer.reassembly.get(key) ?? new Array<Uint8Array>(total)
    parts[seq] = bytes.subarray(2)
    peer.reassembly.set(key, parts)
    if (parts.filter(Boolean).length !== total) return
    peer.reassembly.delete(key)
    const len = parts.reduce((n, p) => n + p.length, 0)
    const full = new Uint8Array(len)
    let off = 0
    for (const p of parts) {
      full.set(p, off)
      off += p.length
    }
    try {
      const packet = JSON.parse(new TextDecoder().decode(full)) as MeshPacket
      this.em.emit('packet', packet, peer.nodeId, packetBytes(packet))
    } catch {
      this.em.emit('error', new Error('BLE frame decode failed'))
    }
  }
}
