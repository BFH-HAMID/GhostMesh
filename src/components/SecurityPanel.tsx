/**
 * SecurityPanel — redacted HUD log of the Security Bot plus red-team
 * controls (available only when the simulated transport is running) to
 * demonstrate detection of forged handshakes, floods and replays.
 */
import { useGhostStore } from '@/store/useGhostStore'
import { getSim } from '@/services/MeshService'
import type { Severity } from '@/types'

const sevColor: Record<Severity, string> = {
  info: 'text-ghost',
  low: 'text-ok',
  medium: 'text-warn',
  high: 'text-magenta',
  critical: 'text-danger',
}

export default function SecurityPanel() {
  const threats = useGhostStore((s) => s.threats)
  const sim = getSim()
  const counts = threats.reduce<Record<string, number>>((a, t) => ((a[t.severity] = (a[t.severity] ?? 0) + 1), a), {})

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="hud-title">Security bot · threat log</div>
        <div className="ml-auto flex gap-2 text-[10px]">
          {(['critical', 'high', 'medium', 'low'] as Severity[]).map((s) => (
            <span key={s} className={sevColor[s]}>
              {s} {counts[s] ?? 0}
            </span>
          ))}
        </div>
      </div>

      {sim && (
        <div className="hud-panel mb-3 flex flex-wrap items-center gap-2 p-2">
          <span className="text-[10px] text-ghost">RED-TEAM SIM</span>
          <button className="btn-hud danger" onClick={() => sim.injectHostile('forged')}>
            forged handshake
          </button>
          <button
            className="btn-hud danger"
            onClick={() => {
              for (let i = 0; i < 6; i++) sim.injectHostile('forged')
            }}
          >
            brute-force ×6
          </button>
          <button className="btn-hud danger" onClick={() => sim.injectHostile('flood')}>
            packet flood
          </button>
        </div>
      )}

      <div className="hud-panel flex-1 overflow-y-auto p-2">
        {threats.length === 0 && (
          <div className="text-[11px] text-ghost-dim">No anomalies. Bot is inspecting handshakes and packet signatures…</div>
        )}
        <div className="space-y-1 text-[11px]">
          {threats.map((t) => (
            <div key={t.id} className="grid grid-cols-[70px_1fr] gap-2 border-b border-white/5 py-1 lg:grid-cols-[70px_150px_90px_1fr]">
              <span className="text-ghost-dim">{new Date(t.timestamp).toLocaleTimeString([], { hour12: false })}</span>
              <span className={`${sevColor[t.severity]} font-bold tracking-wider`}>{t.kind}</span>
              <span className="text-ghost">
                {t.sourceRedacted} · {t.transport}
              </span>
              <span className="col-span-2 lg:col-span-1">
                <span className="mr-2 border px-1 text-[9px] uppercase" style={{ borderColor: 'var(--gm-border)' }}>
                  {t.action}
                </span>
                {t.message}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
