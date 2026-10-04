import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { discover, isIgnoredName, keyRoot } from '../src/discover.js'

const cwd = fileURLToPath(new URL('./fixtures/discover/', import.meta.url)).replace(/\/$/, '')

describe('discover', () => {
  it('finds *.md files recursively, sorted by relPath, with posix relPaths and absolute paths', async () => {
    const files = await discover('posts', cwd)
    expect(files.map((f) => f.relPath)).toEqual([
      'posts/a.md',
      'posts/b.md',
      'posts/nested/c.md',
      'posts/nested/deeper/d.md',
    ])
    for (const f of files) {
      expect(path.isAbsolute(f.path)).toBe(true)
      expect(f.path).toBe(path.join(cwd, ...f.relPath.split('/')))
      expect(f.relPath).not.toContain('\\')
    }
  })

  describe('exclusions (temp tree, since node_modules is gitignored)', () => {
    let root: string
    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'post-together-discover-'))
      const files = [
        'posts/keep.md',
        'posts/deep/keep.md',
        'posts/_draft.md',
        'posts/.hidden.md',
        'posts/deep/_skip.md',
        'posts/_drafts/e.md',
        'posts/.hidden-dir/f.md',
        'posts/node_modules/pkg/x.md',
        'posts/deep/node_modules/y.md',
        'posts/notes.txt',
        'posts/README',
        'posts/upper.MD',
      ]
      for (const rel of files) {
        const abs = path.join(root, ...rel.split('/'))
        await mkdir(path.dirname(abs), { recursive: true })
        await writeFile(abs, `# ${rel}\n`)
      }
    })
    afterAll(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it('excludes _*, .* names (files and directories), node_modules and non-.md files', async () => {
      const rel = (await discover('posts', root)).map((f) => f.relPath)
      expect(rel).toEqual(['posts/deep/keep.md', 'posts/keep.md', 'posts/upper.MD'])
    })
  })

  it('accepts an absolute dir and computes relPath against cwd', async () => {
    const files = await discover(path.join(cwd, 'posts', 'nested'), cwd)
    expect(files.map((f) => f.relPath)).toEqual(['posts/nested/c.md', 'posts/nested/deeper/d.md'])
  })

  it('computes relPath relative to a different cwd', async () => {
    const files = await discover('nested', path.join(cwd, 'posts'))
    expect(files.map((f) => f.relPath)).toEqual(['nested/c.md', 'nested/deeper/d.md'])
  })

  it('computes relPath against an explicit root', async () => {
    const files = await discover('nested', path.join(cwd, 'posts'), cwd)
    expect(files.map((f) => f.relPath)).toEqual(['posts/nested/c.md', 'posts/nested/deeper/d.md'])
  })

  it('stops at a symlink loop instead of recursing forever', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'post-together-loop-'))
    try {
      await mkdir(path.join(root, 'posts', 'sub'), { recursive: true })
      await writeFile(path.join(root, 'posts', 'sub', 'a.md'), 'A\n')
      await symlink(path.join(root, 'posts'), path.join(root, 'posts', 'sub', 'loop'), 'dir')
      const rel = (await discover('posts', root)).map((f) => f.relPath)
      expect(rel).toEqual(['posts/sub/a.md'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('throws for a missing directory, naming it', async () => {
    await expect(discover('does-not-exist', cwd)).rejects.toThrow(/does-not-exist/)
  })

  it('throws when dir is a file', async () => {
    await expect(discover('posts/a.md', cwd)).rejects.toThrow(/not a directory/)
  })

  it('isIgnoredName', () => {
    expect(isIgnoredName('_draft.md')).toBe(true)
    expect(isIgnoredName('.hidden.md')).toBe(true)
    expect(isIgnoredName('node_modules')).toBe(true)
    expect(isIgnoredName('hello.md')).toBe(false)
    expect(isIgnoredName('node_modules_notes.md')).toBe(false)
  })
})

describe('keyRoot', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'post-together-keyroot-'))
    await mkdir(path.join(root, 'repo', '.git'), { recursive: true })
    await mkdir(path.join(root, 'repo', 'posts', 'nested'), { recursive: true })
    await mkdir(path.join(root, 'loose', 'posts'), { recursive: true })
    // A worktree or submodule has a .git file instead of a directory.
    await mkdir(path.join(root, 'repo', 'sub', 'posts'), { recursive: true })
    await writeFile(path.join(root, 'repo', 'sub', '.git'), 'gitdir: ../.git/modules/sub\n')
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('is the nearest ancestor of dir that contains .git, whatever the cwd', async () => {
    const repo = path.join(root, 'repo')
    expect(await keyRoot('posts', repo)).toBe(repo)
    expect(await keyRoot('.', path.join(repo, 'posts'))).toBe(repo)
    expect(await keyRoot('nested', path.join(repo, 'posts'))).toBe(repo)
  })

  it('accepts a .git file', async () => {
    expect(await keyRoot('posts', path.join(root, 'repo', 'sub'))).toBe(path.join(root, 'repo', 'sub'))
  })

  it('falls back to cwd outside a git work tree', async () => {
    const loose = path.join(root, 'loose')
    expect(await keyRoot('posts', loose)).toBe(loose)
  })
})
