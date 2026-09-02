/**
 * SecurityBot — AI-style heuristic threat monitor for the mesh.
 *
 * It inspects every inbound handshake and packet *before* MeshManager acts on
 * it, maintaining sliding-window counters per (redacted) source node. Rules:
 *
 *   • SIGNATURE_INVALID  — Ed25519 verification failed          -> drop + score
 *   • REPLAY             — packet id already seen in window     -> drop
 *   • BRUTE_FORCE        — >N failed handshakes in window        -> block source
 *   • UNKNOWN_NODE_FLOOD — >M packets/s from untrusted node      -> rate-limit
 *   • TAMPERED_PAYLOAD   — GCM auth tag failed on decrypt        -> drop + score
 *   • TTL_ABUSE          — ttl/hopCount outside protocol bounds  -> drop
 *   • KEY_MISMATCH       — known nodeId advertising new pubkey   -> block (MITM)
 *
 * Every event is published redacted (never full node ids or payload bytes)
 * and, for severity >= high, forwarded to the OS notification layer.
 */
import type { MeshPacket, Severity, ThreatEvent, ThreatKind, TransportKind } from '@/types'
import { fireSecurityNotification } from '@/native/Notifications'

export interface SecurityVerdict {
  allow: boolean
  event?: ThreatEvent
}

interface SourceStats {
  failedHandshakes: number[]
  packetTimes: number[]
  score: number
  blockedUntil: number
}

const WINDOW_MS = 30_000
const BRUTE_FORCE_THRESHOLD = 5
const FLOOD_PPS = 20
const BLOCK_MS = 5 * 60_000
const MAX_TTL = 16

export const redact = (id: string): string => (id.length <= 6 ? '****' : `${id.slice(0, 4)}…${id.slice(-2)}`)

const SEVERITY: Record<ThreatKind, Severity> = {
  SIGNATURE_INVALID: 'high',
  REPLAY: 'medium',
  BRUTE_FORCE: 'critical',
  UNKNOWN_NODE_FLOOD: 'high',
  TAMPERED_PAYLOAD: 'critical',
  TTL_ABUSE: 'low',
  KEY_MISMATCH: 'critical',
}

export class SecurityBot {
  private sources = new Map<string, SourceStats>()
  private seenIds = new Map<string, number>()
  private knownKeys = new Map<string, string>()
  private listeners = new Set<(e: ThreatEvent) => void>()
  private notify: boolean

  constructor(opts: { notify?: boolean } = {}) {
    this.notify = opts.notify ?? true
  }

  onThreat(cb: (e: ThreatEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  isBlocked(nodeId: string): boolean {
    const s = this.sources.get(nodeId)
    return !!s && s.blockedUntil > Date.now()
  }

  /** Remember the pubkey a node first presented; later mismatches = MITM alarm. */
  pinKey(nodeId: string, signPublicKey: string, transport: TransportKind): SecurityVerdict {
    const prev = this.knownKeys.get(nodeId)
    if (prev && prev !== signPublicKey) {
      return this.violation(nodeId, 'KEY_MISMATCH', transport, 'blocked', 'Node presented a different identity key')
    }
    this.knownKeys.set(nodeId, signPublicKey)
    return { allow: true }
  }

  /** Structural + rate checks that run before signature verification. */
  inspectInbound(packet: MeshPacket, viaPeer: string, transport: TransportKind, trusted: boolean): SecurityVerdict {
    const now = Date.now()
    this.gc(now)
    const src = packet.from
    if (this.isBlocked(src) || this.isBlocked(viaPeer)) {
      return { allow: false }
    }
    if (packet.ttl < 0 || packet.ttl > MAX_TTL || packet.hopCount > MAX_TTL || packet.path.length > MAX_TTL) {
      return this.violation(src, 'TTL_ABUSE', transport, 'dropped', `ttl=${packet.ttl} hops=${packet.hopCount}`)
    }
    if (this.seenIds.has(packet.id)) {
      return this.violation(src, 'REPLAY', transport, 'dropped', 'Duplicate packet id within replay window')
    }
    this.seenIds.set(packet.id, now)

    const stats = this.stats(src)
    stats.packetTimes.push(now)
    stats.packetTimes = stats.packetTimes.filter((t) => now - t < 1000)
    if (!trusted && stats.packetTimes.length > FLOOD_PPS) {
      stats.blockedUntil = now + 30_000
      return this.violation(src, 'UNKNOWN_NODE_FLOOD', transport, 'rate-limited', `${stats.packetTimes.length} pps from untrusted node`)
    }
    return { allow: true }
  }

  /** Called when signature verification fails. */
  signatureFailed(packet: MeshPacket, transport: TransportKind): SecurityVerdict {
    const now = Date.now()
    const stats = this.stats(packet.from)
    stats.score += 10
    if (packet.type === 'HANDSHAKE' || packet.type === 'HELLO') {
      stats.failedHandshakes.push(now)
      stats.failedHandshakes = stats.failedHandshakes.filter((t) => now - t < WINDOW_MS)
      if (stats.failedHandshakes.length >= BRUTE_FORCE_THRESHOLD) {
        stats.blockedUntil = now + BLOCK_MS
        return this.violation(
          packet.from,
          'BRUTE_FORCE',
          transport,
          'blocked',
          `${stats.failedHandshakes.length} forged handshakes in ${WINDOW_MS / 1000}s — source blocked ${BLOCK_MS / 60000}m`,
        )
      }
    }
    return this.violation(packet.from, 'SIGNATURE_INVALID', transport, 'dropped', `Ed25519 verify failed on ${packet.type}`)
  }

  /** Called when AES-GCM authentication tag fails (payload altered in transit). */
  payloadTampered(packet: MeshPacket, transport: TransportKind): SecurityVerdict {
    const stats = this.stats(packet.from)
    stats.score += 25
    if (stats.score >= 50) stats.blockedUntil = Date.now() + BLOCK_MS
    return this.violation(
      packet.from,
      'TAMPERED_PAYLOAD',
      transport,
      stats.score >= 50 ? 'blocked' : 'dropped',
      `GCM tag mismatch on ${packet.type} via ${packet.path.length} relay(s)`,
    )
  }

  reset(): void {
    this.sources.clear()
    this.seenIds.clear()
    this.knownKeys.clear()
  }

  /* ---------------------------------------------------------------------- */

  private stats(id: string): SourceStats {
    let s = this.sources.get(id)
    if (!s) {
      s = { failedHandshakes: [], packetTimes: [], score: 0, blockedUntil: 0 }
      this.sources.set(id, s)
    }
    return s
  }

  private gc(now: number) {
    if (this.seenIds.size < 2000) return
    for (const [id, t] of this.seenIds) if (now - t > WINDOW_MS) this.seenIds.delete(id)
  }

  private violation(
    source: string,
    kind: ThreatKind,
    transport: TransportKind,
    action: ThreatEvent['action'],
    message: string,
  ): SecurityVerdict {
    const event: ThreatEvent = {
      id: crypto.randomUUID(),
      kind,
      severity: SEVERITY[kind],
      sourceRedacted: redact(source),
      transport,
      message,
      timestamp: Date.now(),
      action,
    }
    this.listeners.forEach((cb) => cb(event))
    if (this.notify && (event.severity === 'high' || event.severity === 'critical')) {
      void fireSecurityNotification(`⚠ GhostMesh // ${kind.replace('_', ' ')}`, `${event.sourceRedacted} ${action} — ${message}`)
    }
    return { allow: false, event }
  }
}
