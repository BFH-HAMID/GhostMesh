/**
 * LockScreen — biometric gate. Native: fingerprint / face via Capacitor.
 * Web: passphrase fallback (never stored; only compared against a salted hash
 * kept in sessionStorage for the current tab).
 */
import { useEffect, useState, type FormEvent } from 'react'
import { authenticateBiometric, biometricAvailable } from '@/native/Biometric'
import { useGhostStore } from '@/store/useGhostStore'
import { bootMesh } from '@/services/MeshService'
import { sha256 } from '@/crypto/E2EECore'
import { bytesToHex, utf8ToBytes } from '@/crypto/encoding'

const ALIAS_KEY = 'gm.alias'
const PASS_HASH_KEY = 'gm.passhash'

export default function LockScreen() {
  const [bio, setBio] = useState<boolean | null>(null)
  const [alias, setAlias] = useState(() => localStorage.getItem(ALIAS_KEY) ?? `ghost-${Math.random().toString(16).slice(2, 6)}`)
  const [pass, setPass] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const identity = useGhostStore((s) => s.identity)
  const setPhase = useGhostStore((s) => s.setPhase)

  useEffect(() => {
    void biometricAvailable().then(setBio)
  }, [])

  const unlock = async () => {
    setBusy(true)
    setErr(null)
    try {
      localStorage.setItem(ALIAS_KEY, alias)
      if (identity) {
        setPhase('online') // re-lock case: mesh still running
      } else {
        await bootMesh(alias)
      }
    } catch (e) {
      setErr((e as Error).message)
      setPhase('locked')
    } finally {
      setBusy(false)
    }
  }

  const onBiometric = async () => {
    setBusy(true)
    const r = await authenticateBiometric()
    setBusy(false)
    if (r.ok) await unlock()
    else setErr(`Biometric failed: ${r.reason}`)
  }

  const onPass = async (e: FormEvent) => {
    e.preventDefault()
    if (pass.length < 6) return setErr('Passphrase must be at least 6 characters')
    const h = bytesToHex(await sha256(utf8ToBytes(`ghostmesh|${pass}`)))
    const stored = sessionStorage.getItem(PASS_HASH_KEY)
    if (stored && stored !== h) return setErr('Passphrase mismatch')
    if (!stored) sessionStorage.setItem(PASS_HASH_KEY, h)
    setPass('')
    await unlock()
  }

  return (
    <div className="grid-bg flex h-full items-center justify-center p-4">
      <div className="hud-panel w-full max-w-sm p-6">
        <div className="mb-6 text-center">
          <div className="font-display text-2xl tracking-[0.4em] neon-text-cyan animate-flicker">GHOSTMESH</div>
          <div className="mt-1 text-[10px] tracking-widest text-ghost">DECENTRALIZED · STEALTH · E2EE</div>
        </div>

        <label className="mb-1 block hud-title">Callsign</label>
        <input className="hud-input mb-4" value={alias} onChange={(e) => setAlias(e.target.value.slice(0, 24))} disabled={!!identity} />

        {bio ? (
          <button className="btn-hud w-full py-3" onClick={() => void onBiometric()} disabled={busy}>
            {busy ? 'VERIFYING…' : '⬡ UNLOCK WITH BIOMETRICS'}
          </button>
        ) : (
          <form onSubmit={(e) => void onPass(e)}>
            <label className="mb-1 block hud-title">Passphrase {bio === false && <span className="text-ghost-dim">(web fallback)</span>}</label>
            <input
              className="hud-input mb-3"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="••••••••"
              autoFocus
            />
            <button type="submit" className="btn-hud w-full py-3" disabled={busy}>
              {busy ? 'BOOTING MESH…' : identity ? 'RE-AUTHENTICATE' : 'GENERATE KEYS & ENTER'}
            </button>
          </form>
        )}

        {err && <div className="mt-3 text-[11px] text-danger">{err}</div>}

        <div className="mt-6 space-y-1 text-[10px] leading-relaxed text-ghost-dim">
          <div>• Ed25519 identity + X25519 → HKDF → AES-256-GCM sessions</div>
          <div>• Keys live in an isolated Web Worker, wiped on lock</div>
          <div>• Messages self-destruct on every device after TTL</div>
        </div>
      </div>
    </div>
  )
}
