/**
 * Re-locks the UI when the app goes to background (Capacitor App plugin or
 * Page Visibility API) — a second biometric check is required on resume.
 */
import { useEffect } from 'react'
import { useGhostStore } from '@/store/useGhostStore'
import { isNative } from '@/native/platform'

export function useAppLifecycle(lockAfterMs = 30_000) {
  const setPhase = useGhostStore((s) => s.setPhase)
  useEffect(() => {
    let hiddenAt = 0
    const onHidden = () => {
      hiddenAt = Date.now()
    }
    const onVisible = () => {
      const s = useGhostStore.getState()
      if (hiddenAt && Date.now() - hiddenAt > lockAfterMs && s.phase !== 'locked') setPhase('locked')
      hiddenAt = 0
    }
    const onVis = () => (document.hidden ? onHidden() : onVisible())
    document.addEventListener('visibilitychange', onVis)

    let remove: (() => void) | undefined
    if (isNative()) {
      void import('@capacitor/app').then(async ({ App }) => {
        const h = await App.addListener('appStateChange', ({ isActive }) => (isActive ? onVisible() : onHidden()))
        remove = () => void h.remove()
      })
    }
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      remove?.()
    }
  }, [lockAfterMs, setPhase])
}
