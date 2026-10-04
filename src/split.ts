import { byteLength, graphemeLength, piecesText, runsText, trimRuns } from './facets.js'
import { POST_MAX_BYTES, POST_MAX_GRAPHEMES } from './types.js'
import type { Block, ImageRef, Run } from './types.js'

export interface Limits {
  graphemes: number
  bytes: number
}

/** Graphemes (and bytes) held back per post for a ` (i/n)` thread counter. */
export const COUNTER_RESERVE = 8

export const FULL_LIMITS: Limits = { graphemes: POST_MAX_GRAPHEMES, bytes: POST_MAX_BYTES }
export const COUNTER_LIMITS: Limits = {
  graphemes: POST_MAX_GRAPHEMES - COUNTER_RESERVE,
  bytes: POST_MAX_BYTES - COUNTER_RESERVE,
}

/** A post under construction: block pieces (joined by blank lines) plus the images attached to it. */
export interface PostDraft {
  pieces: Run[][]
  images: ImageRef[]
}

export interface Measure {
  graphemes: number
  bytes: number
}

export function measure(text: string): Measure {
  return { graphemes: graphemeLength(text), bytes: byteLength(text) }
}

export function fitsText(text: string, limits: Limits): boolean {
  return byteLength(text) <= limits.bytes && graphemeLength(text) <= limits.graphemes
}

/** Whitespace normalisation per SPEC §5: collapse 3+ newlines to 2 and trim the block. */
export function normalizeBlock(block: Block): Block {
  const runs = trimRuns(block.runs.map((r) => ({ ...r, text: r.text.replace(/\n{3,}/g, '\n\n') })))
  return { runs, images: block.images }
}

export function blockHasText(block: Block): boolean {
  return runsText(block.runs).trim().length > 0
}

// ---------------------------------------------------------------------------
// Splitting one over-long block: sentence boundaries, then words, then graphemes.
// Link runs are atomic at every level.

type Level = 'sentence' | 'word' | 'grapheme'
const FINER: Record<Level, Level | undefined> = { sentence: 'word', word: 'grapheme', grapheme: undefined }

let segmenter: Intl.Segmenter | undefined
function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return Array.from(segmenter.segment(text), (s) => s.segment)
}

/** Split plain text after each boundary of the given level. Delimiters stay with the preceding part. */
function splitText(text: string, level: Level): string[] {
  switch (level) {
    case 'sentence':
      return text.split(/(?<=[.!?] |\n)/)
    case 'word':
      return text.split(/(?<=\s)/)
    case 'grapheme':
      return graphemes(text)
  }
}

/** Whether `text` ends on a boundary of the given level (String.split never reports a match at the end). */
function endsAtBoundary(text: string, level: Level): boolean {
  switch (level) {
    case 'sentence':
      return /(?:[.!?] |\n)$/.test(text)
    case 'word':
      return /\s$/.test(text)
    case 'grapheme':
      return text.length > 0
  }
}

/** Cut a run list into chunks at the given boundary level; link runs are never cut. */
function chunk(runs: Run[], level: Level): Run[][] {
  const chunks: Run[][] = []
  let current: Run[] = []
  for (const run of runs) {
    if (run.link !== undefined) {
      current.push(run)
      continue
    }
    const parts = splitText(run.text, level)
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      if (part) current.push({ text: part })
      const isLast = i === parts.length - 1
      const boundary = !isLast || endsAtBoundary(part, level)
      if (boundary && current.length > 0) {
        chunks.push(current)
        current = []
      }
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function fitsRuns(runs: Run[], limits: Limits): boolean {
  return fitsText(runsText(trimRuns(runs)), limits)
}

/** Greedily pack chunks into pieces that each fit `limits`, refining chunks that do not fit alone. */
function pack(chunks: Run[][], limits: Limits, level: Level, file: string): Run[][] {
  const pieces: Run[][] = []
  let current: Run[] = []
  for (const c of chunks) {
    if (fitsRuns([...current, ...c], limits)) {
      current.push(...c)
      continue
    }
    if (current.length > 0) {
      pieces.push(current)
      current = []
    }
    if (fitsRuns(c, limits)) {
      current = [...c]
      continue
    }
    const finer = FINER[level]
    if (!finer) {
      const link = c.find((r) => r.link !== undefined)
      const what = link ? `the link "${link.text.slice(0, 40)}" (${link.link})` : `"${runsText(c).slice(0, 40)}"`
      throw new Error(
        `${file}: cannot split a post: ${what} is longer than a single post allows (${limits.graphemes} graphemes / ${limits.bytes} bytes)`,
      )
    }
    const sub = pack(chunk(c, finer), limits, finer, file)
    pieces.push(...sub.slice(0, -1))
    current = sub[sub.length - 1] ?? []
  }
  if (current.length > 0) pieces.push(current)
  return pieces
}

// ---------------------------------------------------------------------------
// Auto splitting of a segment

/**
 * Split a segment's blocks into posts (SPEC §7.3, `thread: auto`): block boundaries first;
 * a block that does not fit an empty post is split at sentence, then word, then grapheme
 * boundaries, never inside a link run. Images attach to the post where their block starts.
 * Text-less blocks (image-only paragraphs) contribute their images to the current post.
 */
export function splitBlocks(blocks: Block[], limits: Limits, file: string): PostDraft[] {
  const drafts: PostDraft[] = []
  let current: PostDraft = { pieces: [], images: [] }
  const flush = (): void => {
    drafts.push(current)
    current = { pieces: [], images: [] }
  }

  for (const block of blocks) {
    if (!blockHasText(block)) {
      current.images.push(...block.images)
      continue
    }
    if (fitsText(piecesText([...current.pieces, block.runs]), limits)) {
      current.pieces.push(block.runs)
      current.images.push(...block.images)
      continue
    }
    if (current.pieces.length > 0) flush()
    if (fitsText(piecesText([block.runs]), limits)) {
      current.pieces.push(block.runs)
      current.images.push(...block.images)
      continue
    }
    const sub = pack(chunk(block.runs, 'sentence'), limits, 'sentence', file)
    current.images.push(...block.images)
    for (let i = 0; i < sub.length; i++) {
      current.pieces.push(sub[i]!)
      if (i < sub.length - 1) flush()
    }
  }
  if (current.pieces.length > 0 || current.images.length > 0) drafts.push(current)
  return drafts
}
