// @vitest-environment jsdom
// @ts-expect-error — React flag required for act() outside a test renderer
globalThis.IS_REACT_ACT_ENVIRONMENT = true
/**
 * Regression test — the Vercel "black screen" bug.
 *
 * `selectPeers` / `selectConversation` return a NEW array on every call.
 * `useGhostStore` subscribes through React's `useSyncExternalStore`, whose
 * getSnapshot must return a referentially stable value. An unstable snapshot
 * makes React believe the state changed on every read → infinite
 * re-render loop → "Maximum update depth exceeded" → the entire tree
 * unmounts (empty #root = black screen in production).
 *
 * The fix: wrap fresh-array selectors with useShallow at every call site.
 * This test renders the real component that had the broken call (NodeList,
 * mounted inside HudShell) and pushes the same store events the mesh emits
 * after boot (samples, node updates, edges, logs). Before the fix it crashes
 * with "Maximum update depth exceeded" and unmounts the tree.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import NodeList from '@/components/NodeList'
import { useGhostStore } from '@/store/useGhostStore'
import type { MeshNode, NetworkSample } from '@/types'

const SELF_ID = 'aaaaaaaaaaaaaaaa'
const PEER_ID = 'bbbbbbbbbbbbbbbb'

const selfNode: MeshNode = {
  id: SELF_ID,
  alias: 'me',
  signPublicKey: 'c2ln',
  boxPublicKey: 'Ym94',
  transport: 'simulated',
  status: 'trusted',
  coord: { lat: 23.81, lon: 90.41 },
  rssi: 0,
  latencyMs: 0,
  hops: 0,
  firstSeen: 0,
  lastSeen: 0,
  isSelf: true,
}

const peerNode: MeshNode = {
  ...selfNode,
  id: PEER_ID,
  alias: 'wraith',
  rssi: -58,
  hops: 1,
  isSelf: false,
}

let container: HTMLDivElement
let root: Root

const makeSample = (): NetworkSample => ({
  t: Date.now(),
  rxBps: 0,
  txBps: 0,
  packetLoss: 0,
  latencyMs: 24,
  avgHops: 1,
  activeNodes: 1,
})

beforeEach(() => {
  useGhostStore.getState().reset()
  useGhostStore.setState({
    phase: 'online',
    identity: { nodeId: SELF_ID, alias: 'me', signPublicKey: 'c2ln', boxPublicKey: 'Ym94', createdAt: 0 },
    nodes: { [SELF_ID]: selfNode, [PEER_ID]: peerNode },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('fresh-array zustand selectors', () => {
  it('survives mesh store updates while mounted (no infinite re-render loop)', () => {
    act(() => {
      root.render(<NodeList />)
    })
    expect(container.textContent).toContain('wraith')

    // Same events MeshManager pushes after boot: an analytics sample every
    // second, plus node updates / edges / logs as the swarm churns.
    for (let i = 0; i < 5; i++) {
      act(() => {
        const s = useGhostStore.getState()
        s.addSample(makeSample())
        s.upsertNode(peerNode, false)
        s.setEdges([[SELF_ID, PEER_ID]])
        s.pushLog('regression tick')
      })
    }

    // Before the useShallow fix this threw "Maximum update depth exceeded"
    // and the whole React tree unmounted (container went empty).
    expect(container.querySelector('button')).toBeTruthy()
    expect(container.textContent).toContain('wraith')
  })

  it('reacts to real peer-set changes', () => {
    act(() => {
      root.render(<NodeList />)
    })
    const second: MeshNode = { ...peerNode, id: 'cccccccccccccccc', alias: 'phantom', rssi: -66 }
    act(() => {
      const s = useGhostStore.getState()
      s.upsertNode(second, true)
      s.addSample(makeSample())
    })
    expect(container.textContent).toContain('wraith')
    expect(container.textContent).toContain('phantom')
    // "Nodes in range · 2"
    expect(container.textContent).toContain('2')
  })
})
