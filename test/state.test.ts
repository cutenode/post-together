import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyState, isComplete, readState, resolveStatePath, serializeState, StateStore, writeState } from '../src/state.js'
import type { State } from '../src/types.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'post-together-state-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sample: State = {
  version: 1,
  posts: {
    'posts/b.md': { hash: 'sha256:bb', did: 'did:plc:test', postedAt: '2026-09-28T00:00:00.000Z', posts: [{ rkey: '3kbbbbbbbbbbb', uri: 'at://did:plc:test/app.bsky.feed.post/3kbbbbbbbbbbb', cid: 'bafyreib' }] },
    'posts/a.md': { hash: 'sha256:aa', did: 'did:plc:test', posts: [{ rkey: '3kaaaaaaaaaaa', uri: 'at://did:plc:test/app.bsky.feed.post/3kaaaaaaaaaaa' }] },
  },
}

describe('resolveStatePath', () => {
  it('returns null for none (any case) and resolves other paths against cwd', () => {
    expect(resolveStatePath('none', '/w')).toBeNull()
    expect(resolveStatePath(' NONE ', '/w')).toBeNull()
    expect(resolveStatePath('posts/.post-together.json', '/w')).toBe(path.resolve('/w', 'posts/.post-together.json'))
    expect(resolveStatePath('/abs/state.json', '/w')).toBe(path.resolve('/abs/state.json'))
  })
})

describe('isComplete', () => {
  it('needs postedAt and a cid on every post; posts: [] with postedAt counts', () => {
    expect(isComplete({ hash: 'h', did: '', postedAt: 'now', posts: [] })).toBe(true)
    expect(isComplete({ hash: 'h', did: 'd', posts: [] })).toBe(false)
    expect(isComplete({ hash: 'h', did: 'd', postedAt: 'now', posts: [{ rkey: 'r', uri: 'u', cid: 'c' }] })).toBe(true)
    expect(isComplete({ hash: 'h', did: 'd', postedAt: 'now', posts: [{ rkey: 'r', uri: 'u' }] })).toBe(false)
    expect(isComplete({ hash: 'h', did: 'd', posts: [{ rkey: 'r', uri: 'u', cid: 'c' }] })).toBe(false)
  })
})

describe('readState', () => {
  it('returns an empty state when the file is missing', async () => {
    expect(await readState(path.join(dir, 'missing.json'))).toEqual(emptyState())
  })

  it('round-trips what writeState wrote', async () => {
    const file = path.join(dir, 'nested', 'state.json')
    await writeState(file, sample)
    expect(await readState(file)).toEqual(sample)
  })

  it('rejects a wrong version', async () => {
    const file = path.join(dir, 'state.json')
    await writeFile(file, JSON.stringify({ version: 2, posts: {} }))
    await expect(readState(file)).rejects.toThrow(/version 2/)
    await writeFile(file, JSON.stringify({ posts: {} }))
    await expect(readState(file)).rejects.toThrow(/version/)
  })

  it('rejects invalid JSON and malformed entries', async () => {
    const file = path.join(dir, 'state.json')
    await writeFile(file, '{ not json')
    await expect(readState(file)).rejects.toThrow(/not valid JSON/)
    await writeFile(file, JSON.stringify({ version: 1, posts: { 'a.md': { hash: 'h' } } }))
    await expect(readState(file)).rejects.toThrow(/"did"/)
    await writeFile(file, JSON.stringify({ version: 1, posts: { 'a.md': { hash: 'h', did: 'd', posts: [{ rkey: 'r' }] } } }))
    await expect(readState(file)).rejects.toThrow(/"uri"/)
    await writeFile(file, JSON.stringify([]))
    await expect(readState(file)).rejects.toThrow(/object/)
  })

  it('tolerates a missing posts map', async () => {
    const file = path.join(dir, 'state.json')
    await writeFile(file, JSON.stringify({ version: 1 }))
    expect(await readState(file)).toEqual(emptyState())
  })
})

describe('writeState', () => {
  it('writes pretty JSON with sorted keys and a trailing newline', async () => {
    const file = path.join(dir, 'state.json')
    await writeState(file, sample)
    const text = await readFile(file, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toBe(serializeState(sample))
    expect(text.indexOf('"posts/a.md"')).toBeLessThan(text.indexOf('"posts/b.md"'))
    expect(text.split('\n')[1]).toBe('  "version": 1,')
    expect(text).not.toContain('"cid": undefined')
  })

  it('replaces the target in place and leaves no temp files behind', async () => {
    const file = path.join(dir, 'state.json')
    await writeState(file, emptyState())
    await writeState(file, sample)
    expect(await readState(file)).toEqual(sample)
    expect(await readdir(dir)).toEqual(['state.json'])
  })

  it('fails without leaving a temp file when the target cannot be written', async () => {
    const blocked = path.join(dir, 'blocked.json')
    await mkdir(blocked)
    await expect(writeState(blocked, sample)).rejects.toThrow()
    expect((await readdir(dir)).filter((n) => n.includes('.tmp'))).toEqual([])
  })
})

describe('StateStore', () => {
  it('keeps changes in memory only when the path is null', async () => {
    const store = await StateStore.open(null)
    await store.set('a.md', { hash: 'h', did: 'd', posts: [] })
    expect(store.get('a.md')).toEqual({ hash: 'h', did: 'd', posts: [] })
    expect(store.changed).toBe(true)
    expect(await readdir(dir)).toEqual([])
  })

  it('writes through on every set', async () => {
    const file = path.join(dir, 'state.json')
    const store = await StateStore.open(file)
    expect(store.changed).toBe(false)
    await store.set('a.md', { hash: 'h', did: 'd', posts: [{ rkey: 'r', uri: 'u' }] })
    expect((await readState(file)).posts['a.md']?.posts[0]?.cid).toBeUndefined()
    await store.set('a.md', { hash: 'h', did: 'd', posts: [{ rkey: 'r', uri: 'u', cid: 'c' }], postedAt: 't' })
    const reloaded = await readState(file)
    expect(reloaded.posts['a.md']).toEqual({ hash: 'h', did: 'd', posts: [{ rkey: 'r', uri: 'u', cid: 'c' }], postedAt: 't' })
    expect(store.changed).toBe(true)
  })

  it('loads existing entries', async () => {
    const file = path.join(dir, 'state.json')
    await writeState(file, sample)
    const store = await StateStore.open(file)
    expect(store.get('posts/b.md')?.postedAt).toBe('2026-09-28T00:00:00.000Z')
    expect(store.get('nope.md')).toBeUndefined()
  })
})
