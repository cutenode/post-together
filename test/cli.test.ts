import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'src', 'cli.ts')
/** tsx's ESM hook, resolved from the project so it works from any cwd. */
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

interface Result {
  code: number
  stdout: string
  stderr: string
}

/** Run the CLI from source through tsx with a clean environment. */
function cli(args: string[], env: Record<string, string> = {}, cwd = ROOT): Promise<Result> {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(POST_TOGETHER_|BSKY_|INPUT_|GITHUB_)/.test(k)) clean[k] = v
  }
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', TSX, CLI, ...args], { cwd, env: { ...clean, ...env } }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'post-together-cli-'))
  await mkdir(path.join(tmp, 'posts'))
  await writeFile(path.join(tmp, 'posts', 'hello.md'), '# Hello\n\nA post with a #tag and https://example.com/page\n')
  await writeFile(path.join(tmp, 'posts', 'thread.md'), 'First\n\n---\n\nSecond\n')
})
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('cli', () => {
  it('prints usage with --help and exits 0', async () => {
    const r = await cli(['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Usage: post-together')
    expect(r.stdout).toContain('--dry-run')
    expect(r.stdout).toContain('render <file>')
  })

  it('prints the package version with --version', async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }
    const r = await cli(['--version'])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe(pkg.version)
  })

  it('exits 2 on unknown flags, unknown commands and bad values', async () => {
    const unknownFlag = await cli(['--bogus'])
    expect(unknownFlag.code).toBe(2)
    expect(unknownFlag.stderr).toMatch(/^error: /m)
    expect(unknownFlag.stderr).toContain('--help')

    const unknownCommand = await cli(['frobnicate'])
    expect(unknownCommand.code).toBe(2)
    expect(unknownCommand.stderr).toContain('frobnicate')

    const renderWithoutFile = await cli(['render'])
    expect(renderWithoutFile.code).toBe(2)

    const badLimit = await cli(['--limit', 'lots', '--dry-run'], {}, tmp)
    expect(badLimit.code).toBe(2)
    expect(badLimit.stderr).toContain('--limit')

    const badEnv = await cli(['--dry-run'], { POST_TOGETHER_DRY_RUN: 'maybe' }, tmp)
    expect(badEnv.code).toBe(2)
    expect(badEnv.stderr).toContain('POST_TOGETHER_DRY_RUN')
  })

  it('dry-run prints every rendered post and never emits workflow commands', async () => {
    const r = await cli(['--dry-run', '--dir', 'posts', '--state-file', 'none'], {}, tmp)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('posts/hello.md (1 post)')
    expect(r.stdout).toContain('posts/thread.md (2 posts)')
    expect(r.stdout).toMatch(/graphemes, \d+ bytes/)
    expect(r.stdout).toContain('| Second')
    expect(r.stdout).toContain('facets:')
    expect(r.stdout).toMatch(/dry run/)
    expect(r.stdout + r.stderr).not.toContain('::')
  })

  it('reads directory and dry-run from the environment and INPUT_* fallbacks', async () => {
    const fromEnv = await cli([], { POST_TOGETHER_DRY_RUN: 'yes', POST_TOGETHER_DIR: 'posts', POST_TOGETHER_STATE_FILE: 'none' }, tmp)
    expect(fromEnv.code).toBe(0)
    expect(fromEnv.stdout).toContain('posts/hello.md')

    const fromInputs = await cli([], { 'INPUT_DRY-RUN': 'true', 'INPUT_DIR': 'posts', 'INPUT_STATE-FILE': 'none' }, tmp)
    expect(fromInputs.code).toBe(0)
    expect(fromInputs.stdout).toContain('posts/thread.md')
  })

  it('render <file> prints the rendered posts as JSON without touching the network', async () => {
    const r = await cli(['render', 'posts/thread.md'], {}, tmp)
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout) as { file: string; posts: { text: string; graphemes: number }[] }
    expect(out.file).toBe('posts/thread.md')
    expect(out.posts.map((p) => p.text)).toEqual(['First', 'Second'])
    expect(out.posts[0]!.graphemes).toBe(5)
  })

  it('exits 2 with a hint when credentials are missing for a real run', async () => {
    const r = await cli(['--dir', 'posts', '--state-file', 'none'], {}, tmp)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('BSKY_IDENTIFIER')
    expect(r.stderr).toContain('--dry-run')
  })

  it('exits 1 when the service cannot be reached', async () => {
    const r = await cli(['--dir', 'posts', '--state-file', 'none', '--service', 'http://127.0.0.1:1', '--identifier', 'x.test', '--password', 'secret-pw'], {}, tmp)
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/^error: /m)
    expect(r.stderr).not.toContain('secret-pw')
  })
})
