import { describe, expect, it } from 'vitest'
import { secureWipe } from './encoding'

describe('secureWipe', () => {
  it('wipes buffers larger than the 64 KiB getRandomValues limit without throwing', () => {
    const big = new Uint8Array(300_000).fill(7)
    expect(() => secureWipe(big)).not.toThrow()
    expect(big.every((b) => b === 0)).toBe(true)
  })
})
