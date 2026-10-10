import { describe, expect, it, vi } from 'vitest'
import { MeshManager, type CryptoProvider } from './MeshManager'
import { SimulatedTransport } from './transports/SimulatedTransport'
import { LocalTransport } from './transports/LocalTransport'
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
  type NodeKeyBundle,
} from '@/crypto/E2EECore'
import { base64ToBytes, bytesToBase64, utf8ToBytes } from '@/crypto/encoding'
import type { ChatMessage, FileTransfer } from '@/types'

/** In-process crypto provider built on the same primitives as the worker (no Worker in node). */
function inProcessCrypto(): CryptoProvider {
  let kb: NodeKeyBundle | null = null
  let nodeId = ''
  const sessions = new Map<string, CryptoKey>()
  const fileKeys = new Map<string, CryptoKey>()
  const chunks = new Map<string, Uint8Array[]>()
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
    async chunkFile(id, data, size = 1024) {
      const d = new Uint8Array(data)
      const parts: Uint8Array[] = []
      for (let off = 0; off < d.length; off += size) parts.push(d.slice(off, off + size))
      if (parts.length === 0) parts.push(new Uint8Array(0))
      chunks.set(id, parts)
      fileKeys.set(id, await generateAesKey(true))
      return { totalChunks: parts.length, sha256: bytesToBase64(await sha256(d)) }
    },
    async encryptChunk(id, index) {
      const plain = chunks.get(id)![index]!
      const { iv, ciphertext } = await encryptBytes(fileKeys.get(id)!, plain, utf8ToBytes(`${id}:${index}`))
      return { index, iv: bytesToBase64(iv), ciphertext: ciphertext.buffer as ArrayBuffer }
    },
    async decryptChunk(id, index, iv, ct) {
      const pt = await decryptBytes(fileKeys.get(id)!, base64ToBytes(iv), new Uint8Array(ct), utf8ToBytes(`${id}:${index}`))
      return { index, plaintext: pt.buffer as ArrayBuffer }
    },
    async exportFileKey(id) {
      return { rawKey: bytesToBase64(await exportAesKey(fileKeys.get(id)!)) }
    },
    async importFileKey(id, raw) {
      fileKeys.set(id, await importAesKey(base64ToBytes(raw), true))
    },
    async purgeTransfer(id) {
      chunks.delete(id)
      fileKeys.delete(id)
    },
    async wipeAll() {
      sessions.clear()
      fileKeys.clear()
      chunks.clear()
      kb = null
    },
  }
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('MeshManager + SimulatedTransport (demo swarm)', () => {
  it('boots, discovers peers, completes signed handshakes and routes an E2EE message', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const sim = new SimulatedTransport({ initialPeers: 3, maxPeers: 3, churnMs: 60_000 })
    const mesh = new MeshManager(inProcessCrypto(), { transports: [sim], notify: false })
    const threats: string[] = []
    mesh.on('threat', (t) => threats.push(t.kind))

    const self = await mesh.start('tester', { lat: 0, lon: 0 })
    expect(self.id).toMatch(/^[0-9a-f]{32}$/)
    await new Promise((r) => setTimeout(r, 400))

    const peers = [...mesh.nodes.values()].filter((n) => !n.isSelf)
    expect(peers.length).toBe(3)
    expect(peers.every((p) => p.status === 'trusted')).toBe(true)
    expect(peers.every((p) => p.transport === 'simulated')).toBe(true)

    let wire: string | undefined
    sim.onOutbound = (_to, p) => {
      if (p.type === 'MSG') wire = p.payload
    }
    const target = peers[0]!
    const msg = await mesh.sendMessage(target.id, 'burn after reading', 5000)
    expect(msg.status).toBe('sent')
    expect(wire).toBeDefined()
    expect(wire).not.toContain('burn after reading')

    sim.injectHostile('forged')
    await new Promise((r) => setTimeout(r, 50))
    expect(threats).toContain('SIGNATURE_INVALID')

    await mesh.stop()
    vi.useRealTimers()
  })
})

describe('MeshManager + LocalTransport (real tab-to-tab link)', () => {
  it('two nodes discover each other, exchange an encrypted chat and a 100 KB file', async () => {
    const alice = new MeshManager(inProcessCrypto(), { transports: [new LocalTransport()], notify: false })
    const bob = new MeshManager(inProcessCrypto(), { transports: [new LocalTransport()], notify: false })

    const received: ChatMessage[] = []
    bob.on('message', (m) => received.push(m))
    const files: FileTransfer[] = []
    bob.on('transfer', (t) => files.push({ ...t }))

    await alice.start('alice', { lat: 23.81, lon: 90.41 })
    await bob.start('bob', { lat: 22.36, lon: 91.78 })
    const bobId = bob.self!.id
    const aliceId = alice.self!.id

    await waitFor(() => alice.nodes.get(bobId)?.status === 'trusted' && bob.nodes.get(aliceId)?.status === 'trusted')
    expect(alice.nodes.get(bobId)?.transport).toBe('local')

    // Chat: plaintext never on the wire, delivered and ACKed.
    const sent = await alice.sendMessage(bobId, 'hello over the mesh', 60_000)
    expect(sent.body).toBe('hello over the mesh')
    await waitFor(() => received.length === 1)
    expect(received[0]!.body).toBe('hello over the mesh')
    expect(received[0]!.from).toBe(aliceId)

    // File: 100 KB => 4 chunks of 32 KiB, reassembled and hash-verified on the receiver.
    const bytes = new Uint8Array(100_000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff
    let captured: Blob | null = null
    const spy = vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
      captured = b as Blob
      return 'blob:test-file'
    })
    try {
      const file = { name: 'secret.bin', size: bytes.length, type: 'application/octet-stream', arrayBuffer: async () => bytes.slice().buffer }
      const out = await alice.sendFile(bobId, file)
      expect(out.status).toBe('complete')
      await waitFor(() => files.some((t) => t.status === 'complete'))
      const done = files.find((t) => t.status === 'complete')!
      expect(done.name).toBe('secret.bin')
      expect(done.blobUrl).toBe('blob:test-file')
      expect(captured).not.toBeNull()
      const got = new Uint8Array(await captured!.arrayBuffer())
      expect(got.length).toBe(bytes.length)
      expect(got.every((b, i) => b === bytes[i])).toBe(true)
    } finally {
      spy.mockRestore()
    }

    await alice.stop()
    await bob.stop()
  }, 20_000)
})
