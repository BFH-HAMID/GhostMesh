/**
 * MeshService — wires MeshManager events into the Zustand store and the
 * vault. This is the only place where the mesh layer and UI state meet.
 */
import { MeshManager } from '@/mesh/MeshManager'
import { BleTransport } from '@/mesh/transports/BleTransport'
import { SimulatedTransport } from '@/mesh/transports/SimulatedTransport'
import { WifiDirectTransport } from '@/mesh/transports/WifiDirectTransport'
import { getE2EE } from '@/crypto/E2EEClient'
import { isNative } from '@/native/platform'
import { requestNotificationPermission } from '@/native/Notifications'
import { useGhostStore } from '@/store/useGhostStore'
import { VaultStorage } from './VaultStorage'
import type { ChatMessage } from '@/types'

let manager: MeshManager | null = null
let sim: SimulatedTransport | null = null
let unsubs: Array<() => void> = []

export function getMesh(): MeshManager {
  if (!manager) throw new Error('mesh not booted')
  return manager
}

export function getSim(): SimulatedTransport | null {
  return sim
}

async function localCoord(): Promise<{ lat: number; lon: number }> {
  // Coarse location only; fuzzed further before being advertised.
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve({ lat: 23.81, lon: 90.41 })
    const t = setTimeout(() => resolve({ lat: 23.81, lon: 90.41 }), 2500)
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(t)
        resolve({ lat: p.coords.latitude, lon: p.coords.longitude })
      },
      () => {
        clearTimeout(t)
        resolve({ lat: 23.81, lon: 90.41 })
      },
      { enableHighAccuracy: false, maximumAge: 600_000, timeout: 2000 },
    )
  })
}

export async function bootMesh(alias: string): Promise<void> {
  const store = useGhostStore.getState()
  if (manager) return
  store.setPhase('booting')

  // Fallback chain. On the web only the simulated swarm is available; on
  // Android the radio transports come first and the sim stays as a demo layer
  // that can be disabled from settings.
  const transports = isNative()
    ? [new WifiDirectTransport(), new BleTransport(), (sim = new SimulatedTransport({ initialPeers: 2, maxPeers: 4 }))]
    : [(sim = new SimulatedTransport({ initialPeers: 6, maxPeers: 12 }))]

  manager = new MeshManager(getE2EE(), { transports })
  const m = manager

  unsubs = [
    m.on('identity', (id) => store.setIdentity({ ...id, createdAt: Date.now() })),
    m.on('nodeUpdate', (n, isNew) => {
      useGhostStore.getState().upsertNode({ ...n }, isNew)
      useGhostStore.getState().setEdges(m.topology())
    }),
    m.on('nodeLost', (id) => {
      useGhostStore.getState().removeNode(id)
      useGhostStore.getState().setEdges(m.topology())
    }),
    m.on('message', (msg) => {
      useGhostStore.getState().addMessage(msg)
      void VaultStorage.put(msg)
    }),
    m.on('messageStatus', (id, status, hops) => {
      useGhostStore.getState().updateMessageStatus(id, status, hops)
      void VaultStorage.updateStatus(id, status, hops)
    }),
    m.on('threat', (t) => useGhostStore.getState().addThreat(t)),
    m.on('sample', (s) => useGhostStore.getState().addSample(s)),
    m.on('transport', (k, s) => useGhostStore.getState().setTransport(k, s)),
    m.on('transfer', (t) => useGhostStore.getState().upsertTransfer(t)),
    m.on('log', (l) => useGhostStore.getState().pushLog(l)),
  ]

  void requestNotificationPermission()
  const persisted = await VaultStorage.loadAll().catch(() => [] as ChatMessage[])
  store.setMessages(persisted)

  const coord = await localCoord()
  await m.start(alias, coord)
  useGhostStore.getState().setPhase(m.activeTransports().length ? 'online' : 'offline')
}

export async function shutdownMesh(opts: { nukeVault?: boolean } = {}): Promise<void> {
  unsubs.forEach((u) => u())
  unsubs = []
  await manager?.stop()
  manager = null
  sim = null
  if (opts.nukeVault) await VaultStorage.nuke().catch(() => {})
  useGhostStore.getState().reset()
}

/** Purge a message everywhere: store, vault, and (for outbound) notify peer to burn. */
export async function burnMessage(id: string): Promise<void> {
  useGhostStore.getState().burnMessage(id)
  await VaultStorage.purge(id).catch(() => {})
}
