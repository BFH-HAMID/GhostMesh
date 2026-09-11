/**
 * E2EEClient — typed, promise-based main-thread facade over E2EEWorker.
 *
 * Usage:
 *   const e2ee = getE2EE()
 *   const id = await e2ee.init('ghost-7f')
 *   await e2ee.establishSession(peerId, peerBoxPub)
 *   const { iv, ciphertext } = await e2ee.encryptMessage(peerId, 'hello')
 */
import type { PacketHeader, WorkerError, WorkerRequest, WorkerResponse } from './E2EEWorker'

type Pending = { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void }

type ResponseFor<Op extends WorkerResponse['op']> = Extract<WorkerResponse, { op: Op }>

export class E2EEClient {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, Pending>()
  /** Set once the worker script fails to load/start; all calls reject from then on. */
  private failed: Error | null = null

  constructor() {
    this.worker = new Worker(new URL('./E2EEWorker.ts', import.meta.url), { type: 'module', name: 'ghostmesh-e2ee' })
    this.worker.onmessage = (ev: MessageEvent<(WorkerResponse & { reqId: number }) | WorkerError>) => {
      const p = this.pending.get(ev.data.reqId)
      if (!p) return
      this.pending.delete(ev.data.reqId)
      if ('error' in ev.data) p.reject(new Error(ev.data.error))
      else p.resolve(ev.data)
    }
    this.worker.onerror = (e) => {
      // Without this, an unloaded worker script (404 / CSP / MIME error on the
      // host) would leave every pending call hanging forever — the UI would
      // freeze on "BOOTING MESH…" with no visible cause.
      const msg = e.message
        ? `E2EE worker error: ${e.message}`
        : 'E2EE worker failed to load (asset 404 or blocked by host CSP/MIME)'
      this.failed = new Error(msg)
      console.error('[E2EEWorker] fatal', e)
      this.pending.forEach((p) => p.reject(this.failed as Error))
      this.pending.clear()
    }
  }

  private call<Op extends WorkerRequest['op']>(
    req: Extract<WorkerRequest, { op: Op }>,
    transfer: Transferable[] = [],
  ): Promise<ResponseFor<Op>> {
    if (this.failed) return Promise.reject(this.failed)
    const reqId = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve: (v) => resolve(v as ResponseFor<Op>), reject })
      this.worker.postMessage({ reqId, ...req }, transfer)
    })
  }

  init(alias: string) {
    return this.call({ op: 'INIT', alias })
  }
  exportIdentity() {
    return this.call({ op: 'EXPORT_IDENTITY' })
  }
  establishSession(peerId: string, peerBoxPublicKey: string) {
    return this.call({ op: 'ESTABLISH_SESSION', peerId, peerBoxPublicKey })
  }
  dropSession(peerId: string) {
    return this.call({ op: 'DROP_SESSION', peerId })
  }
  encryptMessage(peerId: string, plaintext: string, aad?: string) {
    return this.call({ op: 'ENCRYPT_MESSAGE', peerId, plaintext, aad })
  }
  decryptMessage(peerId: string, iv: string, ciphertext: string, aad?: string) {
    return this.call({ op: 'DECRYPT_MESSAGE', peerId, iv, ciphertext, aad })
  }
  signPacket(header: PacketHeader) {
    return this.call({ op: 'SIGN_PACKET', header })
  }
  verifyPacket(header: PacketHeader, signature: string, signerPublicKey: string) {
    return this.call({ op: 'VERIFY_PACKET', header, signature, signerPublicKey })
  }
  chunkFile(transferId: string, data: ArrayBuffer, chunkSize = 32 * 1024) {
    return this.call({ op: 'CHUNK_FILE', transferId, data, chunkSize }, [data])
  }
  encryptChunk(transferId: string, index: number, chunk: ArrayBuffer = new ArrayBuffer(0)) {
    return this.call({ op: 'ENCRYPT_CHUNK', transferId, index, chunk })
  }
  decryptChunk(transferId: string, index: number, iv: string, ciphertext: ArrayBuffer) {
    return this.call({ op: 'DECRYPT_CHUNK', transferId, index, iv, ciphertext }, [ciphertext])
  }
  importFileKey(transferId: string, rawKey: string) {
    return this.call({ op: 'IMPORT_FILE_KEY', transferId, rawKey })
  }
  exportFileKey(transferId: string) {
    return this.call({ op: 'EXPORT_FILE_KEY', transferId })
  }
  purgeTransfer(transferId: string) {
    return this.call({ op: 'PURGE_TRANSFER', transferId })
  }
  sha256(data: ArrayBuffer) {
    return this.call({ op: 'SHA256', data }, [data])
  }
  wipeAll() {
    return this.call({ op: 'WIPE_ALL' })
  }

  terminate() {
    this.worker.terminate()
    this.pending.forEach((p) => p.reject(new Error('worker terminated')))
    this.pending.clear()
  }
}

let singleton: E2EEClient | null = null
export function getE2EE(): E2EEClient {
  if (!singleton) singleton = new E2EEClient()
  return singleton
}
