/**
 * useSelfDestruct — drives TTL countdowns for every message in view and
 * triggers a hard purge (memory + IndexedDB) the instant a TTL elapses.
 *
 * Returns a `now` tick (updated at 250 ms) so components can render live
 * countdown bars without each owning a timer.
 */
import { useEffect, useRef, useState } from 'react'
import { useGhostStore } from '@/store/useGhostStore'
import { burnMessage } from '@/services/MeshService'
import { VaultStorage } from '@/services/VaultStorage'

export function useSelfDestruct(tickMs = 250): number {
  const [now, setNow] = useState(() => Date.now())
  const burning = useRef(new Set<string>())

  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now()
      setNow(t)
      const { messages } = useGhostStore.getState()
      for (const m of messages) {
        if (m.expiresAt <= t && !burning.current.has(m.id)) {
          burning.current.add(m.id)
          void burnMessage(m.id).finally(() => burning.current.delete(m.id))
        }
      }
    }, tickMs)
    // Sweep persisted records that expired while the app was closed
    void VaultStorage.purgeExpired().catch(() => {})
    return () => clearInterval(id)
  }, [tickMs])

  return now
}

export const ttlProgress = (createdAt: number, expiresAt: number, now: number): number => {
  const total = expiresAt - createdAt
  if (total <= 0) return 0
  return Math.max(0, Math.min(1, (expiresAt - now) / total))
}

export const formatCountdown = (ms: number): string => {
  if (ms <= 0) return '00:00'
  const s = Math.ceil(ms / 1000)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
