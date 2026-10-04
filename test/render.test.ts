import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseFile } from '../src/parse.js'
import { render } from '../src/render.js'
import type { Block, Facet, Frontmatter, ImageRef, ParsedFile, RenderedPost, Run, Segment } from '../src/types.js'

const cwd = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')
const fixture = (name: string): string => `test/fixtures/parse/${name}`
const OPTS = { threadCounter: false, linkCards: true }

// --- helpers to build ParsedFile values by hand -------------------------------------------
const t = (text: string): Run => ({ text })
const l = (text: string, link: string): Run => ({ text, link })
const img = (alt: string): ImageRef => ({ path: `/abs/${alt}.png`, alt, mime: 'image/png' })
const blk = (runs: Run[], images: ImageRef[] = []): Block => ({ runs, images })
const seg = (...blocks: Block[]): Segment => ({ blocks })
const pf = (segments: Segment[], frontmatter: Frontmatter = {}, relPath = 'posts/x.md'): ParsedFile => ({
  path: `/repo/${relPath}`,
  relPath,
  hash: 'sha256:' + '0'.repeat(64),
  frontmatter,
  segments,
})
const enc = new TextEncoder()
const dec = new TextDecoder()
const sliceBytes = (text: string, f: Facet): string => dec.decode(enc.encode(text).slice(f.index.byteStart, f.index.byteEnd))
const links = (p: RenderedPost): string[] =>
  p.facets.flatMap((f) => f.features.filter((x) => x.$type === 'app.bsky.richtext.facet#link').map((x) => (x as { uri: string }).uri))
const bytesOf = (s: string): number => enc.encode(s).length

describe('render: SPEC §5 rendering table (rows.md)', () => {
  it('renders every row and auto-splits at block boundaries', async () => {
    const file = await parseFile(fixture('rows.md'), cwd)
    const { posts } = render(file, OPTS)
    expect(posts).toHaveLength(3)

    const p1 = posts[0]!
    expect(p1.text).toBe(
      [
        'Heading',
        '',
        'Plain em strong del code text and https://example.com/auto plus bold html end.',
        'Soft break line.',
        'Hard break line.',
        '',
        'const x = 1;',
        '',
        'indented code',
        '',
        '- one',
        '- two',
        '  - nested',
        '  - nested link',
        '',
        '1. first',
        '2. second',
        '',
        '> quoted line',
        '> second quoted line',
        '>',
        '> second paragraph',
      ].join('\n'),
    )
    // Manual link facets, including one whose text equals its URL.
    expect(p1.facets.map((f) => [sliceBytes(p1.text, f), f.features])).toEqual([
      ['text', [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/page' }]],
      ['https://example.com/auto', [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/auto' }]],
      ['nested link', [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/n' }]],
    ])
    expect(p1.facets[0]!.index).toEqual({ byteStart: 34, byteEnd: 38 })
    // The image-only paragraph attached its image here without adding a blank line.
    expect(p1.images).toEqual([{ path: path.join(cwd, 'test/fixtures/images/pixel.png'), alt: 'A pixel', mime: 'image/png' }])
    expect(p1.linkCardUrl).toBeUndefined() // has an image
    expect(p1.graphemes).toBe(267)
    expect(p1.bytes).toBe(267)

    const p2 = posts[1]!
    expect(p2.text).toBe('Bare https://bsky.app and #hashtag and @alice.bsky.social plus é 日本語 👨‍👩‍👧 done.')
    expect(p2.facets).toEqual([
      { index: { byteStart: 5, byteEnd: 21 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://bsky.app' }] },
      { index: { byteStart: 26, byteEnd: 34 }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'hashtag' }] },
      { index: { byteStart: 39, byteEnd: 57 }, features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'alice.bsky.social' }] },
    ])
    expect(p2.graphemes).toBe(76)
    expect(p2.bytes).toBe(100)
    expect(p2.images).toEqual([])
    expect(p2.linkCardUrl).toBe('https://bsky.app')

    const p3 = posts[2]!
    expect(p3.text).toBe('Second segment here.')
    expect(p3.images.map((i) => i.alt)).toEqual(['inline'])
    expect(p3.facets).toEqual([])
    expect(p3.linkCardUrl).toBeUndefined()
  })
})

describe('render: facets', () => {
  it('uses UTF-8 byte offsets with multi-byte characters, emoji and ZWJ sequences', () => {
    const file = pf([seg(blk([t('é 日本語 '), l('link', 'https://x.y/'), t(' 👨‍👩‍👧 #tag')]))])
    const [post] = render(file, OPTS).posts
    expect(post!.text).toBe('é 日本語 link 👨‍👩‍👧 #tag')
    expect(post!.facets).toEqual([
      { index: { byteStart: 13, byteEnd: 17 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://x.y/' }] },
      { index: { byteStart: 37, byteEnd: 41 }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'tag' }] },
    ])
    expect(post!.graphemes).toBe(17)
    expect(post!.bytes).toBe(41)
    for (const f of post!.facets) expect(['link', '#tag']).toContain(sliceBytes(post!.text, f))
  })

  it('offsets account for the blank line between blocks', () => {
    const file = pf([seg(blk([t('日本')]), blk([l('go', 'https://x.y/')]))])
    const [post] = render(file, OPTS).posts
    expect(post!.text).toBe('日本\n\ngo')
    expect(post!.facets[0]!.index).toEqual({ byteStart: 8, byteEnd: 10 })
  })

  it('a Markdown link whose text equals its URL yields exactly one (manual) facet', () => {
    const file = pf([seg(blk([t('see '), l('https://example.com/a', 'https://example.com/a')]))])
    const [post] = render(file, OPTS).posts
    expect(post!.facets).toHaveLength(1)
    expect(post!.facets[0]).toEqual({
      index: { byteStart: 4, byteEnd: 25 },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/a' }],
    })
  })

  it('manual facets win over detected ones that overlap (URL, hashtag, mention in link text)', () => {
    const file = pf([
      seg(
        blk([l('https://example.com/a', 'https://example.com/b')]),
        blk([l('#notatag', 'https://x.y/tag')]),
        blk([l('@alice.bsky.social', 'https://x.y/alice')]),
        blk([l('read bsky.app now', 'https://x.y/bare')]),
      ),
    ])
    const [post] = render(file, OPTS).posts
    expect(post!.facets.map((f) => f.features)).toEqual([
      [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/b' }],
      [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://x.y/tag' }],
      [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://x.y/alice' }],
      [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://x.y/bare' }],
    ])
  })

  it('keeps detected facets outside manual ranges and sorts everything by byteStart', () => {
    const file = pf([seg(blk([t('bsky.app then '), l('manual', 'https://m.example/'), t(' then #x and @bob.test')]))])
    const [post] = render(file, OPTS).posts
    const starts = post!.facets.map((f) => f.index.byteStart)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    expect(post!.facets.map((f) => f.features[0]!.$type)).toEqual([
      'app.bsky.richtext.facet#link',
      'app.bsky.richtext.facet#link',
      'app.bsky.richtext.facet#tag',
      'app.bsky.richtext.facet#mention',
    ])
    expect(post!.facets[0]!.features[0]).toEqual({ $type: 'app.bsky.richtext.facet#link', uri: 'https://bsky.app' })
    expect(post!.facets[3]!.features[0]).toEqual({ $type: 'app.bsky.richtext.facet#mention', did: 'bob.test' })
  })

  it('no facets in plain text', () => {
    const [post] = render(pf([seg(blk([t('just words')]))]), OPTS).posts
    expect(post!.facets).toEqual([])
  })
})

describe('render: text assembly', () => {
  it('joins blocks with one blank line; image-only blocks contribute nothing', () => {
    const file = pf([seg(blk([t('A')]), blk([], [img('one')]), blk([t('B')]))])
    const [post] = render(file, OPTS).posts
    expect(post!.text).toBe('A\n\nB')
    expect(post!.images.map((i) => i.alt)).toEqual(['one'])
  })

  it('collapses 3+ newlines to 2 and trims each post', () => {
    const file = pf([seg(blk([t('  a\n\n\n\nb  ')]), blk([t('\n')]), blk([t('c\n\n')]))])
    const [post] = render(file, OPTS).posts
    expect(post!.text).toBe('a\n\nb\n\nc')
  })

  it('a post can be image-only (empty text)', () => {
    const file = pf([seg(blk([], [img('solo')]))])
    const [post] = render(file, OPTS).posts
    expect(post!.text).toBe('')
    expect(post!.images).toHaveLength(1)
    expect(post!.graphemes).toBe(0)
  })

  it('records graphemes and bytes on every post', () => {
    const text = 'héllo 👨‍👩‍👧'
    const [post] = render(pf([seg(blk([t(text)]))]), OPTS).posts
    expect(post!.graphemes).toBe(7)
    expect(post!.bytes).toBe(bytesOf(text))
  })

  it('throws when there is no content', () => {
    expect(() => render(pf([seg()]), OPTS)).toThrow(/posts\/x\.md: no content to post/)
    expect(() => render(pf([seg(blk([t('   ')]))]), OPTS)).toThrow(/no content/)
  })

  it('skips empty segments', () => {
    const file = pf([seg(), seg(blk([t('one')])), seg(blk([t(' ')])), seg(blk([t('two')]))])
    expect(render(file, OPTS).posts.map((p) => p.text)).toEqual(['one', 'two'])
  })

  it('preserves the ParsedFile on the result', () => {
    const file = pf([seg(blk([t('x')]))])
    expect(render(file, OPTS).file).toBe(file)
  })
})

describe('render: images', () => {
  it('a post with more than 4 images is an error naming the file', async () => {
    const file = await parseFile(fixture('five-images.md'), cwd)
    expect(() => render(file, OPTS)).toThrow(/five-images\.md: post 1 has 5 images \(max 4\)/)
  })

  it('exactly 4 images is fine', () => {
    const file = pf([seg(blk([t('pics')], [img('a'), img('b'), img('c'), img('d')]))])
    expect(render(file, OPTS).posts[0]!.images).toHaveLength(4)
  })
})

describe('render: linkCardUrl', () => {
  const withLink = (frontmatter: Frontmatter, extra: Block[] = []): ParsedFile =>
    pf([seg(blk([t('see '), l('one', 'https://one.example/'), t(' and '), l('two', 'https://two.example/')]), ...extra)], frontmatter)

  it('unset + linkCards on: first link facet in the post', () => {
    expect(render(withLink({}), { threadCounter: false, linkCards: true }).posts[0]!.linkCardUrl).toBe('https://one.example/')
  })

  it('unset + linkCards off: none', () => {
    expect(render(withLink({}), { threadCounter: false, linkCards: false }).posts[0]!.linkCardUrl).toBeUndefined()
  })

  it('link: auto uses the first link even when linkCards is off (explicit frontmatter wins)', () => {
    expect(render(withLink({ link: 'auto' }), { threadCounter: false, linkCards: false }).posts[0]!.linkCardUrl).toBe('https://one.example/')
  })

  it('link: false: none', () => {
    expect(render(withLink({ link: false }), OPTS).posts[0]!.linkCardUrl).toBeUndefined()
  })

  it('link: <url> goes on the first post only', () => {
    const file = pf(
      [seg(blk([t('first')])), seg(blk([t('second '), l('x', 'https://x.example/')]))],
      { link: 'https://card.example/', thread: 'manual' },
    )
    const { posts } = render(file, OPTS)
    expect(posts.map((p) => p.linkCardUrl)).toEqual(['https://card.example/', 'https://x.example/'])
  })

  it('never set when the post has images', () => {
    expect(render(withLink({ link: 'https://card.example/' }, [blk([], [img('i')])]), OPTS).posts[0]!.linkCardUrl).toBeUndefined()
    expect(render(withLink({}, [blk([], [img('i')])]), OPTS).posts[0]!.linkCardUrl).toBeUndefined()
  })

  it('a bare URL detected by RichText counts as the first link', () => {
    const [post] = render(pf([seg(blk([t('go to bsky.app today')]))]), OPTS).posts
    expect(post!.linkCardUrl).toBe('https://bsky.app')
  })

  it('link-false.md and link-explicit.md fixtures', async () => {
    const off = render(await parseFile(fixture('link-false.md'), cwd), OPTS)
    expect(off.posts[0]!.linkCardUrl).toBeUndefined()
    expect(links(off.posts[0]!)).toEqual(['https://example.com'])
    const explicit = render(await parseFile(fixture('link-explicit.md'), cwd), OPTS)
    expect(explicit.posts[0]!.linkCardUrl).toBe('https://example.com/card')
  })
})

describe('render: thread modes', () => {
  it('manual: one post per --- segment (thread.md)', async () => {
    const file = await parseFile(fixture('thread.md'), cwd)
    const { posts } = render(file, OPTS)
    expect(posts.map((p) => p.text)).toEqual([
      'First post of the thread.',
      'Second post of the thread with a link.',
      'Third post.',
    ])
    expect(links(posts[1]!)).toEqual(['https://example.com/two'])
    expect(posts[1]!.linkCardUrl).toBe('https://example.com/two')
  })

  it('manual: overflow is an error naming the file and the grapheme count', () => {
    const file = pf([seg(blk([t('a'.repeat(301))])), seg(blk([t('ok')]))], { thread: 'manual' })
    expect(() => render(file, OPTS)).toThrow(/posts\/x\.md: post 1 is 301 graphemes/)
  })

  it('manual: byte overflow is an error', () => {
    const file = pf([seg(blk([t('👨‍👩‍👧'.repeat(200))]))], { thread: 'manual' })
    expect(() => render(file, OPTS)).toThrow(/post 1 is 200 graphemes \/ 3600 bytes/)
  })

  it('off: a single post (thread-off.md)', async () => {
    const { posts } = render(await parseFile(fixture('thread-off.md'), cwd), OPTS)
    expect(posts.map((p) => p.text)).toEqual(['Only one post here.'])
  })

  it('off: any --- is an error (thread-off-break.md)', async () => {
    const file = await parseFile(fixture('thread-off-break.md'), cwd)
    expect(() => render(file, OPTS)).toThrow(/thread-off-break\.md: thread is "off" but the file contains a --- thread break/)
  })

  it('off: overflow is an error naming the file and grapheme count', () => {
    const file = pf([seg(blk([t('b'.repeat(350))]))], { thread: 'off' })
    expect(() => render(file, OPTS)).toThrow(/posts\/x\.md: post 1 is 350 graphemes/)
  })

  it('auto: --- segments are respected and long segments are split further', () => {
    const file = pf([seg(blk([t('x'.repeat(301))])), seg(blk([t('short')]))])
    const { posts } = render(file, OPTS)
    expect(posts.map((p) => p.graphemes)).toEqual([300, 1, 5])
  })
})

describe('render: thread counter', () => {
  const counted = { threadCounter: true, linkCards: true }

  it('is not appended to a single post', () => {
    const [post] = render(pf([seg(blk([t('a'.repeat(300))]))]), counted).posts
    expect(post!.text).toBe('a'.repeat(300))
    expect(post!.graphemes).toBe(300)
  })

  it('is appended to every post of a manual thread', () => {
    const file = pf([seg(blk([t('one')])), seg(blk([t('two')]))], { thread: 'manual' })
    expect(render(file, counted).posts.map((p) => p.text)).toEqual(['one (1/2)', 'two (2/2)'])
  })

  it('reserves room in manual mode so the counter always fits', () => {
    const file = pf([seg(blk([t('a'.repeat(295))])), seg(blk([t('two')]))], { thread: 'manual' })
    expect(() => render(file, counted)).toThrow(/post 1 is 295 graphemes.*max 292 graphemes \(300 minus room for the thread counter\)/)
    const ok = pf([seg(blk([t('a'.repeat(292))])), seg(blk([t('two')]))], { thread: 'manual' })
    expect(render(ok, counted).posts[0]!.graphemes).toBe(298)
  })

  it('auto: reserves 8 graphemes per post and every post stays within 300', () => {
    const { posts } = render(pf([seg(blk([t('a'.repeat(600))]))]), counted)
    expect(posts).toHaveLength(3)
    posts.forEach((p, i) => {
      expect(p.text.endsWith(` (${i + 1}/3)`)).toBe(true)
      expect(p.graphemes).toBeLessThanOrEqual(300)
    })
    expect(posts.map((p) => p.text.length - ' (1/3)'.length)).toEqual([292, 292, 16])
  })

  it('facets are unaffected by the counter', () => {
    const file = pf([seg(blk([t('go '), l('here', 'https://x.y/')])), seg(blk([t('two')]))], { thread: 'manual' })
    const [post] = render(file, counted).posts
    expect(post!.text).toBe('go here (1/2)')
    expect(sliceBytes(post!.text, post!.facets[0]!)).toBe('here')
  })
})
