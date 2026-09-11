/**
 * ErrorBoundary — last line of defense against a blank/black screen.
 *
 * React 19 unmounts the entire tree when a render error is not caught by a
 * boundary, which in production looks like a silent black screen (no console
 * surfaced to the user). This boundary converts any such crash into a visible
 * HUD panel with the error message and a reload button.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[GhostMesh] unrecoverable render error', error, info.componentStack)
  }

  override render() {
    if (this.state.error) {
      const msg = this.state.error.message || String(this.state.error)
      return (
        <div className="grid-bg flex h-full items-center justify-center p-4">
          <div className="hud-panel w-full max-w-md p-6">
            <div className="text-center">
              <div className="font-display text-2xl tracking-[0.4em] text-danger animate-flicker">SIGNAL LOST</div>
              <div className="mt-1 text-[10px] tracking-widest text-ghost">UNRECOVERABLE UI ERROR</div>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-ghost">
              The interface crashed while rendering. Reload to return to the lock screen — no
              message content is stored outside the encrypted vault.
            </p>
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap border p-2 text-[10px] leading-relaxed text-danger/80">
              {msg}
            </pre>
            <button className="btn-hud mt-4 w-full py-3" onClick={() => window.location.reload()}>
              REBOOT INTERFACE
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
