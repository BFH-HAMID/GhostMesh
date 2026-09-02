/// <reference lib="webworker" />
/**
 * E2EEWorker — dedicated Web Worker that owns ALL secret key material.
 *
 * The UI thread never sees private keys or AES session keys; it only sends
 * plaintext in and receives ciphertext out (and vice-versa). This isolates
 * secrets from XSS-style DOM compromise and keeps heavy crypto (RSA-4096,
 * chunk encryption) off the render thread.
 *
 * Protocol: request/response over postMessage, correlated by `reqId`.
 * See `E2EEClient.ts` for the typed main-thread wrapper.
 */
import {
  canonicalPacketBytes,
  decryptBytes,
  decryptString,
  deriveNodeId,
  deriveSessionKey,
  encryptBytes,
  encryptString,
  exportAesKey,
  generateAesKey,
  generateKeyBundle,
  importAesKey,
  sessionSalt,
  sha256,
  sign,
  verify,
  wipeKeyBundle,
  type NodeKeyBundle,
} from './E2EECore'
import { base64ToBytes, bytesToBase64, secureWipe } from './encoding'

/* ------------------------------------------------------------------------ */
/* Message protocol                                                          */
/* ------------------------------------------------------------------------ */

export type WorkerRequest =
  | { op: 'INIT'; alias: string; seed?: { sign: string; box: string } }
  | { op: 'EXPORT_IDENTITY' }
  | { op: 'ESTABLISH_SESSION'; peerId: string; peerBoxPublicKey: string }
  | { op: 'DROP_SESSION'; peerId: string }
  | { op: 'ENCRYPT_MESSAGE'; peerId: string; plaintext: string; aad?: string }
  | { op: 'DECRYPT_MESSAGE'; peerId: string; iv: string; ciphertext: string; aad?: string }
  | { op: 'SIGN_PACKET'; header: PacketHeader }
  | { op: 'VERIFY_PACKET'; header: PacketHeader; signature: string; signerPublicKey: string }
  | { op: 'CHUNK_FILE'; transferId: string; data: ArrayBuffer; chunkSize: number }
  | { op: 'ENCRYPT_CHUNK'; transferId: string; index: number; chunk: ArrayBuffer }
  | { op: 'DECRYPT_CHUNK'; transferId: string; index: number; iv: string; ciphertext: ArrayBuffer }
  | { op: 'IMPORT_FILE_KEY'; transferId: string; rawKey: string }
  | { op: 'EXPORT_FILE_KEY'; transferId: string }
  | { op: 'PURGE_TRANSFER'; transferId: string }
  | { op: 'SHA256'; data: ArrayBuffer }
  | { op: 'WIPE_ALL' }

export interface PacketHeader {
  id: string
  type: string
  from: string
  to: string
  timestamp: number
  iv: string
  payload: string
}

export type WorkerResponse =
  | { op: 'INIT'; nodeId: string; signPublicKey: string; boxPublicKey: string }
  | { op: 'EXPORT_IDENTITY'; nodeId: string; signPublicKey: string; boxPublicKey: string }
  | { op: 'ESTABLISH_SESSION'; peerId: string; ok: true }
  | { op: 'DROP_SESSION'; ok: true }
  | { op: 'ENCRYPT_MESSAGE'; iv: string; ciphertext: string }
  | { op: 'DECRYPT_MESSAGE'; plaintext: string }
  | { op: 'SIGN_PACKET'; signature: string }
  | { op: 'VERIFY_PACKET'; valid: boolean }
  | { op: 'CHUNK_FILE'; transferId: string; totalChunks: number; sha256: string }
  | { op: 'ENCRYPT_CHUNK'; index: number; iv: string; ciphertext: ArrayBuffer }
  | { op: 'DECRYPT_CHUNK'; index: number; plaintext: ArrayBuffer }
  | { op: 'IMPORT_FILE_KEY'; ok: true }
  | { op: 'EXPORT_FILE_KEY'; rawKey: string }
  | { op: 'PURGE_TRANSFER'; ok: true }
  | { op: 'SHA256'; hex: string }
  | { op: 'WIPE_ALL'; ok: true }

export type WorkerEnvelope<T> = { reqId: number } & T
export type WorkerError = { reqId: number; error: string }

/* ------------------------------------------------------------------------ */
/* Worker state (lives only inside this worker's heap)                       */
/* ------------------------------------------------------------------------ */

let keys: NodeKeyBundle | null = null
let nodeId = ''
const sessions = new Map<string, CryptoKey>()
const fileKeys = new Map<string, CryptoKey>()
/** Chunked plaintext held briefly while an outbound transfer is in flight. */
const outboundChunks = new Map<string, Uint8Array[]>()

const requireKeys = (): NodeKeyBundle => {
  if (!keys) throw new Error('E2EE worker not initialised')
  return keys
}

const requireSession = (peerId: string): CryptoKey => {
  const k = sessions.get(peerId)
  if (!k) throw new Error(`No session with ${peerId.slice(0, 6)}…`)
  return k
}

/* ------------------------------------------------------------------------ */
/* Handlers                                                                  */
/* ------------------------------------------------------------------------ */

async function handle(req: WorkerRequest): Promise<{ res: WorkerResponse; transfer?: Transferable[] }> {
  switch (req.op) {
    case 'INIT': {
      if (keys) wipeKeyBundle(keys)
      keys = generateKeyBundle()
      nodeId = await deriveNodeId(keys.sign.publicKey)
      return {
        res: {
          op: 'INIT',
          nodeId,
          signPublicKey: bytesToBase64(keys.sign.publicKey),
          boxPublicKey: bytesToBase64(keys.box.publicKey),
        },
      }
    }

    case 'EXPORT_IDENTITY': {
      const k = requireKeys()
      return {
        res: {
          op: 'EXPORT_IDENTITY',
          nodeId,
          signPublicKey: bytesToBase64(k.sign.publicKey),
          boxPublicKey: bytesToBase64(k.box.publicKey),
        },
      }
    }

    case 'ESTABLISH_SESSION': {
      const k = requireKeys()
      const peerPub = base64ToBytes(req.peerBoxPublicKey)
      const key = await deriveSessionKey(k.box.secretKey, peerPub, sessionSalt(nodeId, req.peerId))
      sessions.set(req.peerId, key)
      return { res: { op: 'ESTABLISH_SESSION', peerId: req.peerId, ok: true } }
    }

    case 'DROP_SESSION': {
      sessions.delete(req.peerId)
      return { res: { op: 'DROP_SESSION', ok: true } }
    }

    case 'ENCRYPT_MESSAGE': {
      const key = requireSession(req.peerId)
      const aad = req.aad ? base64ToBytes(req.aad) : undefined
      const env = await encryptString(key, req.plaintext, aad)
      return { res: { op: 'ENCRYPT_MESSAGE', ...env } }
    }

    case 'DECRYPT_MESSAGE': {
      const key = requireSession(req.peerId)
      const aad = req.aad ? base64ToBytes(req.aad) : undefined
      const plaintext = await decryptString(key, { iv: req.iv, ciphertext: req.ciphertext }, aad)
      return { res: { op: 'DECRYPT_MESSAGE', plaintext } }
    }

    case 'SIGN_PACKET': {
      const k = requireKeys()
      const sig = sign(canonicalPacketBytes(req.header), k.sign.secretKey)
      return { res: { op: 'SIGN_PACKET', signature: bytesToBase64(sig) } }
    }

    case 'VERIFY_PACKET': {
      const valid = verify(
        canonicalPacketBytes(req.header),
        base64ToBytes(req.signature),
        base64ToBytes(req.signerPublicKey),
      )
      return { res: { op: 'VERIFY_PACKET', valid } }
    }

    case 'CHUNK_FILE': {
      const data = new Uint8Array(req.data)
      const digest = await sha256(data)
      const chunks: Uint8Array[] = []
      for (let off = 0; off < data.length; off += req.chunkSize) {
        chunks.push(data.slice(off, off + req.chunkSize))
      }
      if (chunks.length === 0) chunks.push(new Uint8Array(0))
      outboundChunks.set(req.transferId, chunks)
      fileKeys.set(req.transferId, await generateAesKey(true))
      secureWipe(data)
      return {
        res: { op: 'CHUNK_FILE', transferId: req.transferId, totalChunks: chunks.length, sha256: bytesToBase64(digest) },
      }
    }

    case 'ENCRYPT_CHUNK': {
      const key = fileKeys.get(req.transferId)
      if (!key) throw new Error('Unknown transfer')
      const stored = outboundChunks.get(req.transferId)?.[req.index]
      const plain = stored ?? new Uint8Array(req.chunk)
      // AAD binds chunk to transfer+index so relays can't reorder/splice chunks
      const aad = new TextEncoder().encode(`${req.transferId}:${req.index}`)
      const { iv, ciphertext } = await encryptBytes(key, plain, aad)
      if (stored) {
        secureWipe(stored)
        const arr = outboundChunks.get(req.transferId)
        if (arr) arr[req.index] = new Uint8Array(0)
      }
      const buf = ciphertext.buffer as ArrayBuffer
      return { res: { op: 'ENCRYPT_CHUNK', index: req.index, iv: bytesToBase64(iv), ciphertext: buf }, transfer: [buf] }
    }

    case 'DECRYPT_CHUNK': {
      const key = fileKeys.get(req.transferId)
      if (!key) throw new Error('Unknown transfer (missing file key)')
      const aad = new TextEncoder().encode(`${req.transferId}:${req.index}`)
      const plain = await decryptBytes(key, base64ToBytes(req.iv), new Uint8Array(req.ciphertext), aad)
      const buf = plain.buffer as ArrayBuffer
      return { res: { op: 'DECRYPT_CHUNK', index: req.index, plaintext: buf }, transfer: [buf] }
    }

    case 'IMPORT_FILE_KEY': {
      fileKeys.set(req.transferId, await importAesKey(base64ToBytes(req.rawKey), true))
      return { res: { op: 'IMPORT_FILE_KEY', ok: true } }
    }

    case 'EXPORT_FILE_KEY': {
      const key = fileKeys.get(req.transferId)
      if (!key) throw new Error('Unknown transfer')
      const raw = await exportAesKey(key)
      const b64 = bytesToBase64(raw)
      secureWipe(raw)
      return { res: { op: 'EXPORT_FILE_KEY', rawKey: b64 } }
    }

    case 'PURGE_TRANSFER': {
      outboundChunks.get(req.transferId)?.forEach(secureWipe)
      outboundChunks.delete(req.transferId)
      fileKeys.delete(req.transferId)
      return { res: { op: 'PURGE_TRANSFER', ok: true } }
    }

    case 'SHA256': {
      const d = await sha256(new Uint8Array(req.data))
      return { res: { op: 'SHA256', hex: Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('') } }
    }

    case 'WIPE_ALL': {
      if (keys) wipeKeyBundle(keys)
      keys = null
      nodeId = ''
      sessions.clear()
      fileKeys.clear()
      for (const arr of outboundChunks.values()) arr.forEach(secureWipe)
      outboundChunks.clear()
      return { res: { op: 'WIPE_ALL', ok: true } }
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Worker entry                                                              */
/* ------------------------------------------------------------------------ */

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = async (ev: MessageEvent<WorkerEnvelope<WorkerRequest>>) => {
  const { reqId, ...req } = ev.data
  try {
    const { res, transfer } = await handle(req as WorkerRequest)
    ctx.postMessage({ reqId, ...res }, transfer ?? [])
  } catch (err) {
    const error: WorkerError = { reqId, error: err instanceof Error ? err.message : String(err) }
    ctx.postMessage(error)
  }
}
