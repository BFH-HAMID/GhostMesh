import { useEffect } from 'react'
import { useGhostStore } from '@/store/useGhostStore'

/** Applies the theme attribute on mount and whenever it changes. */
export function useTheme() {
  const theme = useGhostStore((s) => s.theme)
  const setTheme = useGhostStore((s) => s.setTheme)
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme
    document.documentElement.classList.toggle('scanlines', theme === 'neon-hud')
  }, [theme])
  return { theme, toggle: () => setTheme(theme === 'amoled' ? 'neon-hud' : 'amoled') }
}
