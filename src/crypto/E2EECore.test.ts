import { describe, expect, it } from 'vitest'
import {
  canonicalPacketBytes,
  decryptString,
  deriveNodeId,
  deriveSessionKey,
  encryptString,
  generateKeyBundle,
  sessionSalt,
  sign,
  verify,
} from './E2EECore'
import { base64ToBytes, bytesToBase64, utf8ToBytes } from './encoding'

describe('E2EECore', () => {
  it('derives a stable 32-hex node id from the signing key', async () => {
    const kb = generateKeyBundle()
    const a = await deriveNodeId(kb.sign.publicKey)
    const b = await deriveNodeId(kb.sign.publicKey)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })

  it('both peers derive the same AES-256-GCM session key and can round-trip', async () => {
    const alice = generateKeyBundle()
    const bob = generateKeyBundle()
    const aId = await deriveNodeId(alice.sign.publicKey)
    const bId = await deriveNodeId(bob.sign.publicKey)
    const salt = sessionSalt(aId, bId)
    const kA = await deriveSessionKey(alice.box.secretKey, bob.box.publicKey, salt)
    const kB = await deriveSessionKey(bob.box.secretKey, alice.box.publicKey, salt)

    const aad = utf8ToBytes('pkt-1')
    const env = await encryptString(kA, 'ghost in the mesh 👻', aad)
    expect(await decryptString(kB, env, aad)).toBe('ghost in the mesh 👻')
  })

  it('rejects tampered ciphertext (GCM tag) and wrong AAD', async () => {
    const a = generateKeyBundle()
    const b = generateKeyBundle()
    const k = await deriveSessionKey(a.box.secretKey, b.box.publicKey, sessionSalt('x', 'y'))
    const env = await encryptString(k, 'secret', utf8ToBytes('id-1'))

    const ct = base64ToBytes(env.ciphertext)
    ct[0] = (ct[0] ?? 0) ^ 0xff
    await expect(decryptString(k, { ...env, ciphertext: bytesToBase64(ct) }, utf8ToBytes('id-1'))).rejects.toThrow()
    await expect(decryptString(k, env, utf8ToBytes('id-2'))).rejects.toThrow()
  })

  it('signs and verifies canonical packet bytes; relays may mutate ttl/hops', () => {
    const kb = generateKeyBundle()
    const header = { id: 'p1', type: 'MSG', from: 'a', to: 'b', timestamp: 1, iv: 'iv', payload: 'ct' }
    const sig = sign(canonicalPacketBytes(header), kb.sign.secretKey)
    expect(verify(canonicalPacketBytes(header), sig, kb.sign.publicKey)).toBe(true)
    expect(verify(canonicalPacketBytes({ ...header, payload: 'ct2' }), sig, kb.sign.publicKey)).toBe(false)
    const other = generateKeyBundle()
    expect(verify(canonicalPacketBytes(header), sig, other.sign.publicKey)).toBe(false)
  })
})
