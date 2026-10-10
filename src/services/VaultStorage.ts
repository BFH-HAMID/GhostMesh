/**
 * VaultStorage — IndexedDB persistence for messages with hard TTL purge.
 *
 * Message bodies are stored **encrypted at rest** with a per-session
 * AES-256-GCM key (never persisted). When the TTL expires the record is
 * deleted and, because the key is session-scoped, any stale bytes left on
 * flash are unrecoverable after the app closes anyway.
 */
import type { ChatMessage } from '@/types'
import { decryptString, encryptString, generateAesKey } from '@/crypto/E2EECore'
import { secureWipe, utf8ToBytes } from '@/crypto/encoding'

const DB = 'ghostmesh-vault'
const STORE = 'messages'
const VERSION = 1

interface StoredMessage extends Omit<ChatMessage, 'body'> {
  iv: string
  ciphertext: string
}

let dbPromise: Promise<IDBDatabase> | null = null
let vaultKey: CryptoKey | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' })
        os.createIndex('expiresAt', 'expiresAt')
        os.createIndex('conversationId', 'conversationId')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function key(): Promise<CryptoKey> {
  if (!vaultKey) vaultKey = await generateAesKey(false)
  return vaultKey
}

function tx(db: IDBDatabase, mode: IDBTransactionMode) {
  return db.transaction(STORE, mode).objectStore(STORE)
}

const reqToPromise = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })

export const VaultStorage = {
  async put(msg: ChatMessage): Promise<void> {
    const db = await openDb()
    const { body, ...rest } = msg
    const env = await encryptString(await key(), body, utf8ToBytes(msg.id))
    const rec: StoredMessage = { ...rest, iv: env.iv, ciphertext: env.ciphertext }
    await reqToPromise(tx(db, 'readwrite').put(rec))
  },

  async updateStatus(id: string, status: ChatMessage['status'], hops?: number): Promise<void> {
    const db = await openDb()
    const store = tx(db, 'readwrite')
    const rec = (await reqToPromise(store.get(id))) as StoredMessage | undefined
    if (!rec) return
    rec.status = status
    if (hops !== undefined) rec.hops = hops
    await reqToPromise(store.put(rec))
  },

  async loadAll(): Promise<ChatMessage[]> {
    const db = await openDb()
    const recs = (await reqToPromise(tx(db, 'readonly').getAll())) as StoredMessage[]
    const k = await key()
    const now = Date.now()
    const out: ChatMessage[] = []
    for (const r of recs) {
      if (r.expiresAt <= now) {
        await this.purge(r.id)
        continue
      }
      try {
        const body = await decryptString(k, { iv: r.iv, ciphertext: r.ciphertext }, utf8ToBytes(r.id))
        const { iv: _iv, ciphertext: _ct, ...rest } = r
        out.push({ ...rest, body })
      } catch {
        // Key from previous session — record is cryptographically dead; purge it.
        await this.purge(r.id)
      }
    }
    return out
  },

  /** Hard delete. Overwrites ciphertext with random bytes before deletion (belt & braces). */
  async purge(id: string): Promise<void> {
    const db = await openDb()
    const store = tx(db, 'readwrite')
    const rec = (await reqToPromise(store.get(id))) as StoredMessage | undefined
    if (rec) {
      const junk = new Uint8Array(Math.min(512, rec.ciphertext.length))
      crypto.getRandomValues(junk)
      rec.ciphertext = btoa(String.fromCharCode(...junk.subarray(0, 512)))
      secureWipe(junk)
      await reqToPromise(store.put(rec))
    }
    await reqToPromise(store.delete(id))
  },

  async purgeExpired(now = Date.now()): Promise<string[]> {
    const db = await openDb()
    const idx = tx(db, 'readonly').index('expiresAt')
    const expired = (await reqToPromise(idx.getAll(IDBKeyRange.upperBound(now)))) as StoredMessage[]
    for (const r of expired) await this.purge(r.id)
    return expired.map((r) => r.id)
  },

  async nuke(): Promise<void> {
    const db = await openDb()
    await reqToPromise(tx(db, 'readwrite').clear())
    vaultKey = null
    localStorage.clear()
  },
}
