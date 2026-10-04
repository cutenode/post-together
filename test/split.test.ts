import { describe, expect, it } from 'vitest'
import { graphemeLength, trimRuns } from '../src/facets.js'
import { render } from '../src/render.js'
import { COUNTER_LIMITS, FULL_LIMITS, normalizeBlock, splitBlocks } from '../src/split.js'
import type { Block, Facet, Frontmatter, ImageRef, ParsedFile, RenderedPost, Run, Segment } from '../src/types.js'

const OPTS = { threadCounter: false, linkCards: false }
const FAMILY = '👨‍👩‍👧' // 1 grapheme, 18 bytes

const t = (text: string): Run => ({ text })
const l = (text: string, link: string): Run => ({ text, link })
const img = (alt: string): ImageRef => ({ path: `/abs/${alt}.png`, alt, mime: 'image/png' })
const blk = (runs: Run[], images: ImageRef[] = []): Block => ({ runs, images })
const seg = (...blocks: Block[]): Segment => ({ blocks })
const pf = (segments: Segment[], frontmatter: Frontmatter = {}): ParsedFile => ({
  path: '/repo/posts/x.md',
  relPath: 'posts/x.md',
  hash: 'sha256:' + '0'.repeat(64),
  frontmatter,
  segments,
})
const auto = (...blocks: Block[]): RenderedPost[] => render(pf([seg(...blocks)]), OPTS).posts
const enc = new TextEncoder()
const dec = new TextDecoder()
const sliceBytes = (text: string, f: Facet): string => dec.decode(enc.encode(text).slice(f.index.byteStart, f.index.byteEnd))

const withinLimits = (posts: RenderedPost[]): void => {
  for (const p of posts) {
    expect(p.graphemes).toBeLessThanOrEqual(300)
    expect(p.bytes).toBeLessThanOrEqual(3000)
    expect(p.graphemes).toBe(graphemeLength(p.text))
    expect(p.bytes).toBe(enc.encode(p.text).length)
  }
}

describe('auto split: grapheme edge cases', () => {
  it('exactly 300 graphemes stays one post', () => {
    const posts = auto(blk([t('a'.repeat(300))]))
    expect(posts).toHaveLength(1)
    expect(posts[0]!.graphemes).toBe(300)
  })

  it('301 graphemes becomes two posts (300 + 1) when there are no boundaries', () => {
    const posts = auto(blk([t('a'.repeat(301))]))
    expect(posts.map((p) => p.graphemes)).toEqual([300, 1])
    expect(posts.map((p) => p.text).join('')).toBe('a'.repeat(301))
  })

  it('a single 700-grapheme paragraph splits at sentence boundaries into 3 posts', () => {
    const sentences = Array.from({ length: 25 }, (_, i) => `This is sentence number ${String(i).padStart(2, '0')}.`)
    const paragraph = sentences.join(' ')
    expect(graphemeLength(paragraph)).toBe(699)
    const posts = auto(blk([t(paragraph)]))
    expect(posts).toHaveLength(3)
    withinLimits(posts)
    for (const p of posts) expect(p.text.endsWith('.')).toBe(true)
    expect(posts.map((p) => p.text).join(' ')).toBe(paragraph)
    expect(posts.map((p) => p.graphemes)).toEqual([279, 279, 139])
  })

  it('splits at newlines (one list item per line) before words', () => {
    const items = Array.from({ length: 40 }, (_, i) => `- item number ${i}`)
    const posts = auto(blk([t(items.join('\n'))]))
    withinLimits(posts)
    expect(posts.length).toBeGreaterThan(1)
    for (const p of posts) {
      for (const line of p.text.split('\n')) expect(line).toMatch(/^- item number \d+$/)
    }
    expect(posts.flatMap((p) => p.text.split('\n'))).toEqual(items)
  })

  it('falls back to word boundaries when a sentence is too long', () => {
    const words = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ') // no sentence punctuation
    const posts = auto(blk([t(words)]))
    withinLimits(posts)
    expect(posts.length).toBeGreaterThan(1)
    for (const p of posts) expect(p.text).toMatch(/^w\d+( w\d+)*$/)
    expect(posts.map((p) => p.text).join(' ')).toBe(words)
  })

  it('ZWJ family emoji count as one grapheme each and are never cut', () => {
    const one = auto(blk([t(FAMILY.repeat(100))]))
    expect(one).toHaveLength(1)
    expect(one[0]!.graphemes).toBe(100)
    expect(one[0]!.bytes).toBe(1800)

    const posts = auto(blk([t('a'.repeat(299) + FAMILY + 'b')]))
    expect(posts.map((p) => p.graphemes)).toEqual([300, 1])
    expect(posts[0]!.text.endsWith(FAMILY)).toBe(true)
    expect(posts[1]!.text).toBe('b')
  })

  it('splits on the 3000-byte limit even when graphemes are under 300', () => {
    const posts = auto(blk([t(FAMILY.repeat(200))]))
    expect(posts.map((p) => p.graphemes)).toEqual([166, 34])
    withinLimits(posts)
    expect(posts.map((p) => p.text).join('')).toBe(FAMILY.repeat(200))
  })
})

describe('auto split: block boundaries first', () => {
  it('two 200-grapheme paragraphs become two posts, one paragraph each', () => {
    const a = 'a'.repeat(200)
    const b = 'b'.repeat(200)
    const posts = auto(blk([t(a)]), blk([t(b)]))
    expect(posts.map((p) => p.text)).toEqual([a, b])
  })

  it('short blocks are packed together with the blank line counted', () => {
    const posts = auto(blk([t('a'.repeat(100))]), blk([t('b'.repeat(100))]), blk([t('c'.repeat(100))]))
    expect(posts.map((p) => p.text)).toEqual(['a'.repeat(100) + '\n\n' + 'b'.repeat(100), 'c'.repeat(100)])
    expect(posts[0]!.graphemes).toBe(202)
  })

  it('after a block is split, following short blocks join the last piece', () => {
    const posts = auto(blk([t('a'.repeat(301))]), blk([t('tail')]))
    expect(posts.map((p) => p.text)).toEqual(['a'.repeat(300), 'a\n\ntail'])
  })
})

describe('auto split: links', () => {
  it('never splits inside a link run that straddles the 300 boundary', () => {
    const lead = 'w '.repeat(145) // 290 chars, 289 after trim
    const posts = auto(blk([t(lead), l('a link here to', 'https://x.y/link'), t(' tail words')]))
    expect(posts).toHaveLength(2)
    withinLimits(posts)
    expect(posts[0]!.text).toBe(lead.trim())
    expect(posts[0]!.facets).toEqual([])
    expect(posts[1]!.text).toBe('a link here to tail words')
    expect(posts[1]!.facets).toEqual([
      { index: { byteStart: 0, byteEnd: 14 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://x.y/link' }] },
    ])
  })

  it('keeps link facets intact across every post of a split paragraph', () => {
    const runs: Run[] = []
    for (let i = 0; i < 30; i++) {
      runs.push(t(`Sentence ${i} mentions `), l(`link number ${i}`, `https://x.y/${i}`), t('. '))
    }
    const posts = auto(blk(runs))
    withinLimits(posts)
    expect(posts.length).toBeGreaterThan(2)
    const seen: string[] = []
    for (const p of posts) {
      for (const f of p.facets) {
        const text = sliceBytes(p.text, f)
        expect(text).toMatch(/^link number \d+$/)
        seen.push(text)
      }
    }
    expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => `link number ${i}`))
  })

  it('a link run longer than a post is an error naming the file', () => {
    const file = pf([seg(blk([t('see '), l('x'.repeat(301), 'https://x.y/')]))])
    expect(() => render(file, OPTS)).toThrow(/posts\/x\.md: cannot split a post: the link/)
  })
})

describe('auto split: images', () => {
  it('images stay with the post that contains their block', () => {
    const posts = auto(blk([t('a'.repeat(300))], [img('first')]), blk([t('b')], [img('second')]))
    expect(posts.map((p) => p.images.map((i) => i.alt))).toEqual([['first'], ['second']])
  })

  it('a split block keeps its images on the post where it starts', () => {
    const posts = auto(blk([t('a'.repeat(301))], [img('pic')]))
    expect(posts.map((p) => p.images.map((i) => i.alt))).toEqual([['pic'], []])
  })

  it('image-only blocks attach to the current post', () => {
    const posts = auto(blk([t('a')]), blk([], [img('x')]), blk([t('b'.repeat(300))]), blk([], [img('y')]))
    expect(posts.map((p) => p.text)).toEqual(['a', 'b'.repeat(300)])
    expect(posts.map((p) => p.images.map((i) => i.alt))).toEqual([['x'], ['y']])
  })
})

describe('splitBlocks / helpers', () => {
  it('splitBlocks returns drafts with pieces and images', () => {
    const drafts = splitBlocks([blk([t('hello')], [img('a')]), blk([t('world')])], FULL_LIMITS, 'f.md')
    expect(drafts).toHaveLength(1)
    expect(drafts[0]!.pieces).toEqual([[t('hello')], [t('world')]])
    expect(drafts[0]!.images.map((i) => i.alt)).toEqual(['a'])
  })

  it('COUNTER_LIMITS reserve 8', () => {
    expect(COUNTER_LIMITS).toEqual({ graphemes: 292, bytes: 2992 })
    expect(FULL_LIMITS).toEqual({ graphemes: 300, bytes: 3000 })
    const drafts = splitBlocks([blk([t('a'.repeat(300))])], COUNTER_LIMITS, 'f.md')
    expect(drafts).toHaveLength(2)
  })

  it('normalizeBlock collapses newlines and trims, keeping link runs', () => {
    const b = normalizeBlock(blk([t('  a\n\n\n\nb '), l(' c ', 'https://x.y/'), t('  ')]))
    expect(b.runs).toEqual([t('a\n\nb '), l(' c', 'https://x.y/')])
  })

  it('trimRuns drops runs emptied by trimming and does not mutate the input', () => {
    const input = [t(' '), t('  x '), l('y', 'https://x.y/'), t(' \n')]
    const out = trimRuns(input)
    expect(out).toEqual([t('x '), l('y', 'https://x.y/')])
    expect(input[1]).toEqual(t('  x '))
  })
})
