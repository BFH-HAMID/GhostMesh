/**
 * SelfDestructChat — E2EE conversation view with per-message TTL countdowns.
 *
 * Every bubble shows a shrinking fuse bar. When it hits zero the message is
 * purged from React state, the Zustand store and IndexedDB (see
 * useSelfDestruct). Outbound messages carry their TTL inside the encrypted
 * payload so the receiver burns them on the same schedule.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useGhostStore, selectConversation, useShallow } from '@/store/useGhostStore'
import { getMesh, burnMessage } from '@/services/MeshService'
import { formatCountdown, ttlProgress, useSelfDestruct } from '@/hooks/useSelfDestruct'
import type { ChatMessage, FileTransfer } from '@/types'

const TTL_PRESETS: Array<{ label: string; ms: number }> = [
  { label: '10s', ms: 10_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 5 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
]

function StatusGlyph({ m }: { m: ChatMessage }) {
  const map: Record<ChatMessage['status'], string> = {
    pending: '◌',
    sent: '✓',
    delivered: '✓✓',
    read: '✓✓',
    burned: '☠',
    failed: '✕',
  }
  const c = m.status === 'failed' ? 'text-danger' : m.status === 'delivered' ? 'text-cyan' : 'text-ghost-dim'
  return (
    <span className={c} title={m.status}>
      {map[m.status]}
      {m.hops !== undefined && m.status === 'delivered' ? ` ${m.hops}h` : ''}
    </span>
  )
}

function Bubble({ m, now, transfer }: { m: ChatMessage; now: number; transfer?: FileTransfer }) {
  const p = ttlProgress(m.createdAt, m.expiresAt, now)
  const out = m.direction === 'out'
  const critical = p < 0.15
  const color = out ? 'var(--color-purple)' : 'var(--color-cyan)'
  return (
    <div className={`flex ${out ? 'justify-end' : 'justify-start'} px-3`}>
      <div
        className="relative max-w-[78%] border px-3 py-2 text-sm"
        style={{
          borderColor: critical ? 'var(--color-danger)' : `${color}55`,
          background: out ? 'rgba(176,0,255,0.06)' : 'rgba(0,243,255,0.05)',
          opacity: 0.35 + p * 0.65,
          transition: 'opacity 250ms linear',
        }}
      >
        {m.attachment && (
          <div className="mb-1 flex items-center gap-2 border-b border-dashed pb-1 text-[11px]" style={{ borderColor: `${color}44` }}>
            <span style={{ color }}>▣</span>
            <span className="truncate">{m.attachment.name}</span>
            <span className="opacity-60">{(m.attachment.size / 1024).toFixed(1)}kB</span>
            {transfer && transfer.direction === 'in' && transfer.status === 'complete' && transfer.blobUrl && (
              <a href={transfer.blobUrl} download={m.attachment.name} className="ml-auto underline" style={{ color }}>
                save
              </a>
            )}
            {transfer && transfer.direction === 'in' && transfer.status !== 'complete' && (
              <span className="ml-auto opacity-70">
                {transfer.status === 'failed' ? 'failed' : `receiving ${transfer.chunksDone}/${transfer.totalChunks}`}
              </span>
            )}
            {transfer && transfer.direction === 'out' && (
              <span className="ml-auto opacity-70">
                {transfer.status === 'failed' ? 'partly lost' : `sent ${transfer.chunksDone}/${transfer.totalChunks}`}
              </span>
            )}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words leading-relaxed">{m.body}</div>
        <div className="mt-1 flex items-center justify-between gap-3 text-[10px] opacity-80">
          <span className={critical ? 'text-danger animate-blink' : ''} style={{ color: critical ? undefined : color }}>
            ⏱ {formatCountdown(m.expiresAt - now)}
          </span>
          <span className="flex items-center gap-2">
            {out && <StatusGlyph m={m} />}
            <button
              className="opacity-50 hover:opacity-100 hover:text-danger"
              title="Burn now"
              onClick={() => void burnMessage(m.id)}
            >
              ✖
            </button>
          </span>
        </div>
        {/* Fuse bar */}
        <div className="absolute bottom-0 left-0 h-[2px] w-full bg-white/5">
          <div
            className="h-full"
            style={{ width: `${p * 100}%`, background: critical ? 'var(--color-danger)' : color, transition: 'width 250ms linear' }}
          />
        </div>
      </div>
    </div>
  )
}

export default function SelfDestructChat() {
  const now = useSelfDestruct(250)
  const peerId = useGhostStore((s) => s.activeConversation)
  const peer = useGhostStore((s) => (peerId ? s.nodes[peerId] : undefined))
  // useShallow is REQUIRED: selectConversation returns a fresh array each call,
  // and useSyncExternalStore loops forever on an unstable snapshot.
  const messages = useGhostStore(useShallow(selectConversation(peerId)))
  const defaultTtl = useGhostStore((s) => s.defaultTtlMs)
  const setDefaultTtl = useGhostStore((s) => s.setDefaultTtl)
  const back = useGhostStore((s) => s.setActiveConversation)
  const upsertTransfer = useGhostStore((s) => s.upsertTransfer)
  const transfers = useGhostStore((s) => s.transfers)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length])

  if (!peerId || !peer) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-ghost-dim">
        <div className="hud-title">No channel selected</div>
        <div className="text-xs">Tap a trusted node on the globe or in the node list.</div>
      </div>
    )
  }

  const send = async (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setErr(null)
    try {
      await getMesh().sendMessage(peerId, text, defaultTtl)
      setDraft('')
    } catch (ex) {
      setErr((ex as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const sendFile = async (file: File) => {
    setBusy(true)
    setErr(null)
    try {
      const t = await getMesh().sendFile(peerId, file)
      upsertTransfer(t)
      await getMesh().sendMessage(peerId, `Sent encrypted file (${t.totalChunks} chunks, multi-path)`, defaultTtl, {
        name: file.name,
        size: file.size,
        transferId: t.id,
      })
    } catch (ex) {
      setErr((ex as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="hud-panel flex items-center gap-3 border-x-0 border-t-0 px-3 py-2">
        <button className="btn-hud lg:hidden" onClick={() => back(null)}>
          ←
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm neon-text-cyan">{peer.alias}</div>
          <div className="truncate text-[10px] text-ghost">
            {peer.id} · {peer.transport} · {peer.hops} hop · {peer.latencyMs}ms · rssi {peer.rssi.toFixed(0)}
          </div>
        </div>
        <div className="text-[10px] text-ok">🔒 AES-256-GCM · Ed25519</div>
      </div>

      {/* Messages */}
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto py-3">
        {messages.length === 0 && (
          <div className="px-4 text-center text-xs text-ghost-dim">
            Channel is empty. Messages are end-to-end encrypted and self-destruct after their TTL on both devices.
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} m={m} now={now} transfer={m.attachment ? transfers[m.attachment.transferId] : undefined} />
        ))}
      </div>

      {/* Composer */}
      <form onSubmit={(e) => void send(e)} className="hud-panel border-x-0 border-b-0 p-2">
        <div className="mb-2 flex flex-wrap items-center gap-1 text-[10px]">
          <span className="mr-1 text-ghost">TTL</span>
          {TTL_PRESETS.map((t) => (
            <button
              type="button"
              key={t.ms}
              className={`btn-hud !px-2 !py-0.5 ${defaultTtl === t.ms ? 'bg-cyan/15' : ''}`}
              onClick={() => setDefaultTtl(t.ms)}
            >
              {t.label}
            </button>
          ))}
          {err && <span className="ml-auto text-danger">{err}</span>}
        </div>
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void sendFile(f)
              e.target.value = ''
            }}
          />
          <button type="button" className="btn-hud purple" title="Send encrypted file" onClick={() => fileRef.current?.click()} disabled={busy}>
            ▣
          </button>
          <input
            className="hud-input flex-1"
            placeholder="transmit encrypted…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="btn-hud" disabled={busy || !draft.trim()}>
            {busy ? '…' : 'SEND'}
          </button>
        </div>
      </form>
    </div>
  )
}
