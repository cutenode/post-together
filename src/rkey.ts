import { createHash } from 'node:crypto'
import { TID } from '@atproto/common-web'

/** Bluesky record-key grammar for `key: tid` collections (https://atproto.com/specs/tid). */
export const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/

/** 2023-01-01T00:00:00Z in microseconds. */
const EPOCH_MICROS = 1_672_531_200_000_000n
/** Three 365-day years in microseconds: the timestamps land inside 2023-01-01 .. 2025-12-31 UTC. */
const RANGE_MICROS = 94_608_000_000_000n

/**
 * Deterministic TID record key for post `index` of the file at `relPath` (SPEC §7.4).
 *
 * `n` is the first 8 bytes of `sha256("post-together:v1:<relPath>#<index>")` read as an
 * unsigned 64-bit big-endian integer. The TID timestamp is `2023-01-01 + (n mod 3 years)`
 * and the clock id is bits 54..63 of `n`. Same inputs always give the same 13-character
 * TID; different inputs practically never collide.
 */
export function rkeyFor(relPath: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`rkeyFor: index must be a non-negative integer, got ${String(index)}`)
  }
  const digest = createHash('sha256').update(`post-together:v1:${relPath}#${index}`).digest()
  const n = digest.readBigUInt64BE(0)
  const micros = EPOCH_MICROS + (n % RANGE_MICROS)
  const clockid = Number((n >> 54n) & 1023n)
  const rkey = TID.fromTime(Number(micros), clockid).toString()
  if (!TID_RE.test(rkey)) {
    throw new Error(`rkeyFor: generated an invalid TID "${rkey}" for ${relPath}#${index}`)
  }
  return rkey
}
