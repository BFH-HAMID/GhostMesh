/**
 * GhostMesh shared domain types.
 * Every module (crypto, mesh, services, UI) speaks in these shapes.
 */

/** Hex-encoded truncated SHA-256 of a node's Ed25519 public key. */
export type NodeId = string

/** 'local' = real BroadcastChannel link between tabs of the same browser. 'simulated' = fake demo swarm. */
export type TransportKind = 'internet' | 'wifi-direct' | 'ble' | 'local' | 'simulated'

export type NodeStatus = 'discovered' | 'handshaking' | 'trusted' | 'blocked'

export interface GeoCoord {
  lat: number
  lon: number
}

export interface MeshNode {
  id: NodeId
  alias: string
  /** Base64 Ed25519 signing public key */
  signPublicKey: string
  /** Base64 X25519 key-agreement public key */
  boxPublicKey: string
  transport: TransportKind
  status: NodeStatus
  coord: GeoCoord
  /** Received signal strength (dBm) for radio links, or -1 for internet */
  rssi: number
  /** Round-trip latency in ms */
  latencyMs: number
  /** Number of hops from local node (0 = self, 1 = direct) */
  hops: number
  firstSeen: number
  lastSeen: number
  isSelf?: boolean
}

export type PacketType =
  | 'HELLO'
  | 'HANDSHAKE'
  | 'HANDSHAKE_ACK'
  | 'MSG'
  | 'ACK'
  | 'CHUNK'
  | 'CHUNK_ACK'
  | 'PING'
  | 'PONG'
  | 'ROUTE_ADV'

/**
 * A routable envelope. Payload is always ciphertext (except HELLO / ROUTE_ADV
 * which are signed-only public broadcasts).
 */
export interface MeshPacket {
  id: string
  type: PacketType
  from: NodeId
  to: NodeId | '*'
  /** Max hops remaining before the packet is dropped */
  ttl: number
  hopCount: number
  /** Ordered list of relays this packet traversed */
  path: NodeId[]
  timestamp: number
  /** Base64 nonce/IV used for AES-GCM */
  iv: string
  /** Base64 ciphertext (or plaintext JSON for HELLO/ROUTE_ADV) */
  payload: string
  /** Base64 Ed25519 signature over the canonical header + payload */
  signature: string
}

export interface ChatMessage {
  id: string
  conversationId: NodeId
  from: NodeId
  to: NodeId
  body: string
  createdAt: number
  /** Absolute epoch-ms at which the payload must be purged. */
  expiresAt: number
  ttlMs: number
  direction: 'in' | 'out'
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'burned' | 'failed'
  hops?: number
  attachment?: { name: string; size: number; transferId: string }
}

export type ThreatKind =
  | 'BRUTE_FORCE'
  | 'SIGNATURE_INVALID'
  | 'REPLAY'
  | 'TAMPERED_PAYLOAD'
  | 'TTL_ABUSE'
  | 'UNKNOWN_NODE_FLOOD'
  | 'KEY_MISMATCH'

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical'

export interface ThreatEvent {
  id: string
  kind: ThreatKind
  severity: Severity
  /** Redacted node identifier (first 4 + last 2 chars) */
  sourceRedacted: string
  transport: TransportKind
  message: string
  timestamp: number
  /** Action automatically taken by the security bot */
  action: 'logged' | 'rate-limited' | 'blocked' | 'dropped'
}

export interface NetworkSample {
  t: number
  /** Bytes per second in */
  rxBps: number
  /** Bytes per second out */
  txBps: number
  /** 0..1 */
  packetLoss: number
  latencyMs: number
  avgHops: number
  activeNodes: number
}

export interface FileTransfer {
  id: string
  name: string
  size: number
  mime: string
  totalChunks: number
  chunksDone: number
  direction: 'in' | 'out'
  peer: NodeId
  status: 'chunking' | 'routing' | 'reassembling' | 'complete' | 'failed'
  /** Which relay node each chunk index took */
  chunkRoutes: Record<number, NodeId>
  /** Object URL for a fully received and hash-verified file (receiver side). */
  blobUrl?: string
  /** base64 SHA-256 of the whole plaintext file for verification */
  sha256: string
  startedAt: number
}

export type ThemeMode = 'amoled' | 'neon-hud'

export interface Identity {
  nodeId: NodeId
  alias: string
  signPublicKey: string
  boxPublicKey: string
  createdAt: number
}
