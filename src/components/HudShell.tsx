/**
 * HudShell — main application chrome: status bar, navigation, view router.
 * Layout: sidebar (node list) + main viewport on desktop; tabbed on mobile.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { useGhostStore, selectPeers, selectLatestSample, useShallow } from '@/store/useGhostStore'
import { useTheme } from '@/hooks/useTheme'
import { isDemoEnabled, setDemoEnabled, shutdownMesh } from '@/services/MeshService'
import NodeList from './NodeList'
import SelfDestructChat from './SelfDestructChat'
import SecurityPanel from './SecurityPanel'
import DiagnosticsDashboard from './DiagnosticsDashboard'

const MeshMap = lazy(() => import('./MeshMap'))

/** Epoch cutoff for "recent" alerts, refreshed every 5 s. */
function useRecentCutoff(windowMs: number): number {
  const [cutoff, setCutoff] = useState(() => Date.now() - windowMs)
  useEffect(() => {
    const id = setInterval(() => setCutoff(Date.now() - windowMs), 5000)
    return () => clearInterval(id)
  }, [windowMs])
  return cutoff
}

const NAV = [
  { id: 'map', label: 'GLOBE', glyph: '◍' },
  { id: 'chat', label: 'CHAT', glyph: '▤' },
  { id: 'diagnostics', label: 'DIAG', glyph: '▥' },
  { id: 'security', label: 'SEC', glyph: '⛨' },
] as const

export default function HudShell() {
  const view = useGhostStore((s) => s.view)
  const setView = useGhostStore((s) => s.setView)
  const phase = useGhostStore((s) => s.phase)
  const identity = useGhostStore((s) => s.identity)
  const peers = useGhostStore(useShallow(selectPeers))
  const sample = useGhostStore(selectLatestSample)
  const threats = useGhostStore((s) => s.threats)
  const setPhase = useGhostStore((s) => s.setPhase)
  const { theme, toggle } = useTheme()
  const recentCutoff = useRecentCutoff(15_000)
  const critical = threats.filter((t) => t.timestamp > recentCutoff && (t.severity === 'critical' || t.severity === 'high')).length

  return (
    <div className="grid-bg flex h-full flex-col">
      {/* Status bar */}
      <header className="hud-panel flex items-center gap-3 border-x-0 border-t-0 px-3 py-1.5 text-[10px]">
        <span className="font-display tracking-[0.3em] neon-text-cyan">GHOSTMESH</span>
        <span className={`flex items-center gap-1 ${phase === 'online' ? 'text-ok' : phase === 'demo' ? 'text-purple' : 'text-warn'}`}>
          <i className={`inline-block h-1.5 w-1.5 rounded-full ${phase === 'online' ? 'bg-ok animate-ping-slow' : phase === 'demo' ? 'bg-purple' : 'bg-warn'}`} />
          {phase === 'demo' ? 'DEMO · SIMULATED' : phase.toUpperCase()}
        </span>
        <span className="hidden text-ghost sm:inline">
          ID <span className="text-cyan">{identity?.nodeId.slice(0, 12)}</span> · {identity?.alias}
        </span>
        <span className="ml-auto hidden gap-3 text-ghost md:flex">
          <span>
            NODES <span className="text-cyan">{peers.length}</span>
          </span>
          <span>
            RTT <span className="text-cyan">{sample?.latencyMs.toFixed(0) ?? '–'}</span>ms
          </span>
          <span>
            LOSS <span className={sample && sample.packetLoss > 0.1 ? 'text-danger' : 'text-cyan'}>{((sample?.packetLoss ?? 0) * 100).toFixed(1)}</span>%
          </span>
          <span>
            HOPS <span className="text-cyan">{sample?.avgHops.toFixed(1) ?? '–'}</span>
          </span>
        </span>
        {critical > 0 && (
          <button onClick={() => setView('security')} className="animate-blink border border-danger px-2 py-0.5 text-danger" title="Security alerts">
            ⚠ {critical}
          </button>
        )}
        <button
          className={`btn-hud !py-0.5 ${isDemoEnabled() ? 'bg-purple/20' : ''}`}
          title={isDemoEnabled() ? 'Demo ON: fake simulated nodes are running. Click to turn off (restarts the mesh).' : 'Demo OFF: only real links. Click to add simulated test nodes (restarts the mesh).'}
          onClick={() => {
            setDemoEnabled(!isDemoEnabled())
            void shutdownMesh().then(() => setPhase('locked'))
          }}
        >
          DEMO {isDemoEnabled() ? 'ON' : 'OFF'}
        </button>
        <button className="btn-hud !py-0.5" onClick={toggle} title="Toggle AMOLED / Neon HUD">
          {theme === 'amoled' ? 'AMOLED' : 'NEON HUD'}
        </button>
        <button className="btn-hud !py-0.5" onClick={() => setPhase('locked')} title="Lock (keys stay in worker)">
          LOCK
        </button>
        <button className="btn-hud danger !py-0.5" onClick={() => void shutdownMesh({ nukeVault: true })} title="Wipe keys + vault">
          PANIC
        </button>
      </header>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 border-r lg:block" style={{ borderColor: 'var(--gm-border)' }}>
          <NodeList />
        </aside>
        <main className="relative min-w-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-xs text-ghost-dim">
                <span className="animate-blink">initialising holographic renderer…</span>
              </div>
            }
          >
            {view === 'map' && <MeshMap />}
            {view === 'chat' && (
              <div className="flex h-full">
                <div className="w-56 shrink-0 border-r lg:hidden" style={{ borderColor: 'var(--gm-border)' }}>
                  <NodeList />
                </div>
                <div className="min-w-0 flex-1">
                  <SelfDestructChat />
                </div>
              </div>
            )}
            {view === 'diagnostics' && <DiagnosticsDashboard />}
            {view === 'security' && <SecurityPanel />}
          </Suspense>
        </main>
      </div>

      {/* Bottom nav */}
      <nav className="hud-panel flex border-x-0 border-b-0">
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setView(n.id)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] tracking-widest transition-colors ${
              view === n.id ? 'text-cyan' : 'text-ghost-dim hover:text-ghost'
            }`}
          >
            <span className="text-base leading-none">{n.glyph}</span>
            {n.label}
            {n.id === 'security' && critical > 0 && <span className="h-1 w-1 rounded-full bg-danger" />}
          </button>
        ))}
      </nav>
    </div>
  )
}
