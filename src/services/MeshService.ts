/**
 * MeshService — wires MeshManager events into the Zustand store and the
 * vault. This is the only place where the mesh layer and UI state meet.
 *
 * Transports
 *   • Android (native): Wi-Fi Direct + BLE.
 *   • Web: LocalTransport — real E2EE links between tabs of this browser.
 *   • DEMO mode (opt-in, off by default): a SimulatedTransport swarm of fake
 *     nodes. Those nodes are labelled SIM everywhere and never make the app
 *     report ONLINE.
 */
import type { Transport } from '@/mesh/Transport'
import { MeshManager } from '@/mesh/MeshManager'
import { BleTransport } from '@/mesh/transports/BleTransport'
import { LocalTransport } from '@/mesh/transports/LocalTransport'
import { SimulatedTransport } from '@/mesh/transports/SimulatedTransport'
import { WifiDirectTransport } from '@/mesh/transports/WifiDirectTransport'
import { getE2EE } from '@/crypto/E2EEClient'
import { isNative } from '@/native/platform'
import { requestNotificationPermission } from '@/native/Notifications'
import { useGhostStore, type AppPhase } from '@/store/useGhostStore'
import { VaultStorage } from './VaultStorage'
import type { ChatMessage } from '@/types'

const DEMO_KEY = 'gm.demo'

let manager: MeshManager | null = null
let sim: SimulatedTransport | null = null
let unsubs: Array<() => void> = []

export function isDemoEnabled(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(DEMO_KEY) === '1'
}

export function setDemoEnabled(on: boolean): void {
  localStorage.setItem(DEMO_KEY, on ? '1' : '0')
}

export function getMesh(): MeshManager {
  if (!manager) throw new Error('mesh not booted')
  return manager
}

export function getSim(): SimulatedTransport | null {
  return sim
}

/** Phase derived from what is really running. Fake nodes never make us "online". */
export function currentPhase(): AppPhase {
  if (!manager) return 'offline'
  const active = manager.activeTransports()
  if (active.some((k) => k !== 'simulated')) return 'online'
  if (active.includes('simulated')) return 'demo'
  return 'offline'
}

function makeTransports(): Transport[] {
  const list: Transport[] = isNative() ? [new WifiDirectTransport(), new BleTransport()] : [new LocalTransport()]
  sim = null
  if (isDemoEnabled()) {
    sim = new SimulatedTransport(isNative() ? { initialPeers: 2, maxPeers: 4 } : { initialPeers: 6, maxPeers: 12 })
    list.push(sim)
  }
  return list
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

  const m = new MeshManager(getE2EE(), { transports: makeTransports() })
  manager = m

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

  try {
    void requestNotificationPermission()
    const persisted = await VaultStorage.loadAll().catch(() => [] as ChatMessage[])
    store.setMessages(persisted)

    const coord = await localCoord()
    await m.start(alias, coord)
  } catch (e) {
    // Roll back completely so the next attempt can boot again instead of
    // silently returning early with a half-started mesh.
    unsubs.forEach((u) => u())
    unsubs = []
    await m.stop().catch(() => {})
    manager = null
    sim = null
    throw e
  }
  useGhostStore.getState().setPhase(currentPhase())
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

/** Purge a message from the store and the local vault. */
export async function burnMessage(id: string): Promise<void> {
  useGhostStore.getState().burnMessage(id)
  await VaultStorage.purge(id).catch(() => {})
}
