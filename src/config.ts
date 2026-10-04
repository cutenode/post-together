/**
 * Option resolution. See docs/SPEC.md §4.
 *
 * Three layers, later wins: `INPUT_*` (GitHub Action inputs) < environment
 * variables (`POST_TOGETHER_*`, `BSKY_*`) < CLI flags. `resolveOptions` is pure
 * so it can be tested with a hand-built env.
 */
import path from 'node:path'
import type { Logger, RunOptions } from './types.js'

/** A problem with how the tool was invoked (exit code 2 in the CLI). */
export class UsageError extends Error {
  override name = 'UsageError'
}

export const DEFAULT_DIR = 'posts'
export const DEFAULT_SERVICE = 'https://bsky.social'
export const DEFAULT_COMMIT_MESSAGE = 'chore: record posted files'
export const STATE_FILE_NAME = '.post-together.json'

/** Raw flag values as `parseArgs` produces them (strings and booleans). */
export interface RawFlags {
  dir?: string | undefined
  stateFile?: string | undefined
  identifier?: string | undefined
  password?: string | undefined
  service?: string | undefined
  dryRun?: boolean | string | undefined
  limit?: number | string | undefined
  linkCards?: boolean | string | undefined
  threadCounter?: boolean | string | undefined
  commit?: boolean | string | undefined
  commitMessage?: string | undefined
  cwd?: string | undefined
  mode?: string | undefined
}

/** Fully resolved options: every field has a value except the credentials. */
export interface ResolvedOptions {
  dir: string
  stateFile: string
  identifier: string | undefined
  password: string | undefined
  service: string
  dryRun: boolean
  limit: number
  linkCards: boolean
  threadCounter: boolean
  commit: boolean
  commitMessage: string
  cwd: string
  mode: 'post' | 'init'
}

export type Env = Record<string, string | undefined>

/** Parse `true|false|1|0|yes|no` case-insensitively; anything else is a usage error. */
export function parseBoolean(value: string | boolean | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  const v = value.trim().toLowerCase()
  if (v === '') return undefined
  if (v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  throw new UsageError(`${name} must be one of true, false, 1, 0, yes, no (got ${JSON.stringify(value)})`)
}

/** Parse a non-negative integer; anything else is a usage error. */
export function parseLimit(value: string | number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new UsageError(`${name} must be a non-negative integer (got ${value})`)
    return value
  }
  const v = value.trim()
  if (v === '') return undefined
  if (!/^\d+$/.test(v)) throw new UsageError(`${name} must be a non-negative integer (got ${JSON.stringify(value)})`)
  return Number.parseInt(v, 10)
}

export function parseMode(value: string | undefined, name: string): 'post' | 'init' | undefined {
  if (value === undefined) return undefined
  const v = value.trim().toLowerCase()
  if (v === '') return undefined
  if (v === 'post' || v === 'init') return v
  throw new UsageError(`${name} must be post or init (got ${JSON.stringify(value)})`)
}

/** GitHub Action inputs arrive as `INPUT_<NAME>`: uppercased, hyphens kept. */
function inputEnv(env: Env, name: string): string | undefined {
  const raw = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`]
  if (raw === undefined) return undefined
  const v = raw.trim()
  return v === '' ? undefined : v
}

function plainEnv(env: Env, name: string): string | undefined {
  const raw = env[name]
  if (raw === undefined) return undefined
  const v = raw.trim()
  return v === '' ? undefined : v
}

function first<T>(...values: (T | undefined)[]): T | undefined {
  for (const v of values) if (v !== undefined) return v
  return undefined
}

/**
 * Resolve options from CLI flags, the environment (`POST_TOGETHER_*`, `BSKY_*`),
 * GitHub Action inputs (`INPUT_*`) and defaults, in that order of precedence.
 */
export function resolveOptions(flags: RawFlags, env: Env): ResolvedOptions {
  const str = (flag: string | undefined, envName: string | undefined, inputName: string): string | undefined =>
    first(
      flag === undefined || flag === '' ? undefined : flag,
      envName ? plainEnv(env, envName) : undefined,
      inputEnv(env, inputName),
    )

  const bool = (flag: boolean | string | undefined, flagName: string, envName: string, inputName: string): boolean | undefined =>
    first(
      parseBoolean(flag, flagName),
      parseBoolean(plainEnv(env, envName), envName),
      parseBoolean(inputEnv(env, inputName), `input ${inputName}`),
    )

  const cwd = path.resolve(str(flags.cwd, undefined, 'cwd') ?? process.cwd())
  const dir = str(flags.dir, 'POST_TOGETHER_DIR', 'dir') ?? DEFAULT_DIR
  const limit = first(
    parseLimit(flags.limit, '--limit'),
    parseLimit(plainEnv(env, 'POST_TOGETHER_LIMIT'), 'POST_TOGETHER_LIMIT'),
    parseLimit(inputEnv(env, 'limit'), 'input limit'),
  ) ?? 0
  const mode = first(
    parseMode(flags.mode, 'mode'),
    parseMode(plainEnv(env, 'POST_TOGETHER_MODE'), 'POST_TOGETHER_MODE'),
    parseMode(inputEnv(env, 'mode'), 'input mode'),
  ) ?? 'post'

  return {
    dir,
    stateFile: str(flags.stateFile, 'POST_TOGETHER_STATE_FILE', 'state-file') ?? defaultStateFile(dir),
    identifier: str(flags.identifier, 'BSKY_IDENTIFIER', 'identifier'),
    password: str(flags.password, 'BSKY_APP_PASSWORD', 'app-password'),
    service: str(flags.service, 'BSKY_SERVICE', 'service') ?? DEFAULT_SERVICE,
    dryRun: bool(flags.dryRun, '--dry-run', 'POST_TOGETHER_DRY_RUN', 'dry-run') ?? false,
    limit,
    linkCards: bool(flags.linkCards, '--link-cards', 'POST_TOGETHER_LINK_CARDS', 'link-cards') ?? true,
    threadCounter: bool(flags.threadCounter, '--thread-counter', 'POST_TOGETHER_THREAD_COUNTER', 'thread-counter') ?? false,
    commit: bool(flags.commit, '--commit', 'POST_TOGETHER_COMMIT', 'commit') ?? false,
    commitMessage: str(flags.commitMessage, 'POST_TOGETHER_COMMIT_MESSAGE', 'commit-message') ?? DEFAULT_COMMIT_MESSAGE,
    cwd,
    mode,
  }
}

export function defaultStateFile(dir: string): string {
  return path.join(dir, STATE_FILE_NAME)
}

/** Fill in defaults for a programmatic `RunOptions` object (the library entry point). */
export function withDefaults(options: RunOptions): ResolvedOptions {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const dir = options.dir ?? DEFAULT_DIR
  const limit = options.limit ?? 0
  if (!Number.isInteger(limit) || limit < 0) throw new UsageError(`limit must be a non-negative integer (got ${limit})`)
  const mode = options.mode ?? 'post'
  if (mode !== 'post' && mode !== 'init') throw new UsageError(`mode must be post or init (got ${JSON.stringify(mode)})`)
  return {
    dir,
    stateFile: options.stateFile ?? defaultStateFile(dir),
    identifier: options.identifier,
    password: options.password,
    service: options.service ?? DEFAULT_SERVICE,
    dryRun: options.dryRun ?? false,
    limit,
    linkCards: options.linkCards ?? true,
    threadCounter: options.threadCounter ?? false,
    commit: options.commit ?? false,
    commitMessage: options.commitMessage ?? DEFAULT_COMMIT_MESSAGE,
    cwd,
    mode,
  }
}

/** Turn resolved options back into a `RunOptions` object (for surfaces calling `run`). */
export function toRunOptions(resolved: ResolvedOptions, logger?: Logger): RunOptions {
  const out: RunOptions = {
    dir: resolved.dir,
    stateFile: resolved.stateFile,
    service: resolved.service,
    dryRun: resolved.dryRun,
    limit: resolved.limit,
    linkCards: resolved.linkCards,
    threadCounter: resolved.threadCounter,
    commit: resolved.commit,
    commitMessage: resolved.commitMessage,
    cwd: resolved.cwd,
    mode: resolved.mode,
  }
  if (resolved.identifier !== undefined) out.identifier = resolved.identifier
  if (resolved.password !== undefined) out.password = resolved.password
  if (logger) out.logger = logger
  return out
}

/** A loggable view of the options with the password masked. */
export function describeOptions(resolved: ResolvedOptions): string {
  const view = { ...resolved, password: resolved.password === undefined ? undefined : '***' }
  return Object.entries(view)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ')
}
