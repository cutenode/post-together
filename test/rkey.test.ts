import { describe, expect, it } from 'vitest'
import { TID } from '@atproto/common-web'
import { rkeyFor, TID_RE } from '../src/rkey.js'

const MICROS_2023 = Date.UTC(2023, 0, 1) * 1000
const MICROS_2026 = Date.UTC(2026, 0, 1) * 1000

describe('rkeyFor', () => {
  it('returns the exact TID for a fixed input', () => {
    expect(rkeyFor('posts/hello.md', 0)).toBe('3loecnotsr6uu')
  })

  it('is deterministic', () => {
    expect(rkeyFor('posts/hello.md', 3)).toBe(rkeyFor('posts/hello.md', 3))
    expect(rkeyFor('a/b/c.md', 12)).toBe(rkeyFor('a/b/c.md', 12))
  })

  it('matches the TID record-key grammar', () => {
    for (let i = 0; i < 200; i++) {
      const key = rkeyFor(`posts/${i}.md`, i % 7)
      expect(key).toHaveLength(13)
      expect(key).toMatch(TID_RE)
      expect(key).toMatch(/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/)
    }
  })

  it('differs for a different relPath or index', () => {
    const base = rkeyFor('posts/hello.md', 0)
    expect(rkeyFor('posts/hello.md', 1)).not.toBe(base)
    expect(rkeyFor('posts/hello2.md', 0)).not.toBe(base)
    expect(rkeyFor('other/hello.md', 0)).not.toBe(base)
    const keys = new Set<string>()
    for (let i = 0; i < 50; i++) keys.add(rkeyFor('posts/hello.md', i))
    expect(keys.size).toBe(50)
  })

  it('encodes a timestamp inside 2023-01-01 .. 2025-12-31 UTC and a 10-bit clock id', () => {
    for (let i = 0; i < 50; i++) {
      const tid = TID.fromStr(rkeyFor(`posts/${i}.md`, 0))
      expect(tid.timestamp()).toBeGreaterThanOrEqual(MICROS_2023)
      expect(tid.timestamp()).toBeLessThan(MICROS_2026)
      expect(tid.clockid()).toBeGreaterThanOrEqual(0)
      expect(tid.clockid()).toBeLessThanOrEqual(1023)
    }
  })

  it('rejects a negative or fractional index', () => {
    expect(() => rkeyFor('posts/hello.md', -1)).toThrow(/index/)
    expect(() => rkeyFor('posts/hello.md', 1.5)).toThrow(/index/)
  })
})
