/**
 * Global application state (Zustand).
 * Pure data + reducers; side effects live in services/MeshService.ts.
 */
import { create } from 'zustand'
import type {
  ChatMessage,
  FileTransfer,
  Identity,
  MeshNode,
  NetworkSample,
  NodeId,
  ThemeMode,
  ThreatEvent,
  TransportKind,
} from '@/types'

export type AppPhase = 'locked' | 'booting' | 'online' | 'demo' | 'offline'
export type View = 'map' | 'chat' | 'diagnostics' | 'security' | 'files'

interface GhostState {
  phase: AppPhase
  view: View
  theme: ThemeMode
  identity: Identity | null
  nodes: Record<NodeId, MeshNode>
  /** node ids that were discovered in the last few seconds (drives ping animation) */
  freshNodes: Record<NodeId, number>
  edges: Array<[NodeId, NodeId]>
  transports: Partial<Record<TransportKind, string>>
  messages: ChatMessage[]
  activeConversation: NodeId | null
  threats: ThreatEvent[]
  samples: NetworkSample[]
  transfers: Record<string, FileTransfer>
  logs: string[]
  defaultTtlMs: number

  setPhase: (p: AppPhase) => void
  setView: (v: View) => void
  setTheme: (t: ThemeMode) => void
  setIdentity: (i: Identity | null) => void
  upsertNode: (n: MeshNode, fresh: boolean) => void
  removeNode: (id: NodeId) => void
  setEdges: (e: Array<[NodeId, NodeId]>) => void
  setTransport: (k: TransportKind, s: string) => void
  addMessage: (m: ChatMessage) => void
  setMessages: (m: ChatMessage[]) => void
  updateMessageStatus: (id: string, status: ChatMessage['status'], hops?: number) => void
  burnMessage: (id: string) => void
  setActiveConversation: (id: NodeId | null) => void
  addThreat: (t: ThreatEvent) => void
  addSample: (s: NetworkSample) => void
  upsertTransfer: (t: FileTransfer) => void
  pushLog: (l: string) => void
  setDefaultTtl: (ms: number) => void
  reset: () => void
}

const THEME_KEY = 'gm.theme'
const initialTheme = (): ThemeMode => {
  const t = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null
  return t === 'neon-hud' ? 'neon-hud' : 'amoled'
}

const empty = {
  phase: 'locked' as AppPhase,
  view: 'map' as View,
  identity: null,
  nodes: {},
  freshNodes: {},
  edges: [],
  transports: {},
  messages: [],
  activeConversation: null,
  threats: [],
  samples: [],
  transfers: {},
  logs: [],
  defaultTtlMs: 60_000,
}

export const useGhostStore = create<GhostState>()((set) => ({
  ...empty,
  theme: initialTheme(),

  setPhase: (phase) => set({ phase }),
  setView: (view) => set({ view }),
  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme)
    document.documentElement.dataset['theme'] = theme
    set({ theme })
  },
  setIdentity: (identity) => set({ identity }),
  upsertNode: (n, fresh) =>
    set((s) => ({
      nodes: { ...s.nodes, [n.id]: n },
      freshNodes: fresh ? { ...s.freshNodes, [n.id]: Date.now() } : s.freshNodes,
    })),
  removeNode: (id) =>
    set((s) => {
      const nodes = { ...s.nodes }
      delete nodes[id]
      const freshNodes = { ...s.freshNodes }
      delete freshNodes[id]
      return { nodes, freshNodes, edges: s.edges.filter(([a, b]) => a !== id && b !== id) }
    }),
  setEdges: (edges) => set({ edges }),
  setTransport: (k, st) => set((s) => ({ transports: { ...s.transports, [k]: st } })),
  addMessage: (m) => set((s) => (s.messages.some((x) => x.id === m.id) ? s : { messages: [...s.messages, m] })),
  setMessages: (messages) => set({ messages }),
  updateMessageStatus: (id, status, hops) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, status, hops: hops ?? m.hops } : m)) })),
  burnMessage: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
  setActiveConversation: (activeConversation) => set({ activeConversation, view: activeConversation ? 'chat' : 'map' }),
  addThreat: (t) => set((s) => ({ threats: [t, ...s.threats].slice(0, 200) })),
  addSample: (sample) => set((s) => ({ samples: [...s.samples, sample].slice(-120) })),
  upsertTransfer: (t) => set((s) => ({ transfers: { ...s.transfers, [t.id]: t } })),
  pushLog: (l) => set((s) => ({ logs: [...s.logs, l].slice(-300) })),
  setDefaultTtl: (defaultTtlMs) => set({ defaultTtlMs }),
  reset: () => set((s) => ({ ...empty, theme: s.theme })),
}))

/* Selectors */
/**
 * ⚠ selectPeers / selectConversation return a NEW array on every call.
 * `useGhostStore` uses React's `useSyncExternalStore`, whose getSnapshot must
 * be referentially stable: feeding it a fresh array makes React believe the
 * snapshot changed on every read → "Maximum update depth exceeded" → the
 * whole tree unmounts (silent black screen in production).
 *
 * ALWAYS wrap them when subscribing:
 *   const peers = useGhostStore(useShallow(selectPeers))
 * `selectLatestSample` is safe as-is (returns a stable object reference).
 */
export { useShallow } from 'zustand/react/shallow'
export const selectPeers = (s: GhostState) => Object.values(s.nodes).filter((n) => !n.isSelf)
export const selectConversation = (id: NodeId | null) => (s: GhostState) =>
  id ? s.messages.filter((m) => m.conversationId === id) : []
export const selectLatestSample = (s: GhostState) => s.samples[s.samples.length - 1]
