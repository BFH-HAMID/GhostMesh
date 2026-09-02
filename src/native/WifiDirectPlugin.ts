/**
 * TypeScript definition + registration for the custom Capacitor plugin
 * `GhostMeshWifiDirect`. The Kotlin implementation lives in
 * android/app/src/main/java/io/ghostmesh/app/WifiDirectPlugin.kt
 * (see docs/CAPACITOR_ANDROID.md).
 *
 * On web the plugin falls back to a stub that reports `unavailable`.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface WifiDirectPeer {
  deviceAddress: string
  deviceName: string
  /** GhostMesh advert payload embedded in the DNS-SD TXT record */
  txt: Record<string, string>
}

export interface WifiDirectPlugin {
  isAvailable(): Promise<{ available: boolean }>
  requestPermissions(): Promise<{ granted: boolean }>
  /** Start DNS-SD service discovery + advertise our own record. */
  startDiscovery(opts: { serviceName: string; txt: Record<string, string> }): Promise<void>
  stopDiscovery(): Promise<void>
  /** Establish a P2P group / socket to the given device. */
  connect(opts: { deviceAddress: string }): Promise<{ groupOwner: boolean; host: string; port: number }>
  disconnect(opts: { deviceAddress: string }): Promise<void>
  /** Send a UTF-8 frame over the established TCP socket. */
  send(opts: { deviceAddress: string; data: string }): Promise<{ bytes: number }>
  addListener(evt: 'peerFound', cb: (p: WifiDirectPeer) => void): Promise<PluginListenerHandle>
  addListener(evt: 'peerLost', cb: (p: { deviceAddress: string }) => void): Promise<PluginListenerHandle>
  addListener(evt: 'data', cb: (p: { deviceAddress: string; data: string }) => void): Promise<PluginListenerHandle>
  addListener(evt: 'stateChanged', cb: (p: { enabled: boolean }) => void): Promise<PluginListenerHandle>
}

export const WifiDirect = registerPlugin<WifiDirectPlugin>('GhostMeshWifiDirect', {
  web: () => import('./WifiDirectWeb').then((m) => new m.WifiDirectWeb()),
})
