import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export interface DiscoveredFile {
  /** Absolute path. */
  path: string
  /** Posix path relative to the key root (see `keyRoot`). */
  relPath: string
}

/** Names that are never scanned: `_*`, `.*` and `node_modules`, whether file or directory. */
export function isIgnoredName(name: string): boolean {
  return name.startsWith('_') || name.startsWith('.') || name === 'node_modules'
}

export function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep)
}

/**
 * The directory that state keys and record keys are relative to (SPEC §7.1): the nearest
 * ancestor of `dir` (resolved against `cwd`, inclusive) that contains a `.git` entry, so the
 * keys are the same whichever directory the tool is run from. Outside a git work tree, `cwd`.
 */
export async function keyRoot(dir: string, cwd: string): Promise<string> {
  let current = path.resolve(cwd, dir)
  for (;;) {
    try {
      await stat(path.join(current, '.git'))
      return current
    } catch {
      // not here; keep walking up
    }
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(cwd)
    current = parent
  }
}

/**
 * Recursively find `*.md` files under `dir` (resolved against `cwd`), sorted by relPath.
 * `relPath` is relative to `root` (default `cwd`). Skips names starting with `_` or `.`
 * and any `node_modules` directory, and never enters the same directory twice, so a
 * symlink loop ends (SPEC §7.1).
 */
export async function discover(dir: string, cwd: string, root: string = cwd): Promise<DiscoveredFile[]> {
  const start = path.resolve(cwd, dir)
  let info
  try {
    info = await stat(start)
  } catch {
    throw new Error(`directory not found: ${dir} (resolved to ${start})`)
  }
  if (!info.isDirectory()) throw new Error(`not a directory: ${dir} (resolved to ${start})`)

  const found: DiscoveredFile[] = []
  await walk(start, path.resolve(cwd, root), found, new Set())
  found.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  return found
}

async function walk(dirPath: string, root: string, out: DiscoveredFile[], seen: Set<string>): Promise<void> {
  const real = await realpath(dirPath)
  if (seen.has(real)) return
  seen.add(real)
  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (isIgnoredName(entry.name)) continue
    const abs = path.join(dirPath, entry.name)
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const target = await stat(abs)
        isDir = target.isDirectory()
        isFile = target.isFile()
      } catch {
        continue // dangling symlink
      }
    }
    if (isDir) {
      await walk(abs, root, out, seen)
    } else if (isFile && path.extname(entry.name).toLowerCase() === '.md') {
      out.push({ path: abs, relPath: toPosix(path.relative(root, abs)) })
    }
  }
}
