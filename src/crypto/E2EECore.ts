/**
 * E2EECore — the cryptographic primitives behind GhostMesh.
 *
 *  - Identity:      Ed25519 signing keypair (tweetnacl) — node identity & packet auth
 *  - Key exchange:  X25519 (tweetnacl box keys) -> HKDF-SHA256 (Web Crypto) -> AES-256-GCM key
 *  - Payloads:      AES-256-GCM (Web Crypto, hardware-accelerated on Android WebView)
 *  - Optional:      RSA-4096-OAEP wrapping (Web Crypto) for legacy peers / key escrow-free backup
 *
 * All secret material is kept as Uint8Array so it can be explicitly wiped.
 * Nothing in this file touches the DOM — it runs identically in a Web Worker.
 */
import nacl from 'tweetnacl'
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  randomBytes,
  secureWipe,
  toArrayBuffer,
  utf8ToBytes,
} from './encoding'

export interface SigningKeyPair {
  publicKey: Uint8Array // 32 bytes
  secretKey: Uint8Array // 64 bytes
}

export interface BoxKeyPair {
  publicKey: Uint8Array // 32 bytes
  secretKey: Uint8Array // 32 bytes
}

export interface NodeKeyBundle {
  sign: SigningKeyPair
  box: BoxKeyPair
}

export interface EncryptedEnvelope {
  /** base64 96-bit IV */
  iv: string
  /** base64 ciphertext || 128-bit GCM tag */
  ciphertext: string
}

const AES_ALG = 'AES-GCM'
const AES_BITS = 256
const IV_BYTES = 12
const HKDF_INFO = utf8ToBytes('ghostmesh/v1/session')

/* ------------------------------------------------------------------------ */
/* Identity                                                                  */
/* ------------------------------------------------------------------------ */

export function generateKeyBundle(): NodeKeyBundle {
  const sign = nacl.sign.keyPair()
  const box = nacl.box.keyPair()
  return {
    sign: { publicKey: sign.publicKey, secretKey: sign.secretKey },
    box: { publicKey: box.publicKey, secretKey: box.secretKey },
  }
}

export function wipeKeyBundle(bundle: NodeKeyBundle): void {
  secureWipe(bundle.sign.secretKey)
  secureWipe(bundle.box.secretKey)
}

/** Node ID = first 16 bytes (hex) of SHA-256(signPublicKey). */
export async function deriveNodeId(signPublicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(signPublicKey)))
  return bytesToHex(digest.subarray(0, 16))
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(data)))
}

/* ------------------------------------------------------------------------ */
/* Signatures (Ed25519)                                                      */
/* ------------------------------------------------------------------------ */

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, secretKey)
}

export function verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return nacl.sign.detached.verify(message, signature, publicKey)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------------ */
/* Key agreement: X25519 -> HKDF -> AES-256-GCM CryptoKey                    */
/* ------------------------------------------------------------------------ */

/**
 * Derive a symmetric session key with a remote peer. Both sides compute the
 * same key. `salt` should be the two node IDs sorted & concatenated so that the
 * derivation is symmetric and session-bound.
 */
export async function deriveSessionKey(
  myBoxSecret: Uint8Array,
  theirBoxPublic: Uint8Array,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const shared = nacl.scalarMult(myBoxSecret, theirBoxPublic) // 32-byte X25519 shared secret
  try {
    const ikm = await crypto.subtle.importKey('raw', toArrayBuffer(shared), 'HKDF', false, ['deriveKey'])
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(salt), info: toArrayBuffer(HKDF_INFO) },
      ikm,
      { name: AES_ALG, length: AES_BITS },
      false, // non-extractable: key never leaves the crypto subsystem
      ['encrypt', 'decrypt'],
    )
  } finally {
    secureWipe(shared)
  }
}

export function sessionSalt(nodeA: string, nodeB: string): Uint8Array {
  const [x, y] = [nodeA, nodeB].sort()
  return utf8ToBytes(`${x}|${y}`)
}

/** Fresh random AES-256-GCM key (used per-file for chunked transfers). */
export async function generateAesKey(extractable = true): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: AES_ALG, length: AES_BITS }, extractable, ['encrypt', 'decrypt'])
}

export async function exportAesKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key))
}

export async function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(raw), AES_ALG, extractable, ['encrypt', 'decrypt'])
}

/* ------------------------------------------------------------------------ */
/* AES-256-GCM                                                               */
/* ------------------------------------------------------------------------ */

export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = randomBytes(IV_BYTES)
  const params: AesGcmParams = { name: AES_ALG, iv: toArrayBuffer(iv), tagLength: 128 }
  if (aad) params.additionalData = toArrayBuffer(aad)
  const ct = await crypto.subtle.encrypt(params, key, toArrayBuffer(plaintext))
  return { iv, ciphertext: new Uint8Array(ct) }
}

export async function decryptBytes(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const params: AesGcmParams = { name: AES_ALG, iv: toArrayBuffer(iv), tagLength: 128 }
  if (aad) params.additionalData = toArrayBuffer(aad)
  const pt = await crypto.subtle.decrypt(params, key, toArrayBuffer(ciphertext))
  return new Uint8Array(pt)
}

export async function encryptString(key: CryptoKey, text: string, aad?: Uint8Array): Promise<EncryptedEnvelope> {
  const pt = utf8ToBytes(text)
  try {
    const { iv, ciphertext } = await encryptBytes(key, pt, aad)
    return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) }
  } finally {
    secureWipe(pt)
  }
}

export async function decryptString(key: CryptoKey, env: EncryptedEnvelope, aad?: Uint8Array): Promise<string> {
  const pt = await decryptBytes(key, base64ToBytes(env.iv), base64ToBytes(env.ciphertext), aad)
  try {
    return bytesToUtf8(pt)
  } finally {
    secureWipe(pt)
  }
}

/* ------------------------------------------------------------------------ */
/* RSA-4096-OAEP (optional wrapping layer)                                   */
/* ------------------------------------------------------------------------ */

export async function generateRsa4096(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 4096,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['wrapKey', 'unwrapKey'],
  )
}

export async function rsaWrapAesKey(aesKey: CryptoKey, rsaPublic: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.wrapKey('raw', aesKey, rsaPublic, { name: 'RSA-OAEP' }))
}

export async function rsaUnwrapAesKey(wrapped: Uint8Array, rsaPrivate: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw',
    toArrayBuffer(wrapped),
    rsaPrivate,
    { name: 'RSA-OAEP' },
    { name: AES_ALG, length: AES_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

/* ------------------------------------------------------------------------ */
/* Canonical packet signing helpers                                          */
/* ------------------------------------------------------------------------ */

/**
 * Canonical bytes that get signed for a packet. Mutable routing fields
 * (ttl, hopCount, path) are intentionally excluded so relays can forward
 * without invalidating the origin signature. Everything else is covered.
 */
export function canonicalPacketBytes(p: {
  id: string
  type: string
  from: string
  to: string
  timestamp: number
  iv: string
  payload: string
}): Uint8Array {
  return concatBytes(
    utf8ToBytes(`${p.id}\u0000${p.type}\u0000${p.from}\u0000${p.to}\u0000${p.timestamp}\u0000${p.iv}\u0000`),
    utf8ToBytes(p.payload),
  )
}
