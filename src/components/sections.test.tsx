// @vitest-environment jsdom
// @ts-expect-error — React flag required for act() outside a test renderer
globalThis.IS_REACT_ACT_ENVIRONMENT = true
/**
 * Section-by-section UI checks. Each screen is rendered with realistic store
 * data and checked for the labels, states and buttons a user relies on.
 * The 3D globe is replaced by a stub (no WebGL in jsdom); its HUD overlay is real.
 */
// jsdom has no layout engine: scrollTo is used for auto-scroll only.
Element.prototype.scrollTo = function () {}

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGhostStore } from '@/store/useGhostStore'
import type { ChatMessage, FileTransfer, MeshNode, ThreatEvent } from '@/types'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: ReactNode }) => <div data-testid="globe-canvas">{children}</div>,
  useFrame: () => {},
}))
vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children?: ReactNode }) => <div data-testid="globe-label">{children}</div>,
  Line: () => null,
  OrbitControls: () => null,
  Stars: () => null,
}))
const meshState = vi.hoisted(() => ({ sim: null as unknown, phase: 'online' as string }))
vi.mock('@/services/MeshService', () => ({
  getSim: () => meshState.sim,
  getMesh: () => ({ sendMessage: vi.fn(), sendFile: vi.fn() }),
  burnMessage: vi.fn(),
  shutdownMesh: vi.fn(async () => {}),
  setDemoEnabled: vi.fn(),
  isDemoEnabled: () => false,
  currentPhase: () => meshState.phase,
  bootMesh: vi.fn(async () => {}),
}))

import HudShell from './HudShell'
import NodeList from './NodeList'
import SelfDestructChat from './SelfDestructChat'
import SecurityPanel from './SecurityPanel'
import DiagnosticsDashboard from './DiagnosticsDashboard'
import MeshMap from './MeshMap'
import LockScreen from './LockScreen'

const SELF_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const PEER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const SIM_ID = 'cccccccccccccccccccccccccccccccc'

const base = {
  signPublicKey: 'c2ln',
  boxPublicKey: 'Ym94',
  rssi: -58,
  latencyMs: 24,
  firstSeen: 0,
  lastSeen: 0,
}
const selfNode: MeshNode = {
  ...base,
  id: SELF_ID,
  alias: 'me',
  transport: 'local',
  status: 'trusted',
  coord: { lat: 22.36, lon: 91.78 },
  hops: 0,
  isSelf: true,
}
const peerNode: MeshNode = { ...base, id: PEER_ID, alias: 'wraith', transport: 'local', status: 'trusted', coord: { lat: 23.81, lon: 90.41 }, hops: 1 }
const simNode: MeshNode = { ...base, id: SIM_ID, alias: 'phantom-ccc', transport: 'simulated', status: 'trusted', coord: { lat: 35.68, lon: 139.69 }, hops: 1 }

let container: HTMLDivElement
let root: Root

const render = (el: ReactNode) =>
  act(() => {
    root.render(el)
  })
const text = () => container.textContent ?? ''
const buttons = () => [...container.querySelectorAll('button')]
const buttonWith = (label: string) => buttons().find((b) => b.textContent?.includes(label) || b.title?.includes(label))

beforeEach(() => {
  useGhostStore.getState().reset()
  meshState.sim = null
  meshState.phase = 'online'
  useGhostStore.setState({
    phase: 'online',
    identity: { nodeId: SELF_ID, alias: 'me', signPublicKey: 'c2ln', boxPublicKey: 'Ym94', createdAt: 0 },
    nodes: { [SELF_ID]: selfNode, [PEER_ID]: peerNode },
    activeConversation: null,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Header (HudShell status bar)', () => {
  it('shows ONLINE, identity, and the DEMO toggle for a real link', () => {
    render(<HudShell />)
    expect(text()).toContain('ONLINE')
    expect(text()).toContain('me')
    expect(text()).toContain(SELF_ID.slice(0, 12))
    expect(buttonWith('DEMO OFF')).toBeTruthy()
    expect(text()).toContain('NODES')
  })

  it('shows DEMO · SIMULATED (not ONLINE) when only fake nodes run', () => {
    useGhostStore.setState({ phase: 'demo' })
    render(<HudShell />)
    expect(text()).toContain('DEMO · SIMULATED')
    expect(text()).not.toContain('ONLINE')
  })

  it('every header button exists and nav tabs switch the view', () => {
    render(<HudShell />)
    for (const label of ['AMOLED', 'LOCK', 'PANIC', 'GLOBE', 'CHAT', 'DIAG', 'SEC']) {
      expect(buttonWith(label), label).toBeTruthy()
    }
    act(() => buttonWith('CHAT')!.click())
    expect(useGhostStore.getState().view).toBe('chat')
  })
})

describe('Node list (sidebar)', () => {
  it('lists real peers with their link type and trusted state', () => {
    render(<NodeList />)
    expect(text()).toContain('wraith')
    expect(text()).toContain('LOCAL tab')
    expect(text()).toContain('Nodes in range · 1')
  })

  it('tags simulated nodes as SIM (fake) so they never pass as real', () => {
    useGhostStore.getState().upsertNode(simNode, true)
    render(<NodeList />)
    expect(text()).toContain('phantom-ccc')
    expect(text()).toContain('SIM (fake)')
  })

  it('shows a clear hint when nobody is in range', () => {
    useGhostStore.setState({ nodes: { [SELF_ID]: selfNode } })
    render(<NodeList />)
    expect(text()).toContain('No peers in range')
    expect(text()).toContain('another tab')
  })

  it('selecting a trusted peer opens its chat', () => {
    render(<NodeList />)
    const btn = buttons().find((b) => b.textContent?.includes('wraith'))!
    act(() => btn.click())
    expect(useGhostStore.getState().activeConversation).toBe(PEER_ID)
  })
})

describe('Chat section', () => {
  const msg = (over: Partial<ChatMessage>): ChatMessage => ({
    id: 'm1',
    conversationId: PEER_ID,
    from: PEER_ID,
    to: SELF_ID,
    body: 'hi there',
    createdAt: Date.now(),
    ttlMs: 60_000,
    expiresAt: Date.now() + 60_000,
    direction: 'in',
    status: 'delivered',
    ...over,
  })

  it('asks the user to pick a channel when none is open', () => {
    render(<SelfDestructChat />)
    expect(text()).toContain('No channel selected')
  })

  it('renders messages, the TTL presets and the encrypted composer', () => {
    useGhostStore.setState({ activeConversation: PEER_ID, messages: [msg({ id: 'a', body: 'hello world' })] })
    render(<SelfDestructChat />)
    expect(text()).toContain('wraith')
    expect(text()).toContain('hello world')
    for (const p of ['10s', '30s', '1m', '5m', '1h']) expect(buttonWith(p), p).toBeTruthy()
    expect(container.querySelector('input[placeholder="transmit encrypted…"]')).toBeTruthy()
  })

  it('shows a download link only after a received file is verified', () => {
    const t: FileTransfer = {
      id: 't1',
      name: 'plan.pdf',
      size: 2048,
      mime: 'application/pdf',
      totalChunks: 2,
      chunksDone: 1,
      direction: 'in',
      peer: PEER_ID,
      status: 'reassembling',
      chunkRoutes: {},
      sha256: 'x',
      startedAt: 0,
    }
    useGhostStore.setState({
      activeConversation: PEER_ID,
      messages: [msg({ id: 'f', body: '', attachment: { name: 'plan.pdf', size: 2048, transferId: 't1' } })],
      transfers: { t1: t },
    })
    render(<SelfDestructChat />)
    expect(text()).toContain('receiving 1/2')
    expect(container.querySelector('a[download]')).toBeNull()

    act(() => useGhostStore.getState().upsertTransfer({ ...t, status: 'complete', chunksDone: 2, blobUrl: 'blob:ok' }))
    const link = container.querySelector('a[download]') as HTMLAnchorElement | null
    expect(link).toBeTruthy()
    expect(link!.getAttribute('href')).toBe('blob:ok')
    expect(link!.getAttribute('download')).toBe('plan.pdf')
  })

  it('shows failed receive clearly', () => {
    const t: FileTransfer = {
      id: 't2',
      name: 'x.bin',
      size: 10,
      mime: '',
      totalChunks: 1,
      chunksDone: 0,
      direction: 'in',
      peer: PEER_ID,
      status: 'failed',
      chunkRoutes: {},
      sha256: '',
      startedAt: 0,
    }
    useGhostStore.setState({
      activeConversation: PEER_ID,
      messages: [msg({ id: 'g', body: '', attachment: { name: 'x.bin', size: 10, transferId: 't2' } })],
      transfers: { t2: t },
    })
    render(<SelfDestructChat />)
    expect(text()).toContain('failed')
  })
})

describe('Security section', () => {
  it('shows an empty-state message when there are no threats', () => {
    render(<SecurityPanel />)
    expect(text()).toContain('No anomalies')
    expect(text()).not.toContain('RED-TEAM SIM')
  })

  it('lists threats with severity counts and actions', () => {
    const ev: ThreatEvent = {
      id: 'e1',
      kind: 'SIGNATURE_INVALID',
      severity: 'high',
      sourceRedacted: 'abcd…ef',
      transport: 'local',
      message: 'Ed25519 verify failed on HANDSHAKE',
      timestamp: Date.now(),
      action: 'dropped',
    }
    useGhostStore.getState().addThreat(ev)
    render(<SecurityPanel />)
    expect(text()).toContain('SIGNATURE_INVALID')
    expect(text()).toContain('dropped')
    expect(text()).toContain('high 1')
  })
})

describe('Diagnostics section', () => {
  it('shows node table with link type and an empty transfer state', () => {
    render(<DiagnosticsDashboard />)
    expect(text()).toContain('Live network analytics')
    expect(text()).toContain('Node table')
    expect(text()).toContain('wraith')
    expect(text()).toContain('local')
    expect(text()).toContain('No transfers yet')
    expect(text()).toContain('Throughput RX')
  })
})

describe('Globe section (MeshMap)', () => {
  it('shows the waiting hint when no peers are in range', () => {
    useGhostStore.setState({ nodes: { [SELF_ID]: selfNode } })
    render(<MeshMap />)
    expect(text()).toContain('WAITING FOR NODES IN RANGE')
  })

  it('labels every node with its link tag; self is marked YOU', () => {
    useGhostStore.getState().upsertNode(simNode, true)
    render(<MeshMap />)
    const labels = [...container.querySelectorAll('[data-testid="globe-label"]')].map((e) => e.textContent ?? '')
    expect(labels.join(' | ')).toContain('YOU')
    expect(labels.join(' | ')).toContain('TAB')
    expect(labels.join(' | ')).toContain('SIM')
    expect(text()).not.toContain('WAITING FOR NODES')
  })

  it('legend lists the real link types and the SIM colour', () => {
    useGhostStore.setState({ transports: { local: 'active', simulated: 'active' } })
    render(<MeshMap />)
    expect(text()).toContain('● local')
    expect(text()).toContain('● simulated')
    expect(text()).toContain('SIM (fake demo)')
  })
})

describe('Lock screen', () => {
  it('asks for a passphrase on the web and enforces the minimum length', async () => {
    useGhostStore.setState({ identity: null })
    render(<LockScreen />)
    expect(text()).toContain('Callsign')
    expect(container.querySelector('input[type="password"]')).toBeTruthy()
    const form = container.querySelector('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(text()).toContain('at least 6 characters')
  })
})
