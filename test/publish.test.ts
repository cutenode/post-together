import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlueskyError, login } from '../src/bluesky.js'
import { run, UsageError } from '../src/index.js'
import type { LinkCardMeta } from '../src/linkcard.js'
import { plan, publishFile } from '../src/publish.js'
import { rkeyFor } from '../src/rkey.js'
import { readState, StateStore } from '../src/state.js'
import type { Facet, Frontmatter, ImageRef, Logger, ParsedFile, RenderedFile, RenderedPost, State } from '../src/types.js'
import { FakePds } from './fake-pds.js'

const IDENTIFIER = 'bot.test'
const PASSWORD = 'app-pass-1234'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201e2d3a1b40000000049454e44ae426082', 'hex')

let pds: FakePds
let tmp: string
let logs: Record<'info' | 'warn' | 'error' | 'debug', string[]>
let logger: Logger

beforeEach(async () => {
  pds = await FakePds.start({ handle: IDENTIFIER, password: PASSWORD, handles: { 'alice.test': 'did:plc:alice', 'bob.test': 'did:plc:bob' } })
  tmp = await mkdtemp(path.join(tmpdir(), 'post-together-publish-'))
  logs = { info: [], warn: [], error: [], debug: [] }
  logger = {
    info: (m) => logs.info.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
    debug: (m) => logs.debug.push(m),
  }
})

afterEach(async () => {
  await pds.close()
  await rm(tmp, { recursive: true, force: true })
})

function graphemes(text: string): number {
  return [...new Intl.Segmenter().segment(text)].length
}

interface PostSpec {
  text: string
  facets?: Facet[]
  images?: ImageRef[]
  linkCardUrl?: string
}

/** Build a RenderedFile by hand (render() is covered by its own tests). */
function rendered(relPath: string, specs: PostSpec[], frontmatter: Frontmatter = {}): RenderedFile {
  const file: ParsedFile = {
    path: path.join(tmp, relPath),
    relPath,
    hash: 'sha256:' + createHash('sha256').update(relPath + JSON.stringify(specs)).digest('hex'),
    frontmatter,
    segments: [],
  }
  const posts: RenderedPost[] = specs.map((s) => {
    const post: RenderedPost = { text: s.text, facets: s.facets ?? [], images: s.images ?? [], graphemes: graphemes(s.text), bytes: Buffer.byteLength(s.text) }
    if (s.linkCardUrl !== undefined) post.linkCardUrl = s.linkCardUrl
    return post
  })
  return { file, posts }
}

function mention(text: string, handle: string): Facet {
  const at = text.indexOf('@' + handle)
  const byteStart = Buffer.byteLength(text.slice(0, at))
  return { index: { byteStart, byteEnd: byteStart + Buffer.byteLength('@' + handle) }, features: [{ $type: 'app.bsky.richtext.facet#mention', did: handle }] }
}

function body(req: { body: unknown }): { rkey: string; record: Record<string, unknown> } {
  return req.body as { rkey: string; record: Record<string, unknown> }
}

const doLogin = () => login({ service: pds.url, identifier: IDENTIFIER, password: PASSWORD })

describe('plan', () => {
  const state: State = {
    version: 1,
    posts: {
      'done.md': { hash: 'sha256:done', did: 'did:plc:test', postedAt: 't', posts: [{ rkey: 'r', uri: 'u', cid: 'c' }] },
      'changed.md': { hash: 'sha256:old', did: 'did:plc:test', postedAt: 't', posts: [] },
      'partial.md': { hash: 'sha256:partial', did: 'did:plc:test', posts: [{ rkey: 'r', uri: 'u' }] },
    },
  }
  const stubLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} }

  it('classifies drafts, posted, changed, incomplete and new files', () => {
    const items = plan(
      [
        { relPath: 'draft.md', hash: 'sha256:d', draft: true },
        { relPath: 'done.md', hash: 'sha256:done', draft: false, rendered: rendered('done.md', [{ text: 'x' }]) },
        { relPath: 'changed.md', hash: 'sha256:new', draft: false, rendered: rendered('changed.md', [{ text: 'x' }]) },
        { relPath: 'partial.md', hash: 'sha256:partial', draft: false, rendered: rendered('partial.md', [{ text: 'x' }]) },
        { relPath: 'new.md', hash: 'sha256:n', draft: false, rendered: rendered('new.md', [{ text: 'x' }]) },
      ],
      state,
      0,
      stubLogger,
    )
    expect(items.map((i) => [i.relPath, i.action, i.action === 'skip' ? i.reason : ''])).toEqual([
      ['draft.md', 'skip', 'draft'],
      ['done.md', 'skip', 'posted'],
      ['changed.md', 'skip', 'changed'],
      ['partial.md', 'post', ''],
      ['new.md', 'post', ''],
    ])
  })

  it('applies the limit to files that would be posted only', () => {
    const items = plan(
      [
        { relPath: 'done.md', hash: 'sha256:done', draft: false, rendered: rendered('done.md', [{ text: 'x' }]) },
        { relPath: 'a.md', hash: 'sha256:a', draft: false, rendered: rendered('a.md', [{ text: 'x' }]) },
        { relPath: 'b.md', hash: 'sha256:b', draft: false, rendered: rendered('b.md', [{ text: 'x' }]) },
        { relPath: 'c.md', hash: 'sha256:c', draft: false, rendered: rendered('c.md', [{ text: 'x' }]) },
      ],
      state,
      2,
      stubLogger,
    )
    expect(items.map((i) => (i.action === 'skip' ? i.reason : 'post'))).toEqual(['posted', 'post', 'post', 'limit'])
  })
})

describe('login', () => {
  it('rejects a wrong password with a message naming the identifier and hinting at app passwords', async () => {
    const err = await login({ service: pds.url, identifier: IDENTIFIER, password: 'wrong-password' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BlueskyError)
    expect((err as BlueskyError).kind).toBe('auth')
    expect((err as Error).message).toContain(IDENTIFIER)
    expect((err as Error).message).toMatch(/app password/i)
    expect((err as Error).message).not.toContain('wrong-password')
  })

  it('logs in once and exposes the DID', async () => {
    const client = await doLogin()
    expect(client.did).toBe('did:plc:test')
    expect(pds.calls('com.atproto.server.createSession')).toHaveLength(1)
  })
})

describe('publishFile', () => {
  it('posts a 3-post thread with deterministic rkeys and a reply chain', async () => {
    const client = await doLogin()
    const store = await StateStore.open(path.join(tmp, 'state.json'))
    const file = rendered('posts/thread.md', [{ text: 'one' }, { text: 'two' }, { text: 'three' }], { createdAt: '2026-01-02T03:04:05Z', langs: ['en'] })
    const outcome = await publishFile(client, store, file, { logger })

    const gets = pds.calls('com.atproto.repo.getRecord')
    const creates = pds.calls('com.atproto.repo.createRecord')
    expect(gets.map((g) => g.query['rkey'])).toEqual([0, 1, 2].map((i) => rkeyFor('posts/thread.md', i)))
    expect(creates).toHaveLength(3)
    expect(creates.map((c) => body(c).rkey)).toEqual([0, 1, 2].map((i) => rkeyFor('posts/thread.md', i)))
    for (const c of creates) {
      expect(c.headers.authorization).toBe(`Bearer ${pds.accessJwt}`)
      const b = c.body as { repo: string; collection: string }
      expect(b.repo).toBe('did:plc:test')
      expect(b.collection).toBe('app.bsky.feed.post')
    }

    const [r0, r1, r2] = creates.map((c) => body(c).record)
    expect(r0).toEqual({ $type: 'app.bsky.feed.post', text: 'one', langs: ['en'], createdAt: '2026-01-02T03:04:05.000Z' })
    expect(r0).not.toHaveProperty('reply')
    expect(r0).not.toHaveProperty('embed')
    expect(r0).not.toHaveProperty('facets')

    const first = outcome.posts[0]!
    const second = outcome.posts[1]!
    expect(r1!['createdAt']).toBe('2026-01-02T03:04:06.000Z')
    expect(r1!['reply']).toEqual({ root: { uri: first.uri, cid: first.cid }, parent: { uri: first.uri, cid: first.cid } })
    expect(r2!['createdAt']).toBe('2026-01-02T03:04:07.000Z')
    expect(r2!['reply']).toEqual({ root: { uri: first.uri, cid: first.cid }, parent: { uri: second.uri, cid: second.cid } })

    expect(outcome.resumed).toBe(false)
    expect(outcome.posts.map((p) => p.uri)).toEqual([0, 1, 2].map((i) => `at://did:plc:test/app.bsky.feed.post/${rkeyFor('posts/thread.md', i)}`))
    expect(outcome.posts.every((p) => typeof p.cid === 'string' && p.cid.startsWith('bafyrei'))).toBe(true)

    const saved = await readState(path.join(tmp, 'state.json'))
    const entry = saved.posts['posts/thread.md']!
    expect(entry.hash).toBe(file.file.hash)
    expect(entry.did).toBe('did:plc:test')
    expect(entry.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(entry.posts).toEqual(outcome.posts)
  })

  it('uploads images and embeds the returned blobs', async () => {
    const client = await doLogin()
    const store = await StateStore.open(null)
    const img = path.join(tmp, 'pic.png')
    await writeFile(img, PNG)
    const file = rendered('posts/pic.md', [{ text: 'look', images: [{ path: img, alt: 'a tiny square', mime: 'image/png' }] }])
    await publishFile(client, store, file, { logger })

    const uploads = pds.calls('com.atproto.repo.uploadBlob')
    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.headers['content-type']).toBe('image/png')
    expect(uploads[0]!.rawBody.equals(PNG)).toBe(true)
    expect(uploads[0]!.headers.authorization).toBe(`Bearer ${pds.accessJwt}`)

    const record = body(pds.calls('com.atproto.repo.createRecord')[0]!).record
    const blob = pds.blobs[0]!
    expect(record['embed']).toEqual({
      $type: 'app.bsky.embed.images',
      images: [{ image: { $type: 'blob', ref: { $link: blob.cid }, mimeType: 'image/png', size: PNG.length }, alt: 'a tiny square' }],
    })
  })

  it('resolves mention handles to DIDs, caches lookups and drops unknown handles with a warning', async () => {
    const client = await doLogin()
    const store = await StateStore.open(null)
    const text = 'hi @alice.test and @nobody.test and again @alice.test'
    const secondAlice = text.lastIndexOf('@alice.test')
    const facets: Facet[] = [
      mention(text, 'alice.test'),
      mention(text, 'nobody.test'),
      { index: { byteStart: secondAlice, byteEnd: secondAlice + '@alice.test'.length }, features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'alice.test' }] },
      { index: { byteStart: 0, byteEnd: 2 }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'hi' }] },
    ]
    await publishFile(client, store, rendered('posts/m.md', [{ text, facets }]), { logger })

    const resolves = pds.calls('com.atproto.identity.resolveHandle')
    expect(resolves.map((r) => r.query['handle']).sort()).toEqual(['alice.test', 'nobody.test'])
    const record = body(pds.calls('com.atproto.repo.createRecord')[0]!).record
    expect(record['facets']).toEqual([
      { index: facets[0]!.index, features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:alice' }] },
      { index: facets[2]!.index, features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:alice' }] },
      { index: { byteStart: 0, byteEnd: 2 }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'hi' }] },
    ])
    expect(logs.warn.some((m) => m.includes('@nobody.test') && m.includes('posts/m.md'))).toBe(true)
  })

  it('resumes a reserved entry whose record already exists without creating it again', async () => {
    const client = await doLogin()
    const relPath = 'posts/resume.md'
    const file = rendered(relPath, [{ text: 'already there' }])
    const rkey = rkeyFor(relPath, 0)
    const seeded = pds.seed(rkey, { $type: 'app.bsky.feed.post', text: 'already there', createdAt: '2026-01-01T00:00:00.000Z' })
    const stateFile = path.join(tmp, 'state.json')
    await writeFile(stateFile, JSON.stringify({ version: 1, posts: { [relPath]: { hash: file.file.hash, did: 'did:plc:test', posts: [{ rkey, uri: pds.uriFor(rkey) }] } } }))
    const store = await StateStore.open(stateFile)

    const outcome = await publishFile(client, store, file, { logger })
    expect(pds.calls('com.atproto.repo.createRecord')).toHaveLength(0)
    expect(pds.calls('com.atproto.repo.getRecord')).toHaveLength(1)
    expect(outcome.resumed).toBe(true)
    expect(outcome.posts).toEqual([{ rkey, uri: seeded.uri, cid: seeded.cid }])
    const saved = await readState(stateFile)
    expect(saved.posts[relPath]!.postedAt).toBeDefined()
    expect(saved.posts[relPath]!.posts[0]!.cid).toBe(seeded.cid)
  })

  it('creates only the missing posts of a partially posted thread and chains replies to the existing root', async () => {
    const client = await doLogin()
    const relPath = 'posts/partial.md'
    const file = rendered(relPath, [{ text: 'root' }, { text: 'reply' }])
    const seeded = pds.seed(rkeyFor(relPath, 0), { $type: 'app.bsky.feed.post', text: 'root', createdAt: '2026-01-01T00:00:00.000Z' })
    const store = await StateStore.open(null)

    const outcome = await publishFile(client, store, file, { logger })
    const creates = pds.calls('com.atproto.repo.createRecord')
    expect(creates).toHaveLength(1)
    expect(body(creates[0]!).rkey).toBe(rkeyFor(relPath, 1))
    expect(body(creates[0]!).record['reply']).toEqual({ root: { uri: seeded.uri, cid: seeded.cid }, parent: { uri: seeded.uri, cid: seeded.cid } })
    expect(outcome.resumed).toBe(true)
    expect(outcome.posts[0]!.cid).toBe(seeded.cid)
  })

  it('trusts cids already in the state entry without asking the PDS', async () => {
    const client = await doLogin()
    const relPath = 'posts/trusted.md'
    const file = rendered(relPath, [{ text: 'a' }, { text: 'b' }])
    const rkey0 = rkeyFor(relPath, 0)
    const stateFile = path.join(tmp, 'state.json')
    await writeFile(
      stateFile,
      JSON.stringify({
        version: 1,
        posts: {
          [relPath]: { hash: file.file.hash, did: 'did:plc:test', posts: [{ rkey: rkey0, uri: pds.uriFor(rkey0), cid: 'bafyreitrusted' }, { rkey: rkeyFor(relPath, 1), uri: pds.uriFor(rkeyFor(relPath, 1)) }] },
        },
      }),
    )
    const store = await StateStore.open(stateFile)
    await publishFile(client, store, file, { logger })
    expect(pds.calls('com.atproto.repo.getRecord').map((g) => g.query['rkey'])).toEqual([rkeyFor(relPath, 1)])
    expect(pds.calls('com.atproto.repo.createRecord')).toHaveLength(1)
    expect(body(pds.calls('com.atproto.repo.createRecord')[0]!).record['reply']).toEqual({
      root: { uri: pds.uriFor(rkey0), cid: 'bafyreitrusted' },
      parent: { uri: pds.uriFor(rkey0), cid: 'bafyreitrusted' },
    })
  })

  it('stops on 429, keeps the successful cids in state and reports the retry-after value', async () => {
    pds.failCreateAt = 2
    const client = await doLogin()
    const relPath = 'posts/limited.md'
    const file = rendered(relPath, [{ text: 'first' }, { text: 'second' }, { text: 'third' }])
    const stateFile = path.join(tmp, 'state.json')
    const store = await StateStore.open(stateFile)

    const err = await publishFile(client, store, file, { logger }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BlueskyError)
    expect((err as BlueskyError).kind).toBe('rate-limited')
    expect((err as BlueskyError).retryAfter).toBe('30')
    expect((err as Error).message).toContain('30')
    expect((err as Error).message).toContain(relPath)
    expect(pds.calls('com.atproto.repo.createRecord')).toHaveLength(2)

    const saved = await readState(stateFile)
    const entry = saved.posts[relPath]!
    expect(entry.postedAt).toBeUndefined()
    expect(entry.posts.map((p) => p.rkey)).toEqual([0, 1, 2].map((i) => rkeyFor(relPath, i)))
    expect(entry.posts[0]!.cid).toBe(pds.records.get(rkeyFor(relPath, 0))!.cid)
    expect(entry.posts[1]!.cid).toBeUndefined()
    expect(entry.posts[2]!.cid).toBeUndefined()

    // A later run resumes: the first record exists, the other two are created.
    pds.failCreateAt = undefined
    const store2 = await StateStore.open(stateFile)
    const outcome = await publishFile(client, store2, file, { logger })
    expect(outcome.resumed).toBe(true)
    expect(pds.calls('com.atproto.repo.createRecord')).toHaveLength(4)
    expect((await readState(stateFile)).posts[relPath]!.postedAt).toBeDefined()
  })

  it('reports InvalidRequest with the PDS message and the file', async () => {
    const client = await doLogin()
    const store = await StateStore.open(null)
    const err = await publishFile(client, store, rendered('posts/long.md', [{ text: 'x'.repeat(3001) }]), { logger }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BlueskyError)
    expect((err as BlueskyError).kind).toBe('invalid-request')
    expect((err as Error).message).toContain('posts/long.md')
    expect((err as Error).message).toContain('3000')
  })

  it('attaches a link card with an uploaded thumbnail', async () => {
    const client = await doLogin()
    const store = await StateStore.open(null)
    const thumb = Buffer.from('jpegbytes')
    const fetchLinkCard = async (url: string): Promise<LinkCardMeta> => ({ uri: url, title: 'Card title', description: 'Card desc', thumb: { bytes: new Uint8Array(thumb), mime: 'image/jpeg' } })
    await publishFile(client, store, rendered('posts/card.md', [{ text: 'see https://example.com/x', linkCardUrl: 'https://example.com/x' }]), { logger, fetchLinkCard })

    const uploads = pds.calls('com.atproto.repo.uploadBlob')
    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.headers['content-type']).toBe('image/jpeg')
    const record = body(pds.calls('com.atproto.repo.createRecord')[0]!).record
    expect(record['embed']).toEqual({
      $type: 'app.bsky.embed.external',
      external: { uri: 'https://example.com/x', title: 'Card title', description: 'Card desc', thumb: { $type: 'blob', ref: { $link: pds.blobs[0]!.cid }, mimeType: 'image/jpeg', size: thumb.length } },
    })
  })

  it('posts without a card and warns when the link cannot be fetched', async () => {
    const client = await doLogin()
    const store = await StateStore.open(null)
    const fetchLinkCard = async (): Promise<LinkCardMeta> => {
      throw new Error('boom')
    }
    await publishFile(client, store, rendered('posts/nocard.md', [{ text: 'see https://example.com/x', linkCardUrl: 'https://example.com/x' }]), { logger, fetchLinkCard })
    expect(pds.calls('com.atproto.repo.uploadBlob')).toHaveLength(0)
    const record = body(pds.calls('com.atproto.repo.createRecord')[0]!).record
    expect(record).not.toHaveProperty('embed')
    expect(logs.warn.some((m) => m.includes('https://example.com/x') && m.includes('boom'))).toBe(true)
  })

  it('prefers images over a link card', async () => {
    const client = await doLogin()
    const store = await StateStore.open(null)
    const img = path.join(tmp, 'pic.png')
    await writeFile(img, PNG)
    let cardFetched = false
    const fetchLinkCard = async (url: string): Promise<LinkCardMeta> => {
      cardFetched = true
      return { uri: url, title: '', description: '' }
    }
    await publishFile(client, store, rendered('posts/both.md', [{ text: 'x', images: [{ path: img, alt: '', mime: 'image/png' }], linkCardUrl: 'https://example.com' }]), { logger, fetchLinkCard })
    expect(cardFetched).toBe(false)
    const record = body(pds.calls('com.atproto.repo.createRecord')[0]!).record
    expect((record['embed'] as { $type: string }).$type).toBe('app.bsky.embed.images')
  })
})

describe('run', () => {
  async function writePosts(files: Record<string, string>): Promise<string> {
    const dir = path.join(tmp, 'posts')
    await mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
      await writeFile(path.join(dir, name), content)
    }
    return dir
  }

  const base = () => ({ cwd: tmp, dir: 'posts', service: pds.url, identifier: IDENTIFIER, password: PASSWORD, logger })

  it('dry-run renders everything and performs no HTTP requests at all', async () => {
    await writePosts({ 'a.md': 'Hello world\n', 'b.md': 'First\n\n---\n\nSecond\n' })
    const result = await run({ ...base(), dryRun: true })
    expect(pds.requests).toHaveLength(0)
    expect(result.rendered.map((r) => r.file.relPath)).toEqual(['posts/a.md', 'posts/b.md'])
    expect(result.rendered[1]!.posts).toHaveLength(2)
    expect(result.posted).toEqual([])
    expect(result.did).toBeUndefined()
    expect(logs.info.join('\n')).toContain('posts/b.md (2 posts)')
    expect(logs.info.join('\n')).toContain('| Second')
    expect(logs.info.join('\n')).toMatch(/dry run/)
  })

  it('posts new files, records them in the state file and skips them on the next run', async () => {
    await writePosts({ 'a.md': 'Hello world\n', 'b.md': 'First\n\n---\n\nSecond\n' })
    const result = await run(base())
    expect(result.did).toBe('did:plc:test')
    expect(result.posted.map((p) => [p.relPath, p.posts.length])).toEqual([
      ['posts/a.md', 1],
      ['posts/b.md', 2],
    ])
    expect(pds.calls('com.atproto.repo.createRecord')).toHaveLength(3)
    expect(pds.calls('com.atproto.server.createSession')).toHaveLength(1)
    expect(logs.info.some((m) => m.startsWith('posted posts/a.md → https://bsky.app/profile/did:plc:test/post/') && m.endsWith('(1 post)'))).toBe(true)

    const state = await readState(path.join(tmp, 'posts', '.post-together.json'))
    expect(state.version).toBe(1)
    expect(Object.keys(state.posts).sort()).toEqual(['posts/a.md', 'posts/b.md'])
    expect(state.posts['posts/b.md']!.posts).toHaveLength(2)
    expect(state.posts['posts/b.md']!.postedAt).toBeDefined()

    const again = await run(base())
    expect(again.posted).toEqual([])
    expect(again.skipped).toEqual([
      { relPath: 'posts/a.md', reason: 'posted' },
      { relPath: 'posts/b.md', reason: 'posted' },
    ])
    expect(pds.calls('com.atproto.repo.createRecord')).toHaveLength(3)
    expect(pds.calls('com.atproto.server.createSession')).toHaveLength(1)
    expect(logs.info).toContain('skipped posts/a.md (already posted)')
  })

  it('with stateFile none a second run creates nothing', async () => {
    await writePosts({ 'a.md': 'Hello world\n', 'b.md': 'First\n\n---\n\nSecond\n' })
    const first = await run({ ...base(), stateFile: 'none' })
    expect(first.posted).toHaveLength(2)
    expect(pds.calls('com.atproto.repo.createRecord')).toHaveLength(3)

    const second = await run({ ...base(), stateFile: 'none' })
    expect(second.posted).toEqual([])
    expect(second.resumed.map((r) => r.relPath)).toEqual(['posts/a.md', 'posts/b.md'])
    expect(pds.calls('com.atproto.repo.createRecord')).toHaveLength(3)
    expect(pds.calls('com.atproto.repo.getRecord')).toHaveLength(6)
    expect(pds.records.size).toBe(3)
  })

  it('skips drafts and changed files, and honours the limit', async () => {
    const dir = await writePosts({ 'a.md': 'A\n', 'b.md': 'B\n', 'c.md': 'C\n', 'd.md': '---\ndraft: true\n---\nD\n' })
    const first = await run({ ...base(), limit: 1 })
    expect(first.posted.map((p) => p.relPath)).toEqual(['posts/a.md'])
    expect(first.skipped).toEqual([
      { relPath: 'posts/b.md', reason: 'limit' },
      { relPath: 'posts/c.md', reason: 'limit' },
      { relPath: 'posts/d.md', reason: 'draft' },
    ])
    await writeFile(path.join(dir, 'a.md'), 'A edited\n')
    const second = await run({ ...base(), limit: 1 })
    expect(second.posted.map((p) => p.relPath)).toEqual(['posts/b.md'])
    expect(second.skipped).toContainEqual({ relPath: 'posts/a.md', reason: 'changed' })
    expect(logs.warn.some((m) => m.includes('posts/a.md') && m.includes('changed'))).toBe(true)
  })

  it('stops on 429 and leaves a resumable state file', async () => {
    pds.failCreateAt = 2
    await writePosts({ 'a.md': 'One\n\n---\n\nTwo\n' })
    const err = await run(base()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BlueskyError)
    expect((err as Error).message).toMatch(/retry after 30/i)
    const state = await readState(path.join(tmp, 'posts', '.post-together.json'))
    expect(state.posts['posts/a.md']!.posts[0]!.cid).toBeDefined()
    expect(state.posts['posts/a.md']!.posts[1]!.cid).toBeUndefined()
    expect(state.posts['posts/a.md']!.postedAt).toBeUndefined()

    pds.failCreateAt = undefined
    const resumed = await run(base())
    expect(resumed.resumed.map((r) => r.relPath)).toEqual(['posts/a.md'])
    expect(pds.calls('com.atproto.repo.createRecord')).toHaveLength(3)
    expect((await readState(path.join(tmp, 'posts', '.post-together.json'))).posts['posts/a.md']!.postedAt).toBeDefined()
  })

  it('fails with the identifier hint on a wrong password, before any write', async () => {
    await writePosts({ 'a.md': 'Hello\n' })
    const err = await run({ ...base(), password: 'nope' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BlueskyError)
    expect((err as Error).message).toContain(IDENTIFIER)
    expect((err as Error).message).toMatch(/app password/i)
    expect((err as Error).message).not.toContain('nope')
    expect(pds.calls('com.atproto.repo.createRecord')).toHaveLength(0)
  })

  it('requires credentials unless there is nothing to post or it is a dry run', async () => {
    await writePosts({ 'a.md': 'Hello\n' })
    await expect(run({ cwd: tmp, dir: 'posts', service: pds.url, logger })).rejects.toThrow(UsageError)
    expect(pds.requests).toHaveLength(0)
    await expect(run({ cwd: tmp, dir: 'posts', service: pds.url, logger, dryRun: true })).resolves.toBeDefined()
  })

  it('init marks every non-draft file as posted without logging in', async () => {
    await writePosts({ 'a.md': 'Hello\n', 'd.md': '---\ndraft: true\n---\nD\n' })
    const result = await run({ cwd: tmp, dir: 'posts', service: pds.url, logger, mode: 'init' })
    expect(pds.requests).toHaveLength(0)
    expect(result.skipped).toEqual([{ relPath: 'posts/d.md', reason: 'draft' }])
    const state = await readState(path.join(tmp, 'posts', '.post-together.json'))
    expect(state.posts['posts/a.md']).toMatchObject({ did: '', posts: [] })
    expect(state.posts['posts/a.md']!.postedAt).toBeDefined()
    expect(state.posts['posts/d.md']).toBeUndefined()

    const later = await run(base())
    expect(later.skipped).toContainEqual({ relPath: 'posts/a.md', reason: 'posted' })
    expect(pds.calls('com.atproto.repo.createRecord')).toHaveLength(0)
    await expect(run({ cwd: tmp, dir: 'posts', service: pds.url, logger, mode: 'init', stateFile: 'none' })).rejects.toThrow(UsageError)
  })

  it('reports every unrenderable file before touching the network', async () => {
    await writePosts({ 'a.md': '---\nbogus: 1\n---\nA\n', 'b.md': '---\nthread: nope\n---\nB\n', 'c.md': 'fine\n' })
    const err = await run(base()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('posts/a.md')
    expect((err as Error).message).toContain('posts/b.md')
    expect(logs.error).toHaveLength(2)
    expect(pds.requests).toHaveLength(0)
  })

  it('never writes the password to logs', async () => {
    await writePosts({ 'a.md': 'Hello\n' })
    process.env['POST_TOGETHER_DEBUG'] = 'true'
    try {
      await run(base())
    } finally {
      delete process.env['POST_TOGETHER_DEBUG']
    }
    const all = [...logs.info, ...logs.warn, ...logs.error, ...logs.debug].join('\n')
    expect(all).not.toContain(PASSWORD)
    expect(logs.debug.some((m) => m.includes('password="***"'))).toBe(true)
    expect(await readFile(path.join(tmp, 'posts', '.post-together.json'), 'utf8')).not.toContain(PASSWORD)
  })
})
