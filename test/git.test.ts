import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitState, gitIdentity } from '../src/git.js'
import type { Logger } from '../src/types.js'

const exec = promisify(execFile)

let root: string
let repo: string
let remote: string
let logs: Record<'info' | 'warn' | 'error' | 'debug', string[]>
let logger: Logger

/**
 * Neutral git environment: no user/system config (so no SSH signing via 1Password)
 * and no inherited identity or CI variables. `undefined` removes an inherited key.
 */
function gitEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: root,
    GITHUB_ACTIONS: undefined,
    GIT_AUTHOR_NAME: undefined,
    GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined,
    GIT_COMMITTER_EMAIL: undefined,
    ...extra,
  }
}

function fullEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...gitEnv(extra) })) if (v !== undefined) env[k] = v
  return env
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const base = ['-c', 'commit.gpgsign=false', '-c', 'user.name=setup', '-c', 'user.email=setup@example.com']
  const { stdout } = await exec('git', [...base, ...args], { cwd, env: fullEnv() })
  return stdout.trim()
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'post-together-git-'))
  repo = path.join(root, 'repo')
  remote = path.join(root, 'remote.git')
  await mkdir(repo)
  await git(root, 'init', '-q', '--bare', remote)
  await git(repo, '-c', 'init.defaultBranch=main', 'init', '-q')
  await git(repo, 'remote', 'add', 'origin', remote)
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  await git(repo, 'push', '-q', '-u', 'origin', 'main')
  logs = { info: [], warn: [], error: [], debug: [] }
  logger = {
    info: (m) => logs.info.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
    debug: (m) => logs.debug.push(m),
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('gitIdentity', () => {
  it('prefers GIT_AUTHOR_*, then the GitHub bot, then post-together', () => {
    expect(gitIdentity({ GIT_AUTHOR_NAME: 'Me', GIT_AUTHOR_EMAIL: 'me@example.com', GITHUB_ACTIONS: 'true' })).toEqual({ name: 'Me', email: 'me@example.com' })
    expect(gitIdentity({ GITHUB_ACTIONS: 'true' })).toEqual({ name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' })
    expect(gitIdentity({})).toEqual({ name: 'post-together', email: 'post-together@users.noreply.tangled.org' })
    expect(gitIdentity({ GIT_AUTHOR_NAME: 'Only name' })).toEqual({ name: 'post-together', email: 'post-together@users.noreply.tangled.org' })
  })
})

describe('commitState', () => {
  it('adds, commits with the default identity and pushes the state file', async () => {
    const file = path.join(repo, 'posts', '.post-together.json')
    await mkdir(path.dirname(file))
    await writeFile(file, '{"version":1,"posts":{}}\n')
    const result = await commitState({ cwd: repo, file, message: 'chore: record posted files', logger, env: gitEnv() })
    expect(result).toEqual({ committed: true, pushed: true })
    expect(await git(repo, 'log', '-1', '--format=%s|%an <%ae>|%cn')).toBe('chore: record posted files|post-together <post-together@users.noreply.tangled.org>|post-together')
    expect(await git(repo, 'show', '--stat', '--format=', 'HEAD')).toContain('.post-together.json')
    expect(await git(remote, 'log', '-1', '--format=%s', 'main')).toBe('chore: record posted files')
    expect(logs.warn).toEqual([])
  })

  it('uses the GitHub bot identity under GITHUB_ACTIONS and GIT_AUTHOR_* when set', async () => {
    const file = path.join(repo, 'state.json')
    await writeFile(file, '{}\n')
    await commitState({ cwd: repo, file, message: 'm', logger, env: gitEnv({ GITHUB_ACTIONS: 'true' }) })
    expect(await git(repo, 'log', '-1', '--format=%an <%ae>')).toBe('github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>')

    await writeFile(file, '{"v":2}\n')
    await commitState({ cwd: repo, file, message: 'm2', logger, env: gitEnv({ GIT_AUTHOR_NAME: 'Custom', GIT_AUTHOR_EMAIL: 'custom@example.com' }) })
    expect(await git(repo, 'log', '-1', '--format=%an <%ae>')).toBe('Custom <custom@example.com>')
  })

  it('does nothing when the state file has no changes', async () => {
    const file = path.join(repo, 'state.json')
    await writeFile(file, '{}\n')
    await commitState({ cwd: repo, file, message: 'first', logger, env: gitEnv() })
    const head = await git(repo, 'rev-parse', 'HEAD')
    const result = await commitState({ cwd: repo, file, message: 'second', logger, env: gitEnv() })
    expect(result).toEqual({ committed: false, pushed: false })
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(logs.info.some((m) => m.includes('no changes'))).toBe(true)
  })

  it('warns and skips outside a git repository', async () => {
    const outside = path.join(root, 'plain')
    await mkdir(outside)
    const file = path.join(outside, 'state.json')
    await writeFile(file, '{}\n')
    const result = await commitState({ cwd: outside, file, message: 'm', logger, env: gitEnv() })
    expect(result).toEqual({ committed: false, pushed: false })
    expect(logs.warn.join('\n')).toMatch(/not inside a git work tree/)
  })

  it('warns and skips on a detached HEAD', async () => {
    await git(repo, 'checkout', '-q', '--detach')
    const file = path.join(repo, 'state.json')
    await writeFile(file, '{}\n')
    const result = await commitState({ cwd: repo, file, message: 'm', logger, env: gitEnv() })
    expect(result).toEqual({ committed: false, pushed: false })
    expect(logs.warn.join('\n')).toMatch(/detached/)
  })

  it('keeps the commit and warns when push fails', async () => {
    await git(repo, 'remote', 'remove', 'origin')
    const file = path.join(repo, 'state.json')
    await writeFile(file, '{}\n')
    const result = await commitState({ cwd: repo, file, message: 'local only', logger, env: gitEnv() })
    expect(result).toEqual({ committed: true, pushed: false })
    expect(await git(repo, 'log', '-1', '--format=%s')).toBe('local only')
    expect(logs.warn.join('\n')).toMatch(/git push failed/)
  })

  it('never throws when git itself fails', async () => {
    const file = path.join(repo, 'state.json')
    await writeFile(file, '{}\n')
    const result = await commitState({ cwd: repo, file, message: 'm', logger, env: gitEnv({ PATH: path.join(root, 'nowhere') }) })
    expect(result).toEqual({ committed: false, pushed: false })
    expect(logs.warn.length).toBeGreaterThan(0)
  })
})
