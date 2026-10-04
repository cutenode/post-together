/**
 * Commit the state file back to the repository. See docs/SPEC.md §7.8.
 *
 * Every failure here is a warning, never an error: the posts were already made,
 * so the run still succeeds. Skips when not in a git repository, on a detached
 * HEAD, or when the state file has no changes; a failed push leaves the commit
 * local and warns.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { Logger } from './types.js'

export interface GitIdentity {
  name: string
  email: string
}

export interface CommitOptions {
  cwd: string
  /** State file path (absolute or relative to `cwd`). */
  file: string
  message: string
  logger: Logger
  /** Extra environment for the git processes (tests set GIT_CONFIG_GLOBAL etc.). */
  env?: Record<string, string | undefined>
}

export interface CommitResult {
  committed: boolean
  pushed: boolean
}

/** Author/committer identity per SPEC §7.8. */
export function gitIdentity(env: Record<string, string | undefined>): GitIdentity {
  const name = env['GIT_AUTHOR_NAME']?.trim()
  const email = env['GIT_AUTHOR_EMAIL']?.trim()
  if (name && email) return { name, email }
  if (env['GITHUB_ACTIONS'] === 'true') {
    return { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' }
  }
  return { name: 'post-together', email: 'post-together@users.noreply.tangled.org' }
}

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

function git(args: string[], cwd: string, env: Record<string, string | undefined>): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const code = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as { code: number }).code : 127
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || error.message })
      } else {
        resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    })
  })
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? ''
}

/** `git add`, `git commit`, `git push` the state file. Never throws. */
export async function commitState(opts: CommitOptions): Promise<CommitResult> {
  const { logger, cwd, message } = opts
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) if (v !== undefined) env[k] = v
  const file = path.resolve(cwd, opts.file)
  const none: CommitResult = { committed: false, pushed: false }

  const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd, env)
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    logger.warn(`commit skipped: ${cwd} is not inside a git work tree`)
    return none
  }
  const head = await git(['symbolic-ref', '-q', 'HEAD'], cwd, env)
  if (head.code !== 0) {
    logger.warn('commit skipped: HEAD is detached (no branch to push)')
    return none
  }
  const add = await git(['add', '--', file], cwd, env)
  if (add.code !== 0) {
    logger.warn(`commit skipped: git add failed: ${firstLine(add.stderr)}`)
    return none
  }
  const diff = await git(['diff', '--cached', '--quiet', '--', file], cwd, env)
  if (diff.code === 0) {
    logger.info('commit skipped: the state file has no changes')
    return none
  }
  if (diff.code !== 1) {
    logger.warn(`commit skipped: git diff failed: ${firstLine(diff.stderr)}`)
    return none
  }
  const identity = gitIdentity(env)
  const commit = await git(
    ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '-m', message, '--', file],
    cwd,
    env,
  )
  if (commit.code !== 0) {
    logger.warn(`commit failed: ${firstLine(commit.stderr) || firstLine(commit.stdout)}`)
    return none
  }
  logger.info(`committed ${path.relative(cwd, file) || file}: ${message}`)
  const push = await git(['push'], cwd, env)
  if (push.code !== 0) {
    logger.warn(`git push failed (the commit is local only): ${firstLine(push.stderr)}`)
    return { committed: true, pushed: false }
  }
  logger.info('pushed the state file')
  return { committed: true, pushed: true }
}
