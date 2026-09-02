import { useEffect } from 'react'
import { useGhostStore } from '@/store/useGhostStore'
import { useTheme } from '@/hooks/useTheme'
import { useAppLifecycle } from '@/hooks/useAppLifecycle'
import { useSelfDestruct } from '@/hooks/useSelfDestruct'
import LockScreen from '@/components/LockScreen'
import HudShell from '@/components/HudShell'

export default function App() {
  const phase = useGhostStore((s) => s.phase)
  useTheme()
  useAppLifecycle()
  // Global TTL sweeper — runs even while locked so nothing outlives its TTL.
  useSelfDestruct(500)

  useEffect(() => {
    document.title = phase === 'locked' ? 'GhostMesh' : `GhostMesh // ${phase}`
  }, [phase])

  if (phase === 'locked' || phase === 'booting') return <LockScreen />
  return <HudShell />
}
