import YAML from 'yaml'
import type { Frontmatter } from './types.js'

export interface SplitFrontmatter {
  frontmatter: Frontmatter
  /**
   * The Markdown body. The frontmatter block is replaced by the same number of blank
   * lines so that mdast line numbers match the source file.
   */
  body: string
  /** Number of source lines the frontmatter block occupied (0 when there is none). */
  lines: number
}

const KNOWN_KEYS = ['draft', 'langs', 'createdAt', 'link', 'thread'] as const
const THREAD_MODES = ['auto', 'manual', 'off'] as const
const MAX_LANGS = 3

/**
 * Split optional YAML frontmatter (between `---` fences at the very top) from the body.
 * `source` must already have `\n` line endings. `file` is used in error messages only.
 */
export function splitFrontmatter(source: string, file: string): SplitFrontmatter {
  const lines = source.split('\n')
  if (lines.length === 0 || lines[0]?.trimEnd() !== '---') {
    return { frontmatter: {}, body: source, lines: 0 }
  }
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trimEnd() === '---') {
      close = i
      break
    }
  }
  if (close === -1) {
    throw new Error(`${file}: frontmatter opened with --- on line 1 but never closed`)
  }
  const yamlText = lines.slice(1, close).join('\n')
  const frontmatter = parseFrontmatter(yamlText, file)
  const consumed = close + 1
  const body = '\n'.repeat(consumed) + lines.slice(consumed).join('\n')
  return { frontmatter, body, lines: consumed }
}

/** Parse and validate a frontmatter YAML document. Empty text yields `{}`. */
export function parseFrontmatter(yamlText: string, file: string): Frontmatter {
  let value: unknown
  try {
    value = YAML.parse(yamlText)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${file}: invalid frontmatter YAML: ${msg}`)
  }
  return validateFrontmatter(value, file)
}

/** Validate a decoded YAML value against the SPEC §5 frontmatter contract. */
export function validateFrontmatter(value: unknown, file: string): Frontmatter {
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file}: frontmatter must be a YAML mapping`)
  }
  const record = value as Record<string, unknown>
  const out: Frontmatter = {}

  for (const key of Object.keys(record)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${file}: unknown frontmatter key "${key}" (allowed: ${KNOWN_KEYS.join(', ')})`)
    }
  }

  if ('draft' in record) {
    const draft = record['draft']
    if (typeof draft !== 'boolean') throw badType(file, 'draft', 'a boolean', draft)
    out.draft = draft
  }

  if ('langs' in record) {
    const langs = record['langs']
    if (!Array.isArray(langs) || !langs.every((l) => typeof l === 'string' && l.trim().length > 0)) {
      throw badType(file, 'langs', `an array of up to ${MAX_LANGS} BCP-47 language codes`, langs)
    }
    if (langs.length > MAX_LANGS) {
      throw new Error(`${file}: frontmatter key "langs" has ${langs.length} entries (max ${MAX_LANGS})`)
    }
    if (langs.length > 0) out.langs = langs.map((l) => (l as string).trim())
  }

  if ('createdAt' in record) {
    const raw = record['createdAt']
    let date: Date | undefined
    if (raw instanceof Date) date = raw
    else if (typeof raw === 'string' && raw.trim()) date = new Date(raw.trim())
    if (!date || Number.isNaN(date.getTime())) {
      throw badType(file, 'createdAt', 'an ISO-8601 date-time', raw)
    }
    out.createdAt = date.toISOString()
  }

  if ('link' in record) {
    const link = record['link']
    if (link === false) out.link = false
    else if (link === 'auto') out.link = 'auto'
    else if (typeof link === 'string' && isHttpUrl(link)) out.link = link
    else throw badType(file, 'link', 'an http(s) URL, "auto" or false', link)
  }

  if ('thread' in record) {
    const thread = record['thread']
    if (!isThreadMode(thread)) {
      throw badType(file, 'thread', `one of ${THREAD_MODES.join(', ')}`, thread)
    }
    out.thread = thread
  }

  return out
}

function isThreadMode(value: unknown): value is (typeof THREAD_MODES)[number] {
  return typeof value === 'string' && (THREAD_MODES as readonly string[]).includes(value)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function badType(file: string, key: string, expected: string, actual: unknown): Error {
  let shown: string
  try {
    shown = JSON.stringify(actual) ?? String(actual)
  } catch {
    shown = String(actual)
  }
  return new Error(`${file}: frontmatter key "${key}" must be ${expected}, got ${shown}`)
}
