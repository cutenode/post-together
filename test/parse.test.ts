import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseFile } from '../src/parse.js'
import type { Block, ParsedFile } from '../src/types.js'

const cwd = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')
const fixture = (name: string): string => `test/fixtures/parse/${name}`
const imagesDir = path.join(cwd, 'test', 'fixtures', 'images')

const text = (b: Block): string => b.runs.map((r) => r.text).join('')

describe('parseFile on rows.md (every SPEC §5 row)', () => {
  let file: ParsedFile
  let blocks: Block[]
  beforeAll(async () => {
    file = await parseFile(fixture('rows.md'), cwd)
    blocks = file.segments[0]!.blocks
  })

  it('records the absolute path, posix relPath and sha256 of the raw bytes', async () => {
    expect(file.path).toBe(path.join(cwd, 'test', 'fixtures', 'parse', 'rows.md'))
    expect(file.relPath).toBe('test/fixtures/parse/rows.md')
    const raw = await readFile(file.path)
    expect(file.hash).toBe('sha256:' + createHash('sha256').update(raw).digest('hex'))
    expect(file.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('parses the frontmatter', () => {
    expect(file.frontmatter).toEqual({ langs: ['en', 'fr'], createdAt: '2026-09-28T09:00:00.000Z' })
  })

  it('splits on --- into segments and drops raw HTML blocks', () => {
    expect(file.segments).toHaveLength(2)
    expect(blocks).toHaveLength(9)
    expect(blocks.map(text).some((t) => t.includes('block html'))).toBe(false)
  })

  it('heading: its text without #', () => {
    expect(blocks[0]).toEqual({ runs: [{ text: 'Heading' }], images: [] })
  })

  it('paragraph: emphasis, strong, delete, inline code, links, inline HTML, soft and hard breaks', () => {
    const p = blocks[1]!
    expect(text(p)).toBe(
      'Plain em strong del code text and https://example.com/auto plus bold html end.\nSoft break line.\nHard break line.',
    )
    expect(p.runs).toEqual([
      { text: 'Plain em strong del code ' },
      { text: 'text', link: 'https://example.com/page' },
      { text: ' and ' },
      { text: 'https://example.com/auto', link: 'https://example.com/auto' },
      { text: ' plus bold html end.\nSoft break line.\nHard break line.' },
    ])
    expect(p.images).toEqual([])
  })

  it('fenced and indented code blocks: verbatim text', () => {
    expect(blocks[2]).toEqual({ runs: [{ text: 'const x = 1;' }], images: [] })
    expect(blocks[3]).toEqual({ runs: [{ text: 'indented code' }], images: [] })
  })

  it('unordered list: one line per item, nested lists indented two spaces, links kept', () => {
    const l = blocks[4]!
    expect(text(l)).toBe('- one\n- two\n  - nested\n  - nested link')
    expect(l.runs).toContainEqual({ text: 'nested link', link: 'https://example.com/n' })
  })

  it('ordered list: numbered items', () => {
    expect(text(blocks[5]!)).toBe('1. first\n2. second')
  })

  it('blockquote: each line prefixed with "> "', () => {
    expect(text(blocks[6]!)).toBe('> quoted line\n> second quoted line\n>\n> second paragraph')
  })

  it('image-only paragraph: no runs, one image resolved relative to the file', () => {
    expect(blocks[7]).toEqual({
      runs: [],
      images: [{ path: path.join(imagesDir, 'pixel.png'), alt: 'A pixel', mime: 'image/png' }],
    })
  })

  it('bare URLs, hashtags and mentions stay plain text at parse time', () => {
    expect(text(blocks[8]!)).toBe('Bare https://bsky.app and #hashtag and @alice.bsky.social plus é 日本語 👨‍👩‍👧 done.')
    expect(blocks[8]!.runs.every((r) => r.link === undefined)).toBe(true)
  })

  it('inline image inside a paragraph is lifted out and the surrounding whitespace collapsed', () => {
    const seg = file.segments[1]!
    expect(seg.blocks).toHaveLength(1)
    expect(text(seg.blocks[0]!)).toBe('Second segment here.')
    expect(seg.blocks[0]!.images).toEqual([{ path: path.join(imagesDir, 'pixel.jpg'), alt: 'inline', mime: 'image/jpeg' }])
  })
})

describe('parseFile fixtures', () => {
  it('thread.md: manual thread with three segments', async () => {
    const f = await parseFile(fixture('thread.md'), cwd)
    expect(f.frontmatter).toEqual({ thread: 'manual' })
    expect(f.segments).toHaveLength(3)
    expect(f.segments.map((s) => s.blocks.length)).toEqual([1, 1, 1])
    expect(f.segments[1]!.blocks[0]!.runs).toContainEqual({ text: 'a link', link: 'https://example.com/two' })
  })

  it('frontmatter variants via files', async () => {
    expect((await parseFile(fixture('no-frontmatter.md'), cwd)).frontmatter).toEqual({})
    expect((await parseFile(fixture('empty-frontmatter.md'), cwd)).frontmatter).toEqual({})
    expect((await parseFile(fixture('link-false.md'), cwd)).frontmatter).toEqual({ link: false })
    expect((await parseFile(fixture('thread-off.md'), cwd)).frontmatter).toEqual({ thread: 'off' })
    expect((await parseFile(fixture('all-keys.md'), cwd)).frontmatter).toEqual({
      draft: true,
      langs: ['en', 'fr', 'de'],
      createdAt: '2026-09-28T09:00:00.000Z',
      link: 'auto',
      thread: 'manual',
    })
  })

  it('frontmatter errors name the file', async () => {
    await expect(parseFile(fixture('bad-yaml.md'), cwd)).rejects.toThrow(/bad-yaml\.md: invalid frontmatter YAML/)
    await expect(parseFile(fixture('unknown-key.md'), cwd)).rejects.toThrow(/unknown-key\.md: unknown frontmatter key "title"/)
    await expect(parseFile(fixture('wrong-type.md'), cwd)).rejects.toThrow(/wrong-type\.md: frontmatter key "draft"/)
    await expect(parseFile(fixture('unterminated.md'), cwd)).rejects.toThrow(/unterminated\.md.*never closed/)
  })

  it('tables are an error naming the file and line', async () => {
    await expect(parseFile(fixture('table.md'), cwd)).rejects.toThrow(/test\/fixtures\/parse\/table\.md:3: tables are not supported/)
  })

  it('footnotes are an error naming the file and line', async () => {
    await expect(parseFile(fixture('footnote.md'), cwd)).rejects.toThrow(/test\/fixtures\/parse\/footnote\.md:\d+: footnotes are not supported/)
  })

  it('image errors name the file and line', async () => {
    await expect(parseFile(fixture('bad-image-ext.md'), cwd)).rejects.toThrow(/bad-image-ext\.md:1: unsupported image type "\.\.\/images\/pixel\.bmp"/)
    await expect(parseFile(fixture('missing-image.md'), cwd)).rejects.toThrow(/missing-image\.md:1: image not found: \.\/nope\.png/)
    await expect(parseFile(fixture('remote-image.md'), cwd)).rejects.toThrow(/remote-image\.md:1: remote images are not supported/)
  })

  it('a link that is not an absolute URL is an error naming the file and line', async () => {
    await expect(parseFile(fixture('relative-link.md'), cwd)).rejects.toThrow(/relative-link\.md:2: link "\/docs" is not an absolute URL/)
  })

  it('an empty body yields one empty segment', async () => {
    const f = await parseFile(fixture('empty-body.md'), cwd)
    expect(f.frontmatter).toEqual({ draft: true })
    expect(f.segments).toEqual([{ blocks: [] }])
  })

  it('five images in one paragraph parse (render enforces the limit)', async () => {
    const f = await parseFile(fixture('five-images.md'), cwd)
    expect(f.segments[0]!.blocks[1]!.images).toHaveLength(5)
    expect(f.segments[0]!.blocks[1]!.images.map((i) => i.mime)).toEqual([
      'image/png',
      'image/png',
      'image/jpeg',
      'image/png',
      'image/jpeg',
    ])
  })

  it('a missing file is an error naming the file', async () => {
    await expect(parseFile('test/fixtures/parse/nope.md', cwd)).rejects.toThrow(/nope\.md: cannot read file/)
  })
})

describe('parseFile with generated files', () => {
  let dir: string
  const write = async (name: string, content: string | Buffer): Promise<string> => {
    const p = path.join(dir, name)
    await writeFile(p, content)
    return p
  }
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'post-together-parse-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects an image over 2,000,000 bytes and accepts one at the limit', async () => {
    await write('big.png', Buffer.alloc(2_000_001))
    await write('ok.png', Buffer.alloc(2_000_000))
    const bad = await write('big.md', 'Look:\n\n![big](./big.png)\n')
    await expect(parseFile(bad, dir)).rejects.toThrow(/big\.md:3: image \.\/big\.png is 2000001 bytes \(max 2000000\)/)
    const ok = await write('ok.md', '![ok](./ok.png)\n')
    const f = await parseFile(ok, dir)
    expect(f.segments[0]!.blocks[0]!.images[0]).toEqual({ path: path.join(dir, 'ok.png'), alt: 'ok', mime: 'image/png' })
  })

  it('maps every supported extension (case-insensitively) to its mime type', async () => {
    for (const ext of ['png', 'jpg', 'JPEG', 'webp', 'GIF']) await write(`img.${ext}`, Buffer.alloc(10))
    const p = await write('exts.md', '![a](img.png) ![b](img.jpg) ![c](img.JPEG) ![d](img.webp) ![e](img.GIF)\n')
    const f = await parseFile(p, dir)
    expect(f.segments[0]!.blocks[0]!.images.map((i) => i.mime)).toEqual([
      'image/png',
      'image/jpeg',
      'image/jpeg',
      'image/webp',
      'image/gif',
    ])
    expect(f.segments[0]!.blocks[0]!.runs).toEqual([])
  })

  it('decodes percent-encoded image paths', async () => {
    await write('my pic.png', Buffer.alloc(10))
    const p = await write('enc.md', '![pic](./my%20pic.png)\n')
    const f = await parseFile(p, dir)
    expect(f.segments[0]!.blocks[0]!.images[0]!.path).toBe(path.join(dir, 'my pic.png'))
  })

  it('normalises CRLF line endings and strips a BOM', async () => {
    const p = await write('crlf.md', '﻿---\r\nlangs: [en]\r\n---\r\nLine one\r\nline two.\r\n\r\n- a\r\n- b\r\n')
    const f = await parseFile(p, dir)
    expect(f.frontmatter).toEqual({ langs: ['en'] })
    const texts = f.segments[0]!.blocks.map(text)
    expect(texts).toEqual(['Line one\nline two.', '- a\n- b'])
    expect(texts.join('')).not.toContain('\r')
  })

  it('resolves reference-style links and images', async () => {
    await write('ref.png', Buffer.alloc(10))
    const p = await write('ref.md', 'See [the docs][d] and ![pic][p].\n\n[d]: https://example.com/docs\n[p]: ./ref.png\n')
    const f = await parseFile(p, dir)
    const b = f.segments[0]!.blocks[0]!
    expect(b.runs).toEqual([{ text: 'See ' }, { text: 'the docs', link: 'https://example.com/docs' }, { text: ' and .' }])
    expect(b.images.map((i) => i.alt)).toEqual(['pic'])
    expect(f.segments[0]!.blocks).toHaveLength(1)
  })

  it('renders ~~strikethrough~~ as its inner text and keeps a lone ~~', async () => {
    const p = await write('del.md', 'Keep ~~this~~ but ~~ alone.\n')
    const f = await parseFile(p, dir)
    expect(text(f.segments[0]!.blocks[0]!)).toBe('Keep this but ~~ alone.')
  })

  it('renders a link whose text is styled, and an autolink, as single link runs', async () => {
    const p = await write('links.md', '[**bold** link](https://example.com/b) <https://example.com/c>\n')
    const f = await parseFile(p, dir)
    expect(f.segments[0]!.blocks[0]!.runs).toEqual([
      { text: 'bold link', link: 'https://example.com/b' },
      { text: ' ' },
      { text: 'https://example.com/c', link: 'https://example.com/c' },
    ])
  })

  it('renders nested lists, blockquotes with lists, and a leading --- after frontmatter', async () => {
    const p = await write(
      'nested.md',
      '---\ndraft: false\n---\n\n1. one\n   1. one-a\n   2. one-b\n2. two\n\n> - q1\n> - q2\n>\n> tail\n\n---\n\nNext.\n',
    )
    const f = await parseFile(p, dir)
    expect(f.segments).toHaveLength(2)
    expect(f.segments[0]!.blocks.map(text)).toEqual(['1. one\n  1. one-a\n  2. one-b\n2. two', '> - q1\n> - q2\n>\n> tail'])
    expect(f.segments[0]!.blocks[0]!.images).toEqual([])
    expect(f.segments[1]!.blocks.map(text)).toEqual(['Next.'])
  })

  it('a --- directly after the frontmatter starts a second, empty-first segment', async () => {
    const p = await write('leading.md', '---\ndraft: false\n---\n---\n\nBody.\n')
    const f = await parseFile(p, dir)
    expect(f.segments.map((s) => s.blocks.length)).toEqual([0, 1])
  })

  it('a table inside a blockquote is still detected', async () => {
    const p = await write('qtable.md', 'Intro.\n\n> | a |\n> |---|\n> | 1 |\n')
    await expect(parseFile(p, dir)).rejects.toThrow(/qtable\.md:3: tables are not supported/)
  })

  it('a table without a leading pipe on the first line is left as text', async () => {
    const p = await write('nottable.md', 'a | b\n--|--\n')
    const f = await parseFile(p, dir)
    expect(text(f.segments[0]!.blocks[0]!)).toBe('a | b\n--|--')
  })
})
