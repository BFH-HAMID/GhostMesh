import { describe, expect, it, vi } from 'vitest'
import { MeshManager, type CryptoProvider } from './MeshManager'
import { SimulatedTransport } from './transports/SimulatedTransport'
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
  type NodeKeyBundle,
} from '@/crypto/E2EECore'
import { base64ToBytes, bytesToBase64 } from '@/crypto/encoding'

/** In-process crypto provider (no Worker in node) built on the same primitives. */
function inProcessCrypto(): CryptoProvider {
  let kb: NodeKeyBundle | null = null
  let nodeId = ''
  const sessions = new Map<string, CryptoKey>()
  return {
    async init() {
      kb = generateKeyBundle()
      nodeId = await deriveNodeId(kb.sign.publicKey)
      return { nodeId, signPublicKey: bytesToBase64(kb.sign.publicKey), boxPublicKey: bytesToBase64(kb.box.publicKey) }
    },
    async establishSession(peerId, pub) {
      sessions.set(peerId, await deriveSessionKey(kb!.box.secretKey, base64ToBytes(pub), sessionSalt(nodeId, peerId)))
    },
    async dropSession(peerId) {
      sessions.delete(peerId)
    },
    async encryptMessage(peerId, pt, aad) {
      return encryptString(sessions.get(peerId)!, pt, aad ? base64ToBytes(aad) : undefined)
    },
    async decryptMessage(peerId, iv, ciphertext, aad) {
      return { plaintext: await decryptString(sessions.get(peerId)!, { iv, ciphertext }, aad ? base64ToBytes(aad) : undefined) }
    },
    async signPacket(h) {
      return { signature: bytesToBase64(sign(canonicalPacketBytes(h), kb!.sign.secretKey)) }
    },
    async verifyPacket(h, sig, pub) {
      return { valid: verify(canonicalPacketBytes(h), base64ToBytes(sig), base64ToBytes(pub)) }
    },
    async chunkFile(_id, data, size = 1024) {
      return { totalChunks: Math.max(1, Math.ceil(data.byteLength / size)), sha256: 'x' }
    },
    async encryptChunk(_id, index) {
      return { index, iv: 'iv', ciphertext: new ArrayBuffer(8) }
    },
    async exportFileKey() {
      return { rawKey: 'k' }
    },
    async purgeTransfer() {},
    async wipeAll() {
      sessions.clear()
      kb = null
    },
  }
}

describe('MeshManager + SimulatedTransport', () => {
  it('boots, discovers peers, completes signed handshakes and routes an E2EE message', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const sim = new SimulatedTransport({ initialPeers: 3, maxPeers: 3, churnMs: 60_000 })
    const mesh = new MeshManager(inProcessCrypto(), { transports: [sim], notify: false })
    const threats: string[] = []
    mesh.on('threat', (t) => threats.push(t.kind))

    const self = await mesh.start('tester', { lat: 0, lon: 0 })
    expect(self.id).toMatch(/^[0-9a-f]{32}$/)
    // Let handshake ACKs (real timers) flow
    await new Promise((r) => setTimeout(r, 400))

    const peers = [...mesh.nodes.values()].filter((n) => !n.isSelf)
    expect(peers.length).toBe(3)
    expect(peers.every((p) => p.status === 'trusted')).toBe(true)

    // Outbound message must be ciphertext on the wire
    let wire: string | undefined
    sim.onOutbound = (_to, p) => {
      if (p.type === 'MSG') wire = p.payload
    }
    const target = peers[0]!
    const msg = await mesh.sendMessage(target.id, 'burn after reading', 5000)
    expect(msg.status).toBe('sent')
    expect(wire).toBeDefined()
    expect(wire).not.toContain('burn after reading')

    // Forged handshake must be caught by the security bot
    sim.injectHostile('forged')
    await new Promise((r) => setTimeout(r, 50))
    expect(threats).toContain('SIGNATURE_INVALID')

    await mesh.stop()
    vi.useRealTimers()
  })
})
