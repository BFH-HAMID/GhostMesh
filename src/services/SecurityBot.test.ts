import { describe, expect, it } from 'vitest'
import { SecurityBot, redact } from './SecurityBot'
import type { MeshPacket } from '@/types'

const pkt = (over: Partial<MeshPacket> = {}): MeshPacket => ({
  id: crypto.randomUUID(),
  type: 'HANDSHAKE',
  from: 'attacker-node-0001',
  to: 'me',
  ttl: 8,
  hopCount: 1,
  path: ['attacker-node-0001'],
  timestamp: Date.now(),
  iv: '',
  payload: '{}',
  signature: 'bad',
  ...over,
})

describe('SecurityBot', () => {
  it('redacts node ids', () => {
    expect(redact('abcdef123456')).toBe('abcd…56')
    expect(redact('abc')).toBe('****')
  })

  it('flags replayed packet ids', () => {
    const bot = new SecurityBot({ notify: false })
    const p = pkt()
    expect(bot.inspectInbound(p, p.from, 'ble', false).allow).toBe(true)
    const v = bot.inspectInbound(p, p.from, 'ble', false)
    expect(v.allow).toBe(false)
    expect(v.event?.kind).toBe('REPLAY')
  })

  it('escalates repeated forged handshakes to BRUTE_FORCE and blocks the source', () => {
    const bot = new SecurityBot({ notify: false })
    const events: string[] = []
    bot.onThreat((e) => events.push(e.kind))
    for (let i = 0; i < 5; i++) bot.signatureFailed(pkt(), 'wifi-direct')
    expect(events.slice(0, 4).every((k) => k === 'SIGNATURE_INVALID')).toBe(true)
    expect(events[4]).toBe('BRUTE_FORCE')
    expect(bot.isBlocked('attacker-node-0001')).toBe(true)
    expect(bot.inspectInbound(pkt(), 'attacker-node-0001', 'wifi-direct', false).allow).toBe(false)
  })

  it('detects identity key substitution (MITM)', () => {
    const bot = new SecurityBot({ notify: false })
    expect(bot.pinKey('node-a', 'key1', 'ble').allow).toBe(true)
    expect(bot.pinKey('node-a', 'key1', 'ble').allow).toBe(true)
    const v = bot.pinKey('node-a', 'key2', 'ble')
    expect(v.allow).toBe(false)
    expect(v.event?.kind).toBe('KEY_MISMATCH')
    expect(v.event?.sourceRedacted).not.toContain('node-a')
  })

  it('drops packets with out-of-bounds TTL', () => {
    const bot = new SecurityBot({ notify: false })
    expect(bot.inspectInbound(pkt({ ttl: 99 }), 'x', 'ble', true).event?.kind).toBe('TTL_ABUSE')
  })
})
