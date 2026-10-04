/**
 * State file handling. See docs/SPEC.md §7.7.
 *
 * The file records, per Markdown file (keyed by posix relPath), the hash that was
 * posted, the account DID, the reserved record keys/URIs and the CIDs confirmed on
 * the PDS. Writes are atomic (temp file + rename) and happen after every change.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { State, StateEntry } from './types.js'

export function emptyState(): State {
  return { version: 1, posts: {} }
}

/** `'none'` disables the state file; otherwise resolve relative to `cwd`. */
export function resolveStatePath(stateFile: string, cwd: string): string | null {
  if (stateFile.trim().toLowerCase() === 'none') return null
  return path.resolve(cwd, stateFile)
}

/** An entry is complete when `postedAt` is set and every post has a cid (`posts: []` counts). */
export function isComplete(entry: StateEntry): boolean {
  return entry.postedAt !== undefined && entry.posts.every((p) => p.cid !== undefined)
}

/** Read a state file. A missing file is an empty state; a wrong version is an error. */
export async function readState(file: string): Promise<State> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`state file ${file} is not valid JSON: ${(err as Error).message}`)
  }
  return validateState(parsed, file)
}

function validateState(parsed: unknown, file: string): State {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`state file ${file} must contain a JSON object`)
  }
  const obj = parsed as Record<string, unknown>
  if (obj['version'] !== 1) {
    throw new Error(`state file ${file} has unsupported version ${JSON.stringify(obj['version'])} (expected 1)`)
  }
  const posts = obj['posts']
  if (posts === undefined) return { version: 1, posts: {} }
  if (typeof posts !== 'object' || posts === null || Array.isArray(posts)) {
    throw new Error(`state file ${file}: "posts" must be an object`)
  }
  const out: Record<string, StateEntry> = {}
  for (const [key, value] of Object.entries(posts as Record<string, unknown>)) {
    out[key] = validateEntry(value, key, file)
  }
  return { version: 1, posts: out }
}

function validateEntry(value: unknown, key: string, file: string): StateEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`state file ${file}: entry ${JSON.stringify(key)} must be an object`)
  }
  const e = value as Record<string, unknown>
  if (typeof e['hash'] !== 'string') throw new Error(`state file ${file}: entry ${JSON.stringify(key)} is missing "hash"`)
  if (typeof e['did'] !== 'string') throw new Error(`state file ${file}: entry ${JSON.stringify(key)} is missing "did"`)
  if (e['postedAt'] !== undefined && typeof e['postedAt'] !== 'string') {
    throw new Error(`state file ${file}: entry ${JSON.stringify(key)} has a non-string "postedAt"`)
  }
  if (!Array.isArray(e['posts'])) throw new Error(`state file ${file}: entry ${JSON.stringify(key)} is missing "posts"`)
  const posts = (e['posts'] as unknown[]).map((p, i) => {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      throw new Error(`state file ${file}: entry ${JSON.stringify(key)} post ${i} must be an object`)
    }
    const r = p as Record<string, unknown>
    if (typeof r['rkey'] !== 'string' || typeof r['uri'] !== 'string') {
      throw new Error(`state file ${file}: entry ${JSON.stringify(key)} post ${i} needs "rkey" and "uri"`)
    }
    if (r['cid'] !== undefined && typeof r['cid'] !== 'string') {
      throw new Error(`state file ${file}: entry ${JSON.stringify(key)} post ${i} has a non-string "cid"`)
    }
    return r['cid'] === undefined ? { rkey: r['rkey'], uri: r['uri'] } : { rkey: r['rkey'], uri: r['uri'], cid: r['cid'] }
  })
  const entry: StateEntry = { hash: e['hash'], did: e['did'], posts }
  if (typeof e['postedAt'] === 'string') entry.postedAt = e['postedAt']
  return entry
}

/** Serialise deterministically: sorted keys, two-space indent, trailing newline. */
export function serializeState(state: State): string {
  const posts: Record<string, StateEntry> = {}
  for (const key of Object.keys(state.posts).sort()) {
    const entry = state.posts[key]
    if (entry) posts[key] = entry
  }
  return JSON.stringify({ version: 1, posts }, null, 2) + '\n'
}

/** Atomic write: temp file in the same directory, then rename over the target. */
export async function writeState(file: string, state: State): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(tmp, serializeState(state), 'utf8')
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * In-memory view of the state with write-through persistence. When `path` is
 * null (`stateFile: 'none'`), changes are kept in memory only.
 */
export class StateStore {
  /** True once a `set` changed what would be written to disk. */
  changed = false

  private constructor(
    readonly path: string | null,
    readonly state: State,
  ) {}

  static async open(file: string | null): Promise<StateStore> {
    const state = file === null ? emptyState() : await readState(file)
    return new StateStore(file, state)
  }

  get(relPath: string): StateEntry | undefined {
    return this.state.posts[relPath]
  }

  /** Record an entry and persist immediately when a state file is configured. */
  async set(relPath: string, entry: StateEntry): Promise<void> {
    this.state.posts[relPath] = entry
    this.changed = true
    if (this.path !== null) await writeState(this.path, this.state)
  }
}
