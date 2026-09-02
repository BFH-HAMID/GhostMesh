/** Binary <-> text encoding helpers (no Node Buffer; works in browser, worker, Android WebView). */

const te = new TextEncoder()
const td = new TextDecoder()

export const utf8ToBytes = (s: string): Uint8Array => te.encode(s)
export const bytesToUtf8 = (b: Uint8Array): string => td.decode(b)

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(len)
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

/** Constant-time byte comparison. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

/** Overwrite a buffer with zeros, then random bytes, then zeros (best-effort memory purge). */
export function secureWipe(bytes: Uint8Array | undefined | null): void {
  if (!bytes) return
  bytes.fill(0)
  crypto.getRandomValues(bytes)
  bytes.fill(0)
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

export function randomId(bytes = 12): string {
  return bytesToHex(randomBytes(bytes))
}

/** Web Crypto typings want a BufferSource backed by ArrayBuffer; normalise Uint8Array views. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
