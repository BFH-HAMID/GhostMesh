/**
 * DiagnosticsDashboard — live throughput / loss / latency / hop graphs plus
 * the raw mesh log stream.
 */
import { useEffect, useRef } from 'react'
import Sparkline from './Sparkline'
import { useGhostStore, selectPeers } from '@/store/useGhostStore'

export default function DiagnosticsDashboard() {
  const samples = useGhostStore((s) => s.samples)
  const logs = useGhostStore((s) => s.logs)
  const peers = useGhostStore(selectPeers)
  const transfers = useGhostStore((s) => s.transfers)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs.length])

  const rx = samples.map((s) => s.rxBps)
  const tx = samples.map((s) => s.txBps)
  const loss = samples.map((s) => s.packetLoss * 100)
  const lat = samples.map((s) => s.latencyMs)
  const hops = samples.map((s) => s.avgHops)
  const nodes = samples.map((s) => s.activeNodes)
  const byTransport = peers.reduce<Record<string, number>>((a, p) => ((a[p.transport] = (a[p.transport] ?? 0) + 1), a), {})

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 hud-title">Live network analytics</div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        <Sparkline label="Throughput RX" values={rx} color="#00f3ff" unit="B/s" />
        <Sparkline label="Throughput TX" values={tx} color="#b000ff" unit="B/s" />
        <Sparkline label="Packet loss" values={loss} color="#ff2e4d" unit="%" max={100} format={(v) => v.toFixed(1)} />
        <Sparkline label="Latency" values={lat} color="#ffb300" unit="ms" />
        <Sparkline label="Avg hops" values={hops} color="#2bff88" max={6} format={(v) => v.toFixed(2)} />
        <Sparkline label="Active nodes" values={nodes} color="#ff2bd6" format={(v) => v.toFixed(0)} />
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        <div className="hud-panel p-2">
          <div className="hud-title mb-2">Node table</div>
          <div className="max-h-56 overflow-y-auto text-[11px]">
            <table className="w-full">
              <thead className="text-ghost-dim">
                <tr className="text-left">
                  <th className="pb-1 font-normal">alias</th>
                  <th className="pb-1 font-normal">link</th>
                  <th className="pb-1 font-normal">rssi</th>
                  <th className="pb-1 font-normal">rtt</th>
                  <th className="pb-1 font-normal">hops</th>
                  <th className="pb-1 font-normal">status</th>
                </tr>
              </thead>
              <tbody>
                {peers.map((p) => (
                  <tr key={p.id} className="border-t border-white/5">
                    <td className="py-1 text-cyan">{p.alias}</td>
                    <td>{p.transport}</td>
                    <td className={p.rssi < -85 ? 'text-danger' : p.rssi < -70 ? 'text-warn' : 'text-ok'}>{p.rssi.toFixed(0)}</td>
                    <td>{p.latencyMs}ms</td>
                    <td>{p.hops}</td>
                    <td className={p.status === 'trusted' ? 'text-ok' : 'text-warn'}>{p.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex gap-3 text-[10px] text-ghost">
            {Object.entries(byTransport).map(([k, v]) => (
              <span key={k}>
                {k}: <span className="text-cyan">{v}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="hud-panel p-2">
          <div className="hud-title mb-2">Chunked transfers</div>
          {Object.values(transfers).length === 0 && <div className="text-[11px] text-ghost-dim">No transfers yet.</div>}
          <div className="space-y-2 text-[11px]">
            {Object.values(transfers).map((t) => {
              const routes = new Set(Object.values(t.chunkRoutes)).size
              const pct = t.totalChunks ? (t.chunksDone / t.totalChunks) * 100 : 0
              return (
                <div key={t.id}>
                  <div className="flex justify-between">
                    <span className="truncate text-cyan">{t.name}</span>
                    <span className="text-ghost">
                      {t.chunksDone}/{t.totalChunks} chunks · {routes} paths · {t.status}
                    </span>
                  </div>
                  <div className="mt-1 h-1 w-full bg-white/5">
                    <div className="h-full bg-purple" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="mt-3 hud-panel p-2">
        <div className="hud-title mb-2">Mesh log</div>
        <div ref={logRef} className="h-40 overflow-y-auto text-[10px] leading-relaxed text-ghost">
          {logs.map((l, i) => (
            <div key={i} className={l.includes('WARNING') ? 'text-warn' : ''}>
              {l}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
