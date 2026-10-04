import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export interface DiscoveredFile {
  /** Absolute path. */
  path: string
  /** Posix path relative to cwd. */
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
 * Recursively find `*.md` files under `dir` (resolved against `cwd`), sorted by relPath.
 * Skips names starting with `_` or `.` and any `node_modules` directory (SPEC §7.1).
 */
export async function discover(dir: string, cwd: string): Promise<DiscoveredFile[]> {
  const root = path.resolve(cwd, dir)
  let info
  try {
    info = await stat(root)
  } catch {
    throw new Error(`directory not found: ${dir} (resolved to ${root})`)
  }
  if (!info.isDirectory()) throw new Error(`not a directory: ${dir} (resolved to ${root})`)

  const found: DiscoveredFile[] = []
  await walk(root, cwd, found)
  found.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  return found
}

async function walk(dirPath: string, cwd: string, out: DiscoveredFile[]): Promise<void> {
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
      await walk(abs, cwd, out)
    } else if (isFile && path.extname(entry.name).toLowerCase() === '.md') {
      out.push({ path: abs, relPath: toPosix(path.relative(cwd, abs)) })
    }
  }
}
