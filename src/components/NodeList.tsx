/** Sidebar list of peers with quick chat access. */
import { useGhostStore, selectPeers } from '@/store/useGhostStore'

export default function NodeList() {
  const peers = useGhostStore(selectPeers)
  const active = useGhostStore((s) => s.activeConversation)
  const setActive = useGhostStore((s) => s.setActiveConversation)
  const messages = useGhostStore((s) => s.messages)

  const unread = (id: string) => messages.filter((m) => m.conversationId === id && m.direction === 'in').length

  return (
    <div className="flex h-full flex-col">
      <div className="hud-title px-3 py-2">Nodes in range · {peers.length}</div>
      <div className="flex-1 overflow-y-auto">
        {peers
          .slice()
          .sort((a, b) => b.rssi - a.rssi)
          .map((p) => {
            const bars = p.rssi > -55 ? 4 : p.rssi > -70 ? 3 : p.rssi > -85 ? 2 : 1
            return (
              <button
                key={p.id}
                disabled={p.status !== 'trusted'}
                onClick={() => setActive(p.id)}
                className={`flex w-full items-center gap-2 border-b border-white/5 px-3 py-2 text-left text-[11px] transition-colors hover:bg-cyan/5 disabled:opacity-40 ${
                  active === p.id ? 'bg-cyan/10' : ''
                }`}
              >
                <span className="flex h-3 items-end gap-[2px]">
                  {[1, 2, 3, 4].map((b) => (
                    <i key={b} className={`w-[3px] ${b <= bars ? 'bg-cyan' : 'bg-white/10'}`} style={{ height: `${b * 3}px` }} />
                  ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-cyan">{p.alias}</span>
                  <span className="block truncate text-[9px] text-ghost-dim">
                    {p.id.slice(0, 10)} · {p.transport} · {p.hops}h
                  </span>
                </span>
                {unread(p.id) > 0 && <span className="rounded-sm bg-purple/30 px-1 text-[9px] text-purple">{unread(p.id)}</span>}
                <span className={`text-[9px] ${p.status === 'trusted' ? 'text-ok' : 'text-warn'}`}>{p.status === 'trusted' ? '●' : '◌'}</span>
              </button>
            )
          })}
      </div>
    </div>
  )
}
