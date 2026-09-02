/**
 * Transport abstraction layer.
 *
 * MeshManager talks only to this interface. Concrete implementations:
 *   - InternetTransport   (WebSocket / WebRTC signalling — browsers & online Android)
 *   - BleTransport        (Capacitor @capacitor-community/bluetooth-le — Android)
 *   - WifiDirectTransport (custom Capacitor plugin `GhostMeshWifiDirect` — Android)
 *   - SimulatedTransport  (in-memory swarm for web demo / tests)
 *
 * All of them emit the same events so routing logic is transport-agnostic.
 */
import type { MeshPacket, NodeId, TransportKind } from '@/types'

export interface PeerAdvert {
  nodeId: NodeId
  alias: string
  signPublicKey: string
  boxPublicKey: string
  rssi: number
  /** Optional coarse coordinate broadcast by the peer (may be fuzzed for privacy) */
  lat?: number
  lon?: number
}

export interface TransportEvents {
  peerDiscovered: (peer: PeerAdvert) => void
  peerLost: (nodeId: NodeId) => void
  packet: (packet: MeshPacket, viaPeer: NodeId, rawBytes: number) => void
  stateChange: (state: TransportState) => void
  error: (err: Error) => void
}

export type TransportState = 'idle' | 'starting' | 'active' | 'degraded' | 'stopped' | 'unavailable'

export interface Transport {
  readonly kind: TransportKind
  readonly state: TransportState
  /** Whether this transport can run on the current platform (e.g. BLE only on native). */
  isAvailable(): Promise<boolean>
  start(localAdvert: PeerAdvert): Promise<void>
  stop(): Promise<void>
  /** Send to a directly-connected neighbour. Resolves with bytes on the wire. */
  send(to: NodeId, packet: MeshPacket): Promise<number>
  /** Broadcast to all directly-connected neighbours. */
  broadcast(packet: MeshPacket): Promise<number>
  neighbours(): NodeId[]
  on<K extends keyof TransportEvents>(evt: K, cb: TransportEvents[K]): () => void
}

/** Minimal typed emitter shared by all transports. */
type AnyFn = (...args: never[]) => void

export class TransportEmitter {
  private listeners = new Map<keyof TransportEvents, Set<AnyFn>>()

  on<K extends keyof TransportEvents>(evt: K, cb: TransportEvents[K]): () => void {
    let set = this.listeners.get(evt)
    if (!set) {
      set = new Set()
      this.listeners.set(evt, set)
    }
    set.add(cb as AnyFn)
    return () => set.delete(cb as AnyFn)
  }

  emit<K extends keyof TransportEvents>(evt: K, ...args: Parameters<TransportEvents[K]>): void {
    const set = this.listeners.get(evt) as Set<(...a: Parameters<TransportEvents[K]>) => void> | undefined
    set?.forEach((cb) => {
      try {
        cb(...args)
      } catch (e) {
        console.error(`[transport:${evt}] listener threw`, e)
      }
    })
  }

  removeAll(): void {
    this.listeners.clear()
  }
}

export const packetBytes = (p: MeshPacket): number => new TextEncoder().encode(JSON.stringify(p)).byteLength
