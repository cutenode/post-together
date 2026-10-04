import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { toPosix } from './discover.js'
import { splitFrontmatter } from './frontmatter.js'
import { IMAGE_MAX_BYTES } from './types.js'
import type { Block, ImageRef, ParsedFile, Run, Segment } from './types.js'

// mdast node types, derived from the parser so we do not depend on `@types/mdast` directly.
type Root = ReturnType<typeof fromMarkdown>
type RootContent = Root['children'][number]
type NodeOf<T extends RootContent['type']> = Extract<RootContent, { type: T }>
type Paragraph = NodeOf<'paragraph'>
type PhrasingContent = Paragraph['children'][number]
type List = NodeOf<'list'>
type ListItem = NodeOf<'listItem'>
type Blockquote = NodeOf<'blockquote'>
type Definition = NodeOf<'definition'>
type Positioned = { position?: { start: { line: number; offset?: number | undefined }; end: { offset?: number | undefined } } | undefined }

const IMAGE_MIME: Record<string, ImageRef['mime']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

interface PendingImage {
  ref: ImageRef
  url: string
  line: number | undefined
}

interface Ctx {
  /** Posix path relative to cwd, used in error messages. */
  file: string
  /** Directory of the file; image paths resolve against it. */
  dir: string
  /** Body source (frontmatter replaced by blank lines), for raw slices. */
  source: string
  definitions: Map<string, Definition>
  pendingImages: PendingImage[]
}

/** Accumulates inline runs, merging adjacent runs that share the same link (or no link). */
class RunBuilder {
  readonly runs: Run[] = []
  /** Set when an image was just lifted out; the whitespace around it is collapsed to one. */
  afterImage = false
  constructor(readonly images: ImageRef[]) {}

  push(text: string, link?: string): void {
    if (!text) return
    const last = this.runs[this.runs.length - 1]
    if (this.afterImage) {
      this.afterImage = false
      if ((!last || /\s$/.test(last.text)) && /^\s/.test(text)) {
        text = text.replace(/^\s+/, '')
        if (!text) return
      }
    }
    if (last && last.link === link) {
      last.text += text
      return
    }
    this.runs.push(link === undefined ? { text } : { text, link })
  }

  append(runs: Run[]): void {
    for (const r of runs) this.push(r.text, r.link)
  }
}

/**
 * Read and parse one Markdown file: frontmatter, sha256 hash, and segments/blocks/runs.
 * `filePath` resolves against `cwd`; `relPath` is relative to `root` (default `cwd`; see `keyRoot`).
 * Image paths are resolved against the file's directory and validated (existence, size, extension).
 * Throws an Error whose message names the file (and line where possible) on any contract violation.
 */
export async function parseFile(filePath: string, cwd: string, keyRoot: string = cwd): Promise<ParsedFile> {
  const abs = path.resolve(cwd, filePath)
  const relPath = toPosix(path.relative(path.resolve(cwd, keyRoot), abs))

  let raw: Buffer
  try {
    raw = await readFile(abs)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${relPath}: cannot read file: ${msg}`)
  }
  const hash = 'sha256:' + createHash('sha256').update(raw).digest('hex')

  let source = raw.toString('utf8')
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1)
  source = source.replace(/\r\n?/g, '\n')

  const { frontmatter, body } = splitFrontmatter(source, relPath)
  const root = fromMarkdown(body)

  const ctx: Ctx = {
    file: relPath,
    dir: path.dirname(abs),
    source: body,
    definitions: collectDefinitions(root.children),
    pendingImages: [],
  }

  const segments: Segment[] = []
  let current: Segment = { blocks: [] }
  segments.push(current)

  for (const node of root.children) {
    if (node.type === 'thematicBreak') {
      current = { blocks: [] }
      segments.push(current)
      continue
    }
    if (node.type === 'definition') {
      checkFootnoteDefinition(node, ctx)
      continue
    }
    if (node.type === 'html') continue

    const images: ImageRef[] = []
    const builder = new RunBuilder(images)
    renderBlock(node, builder, ctx)
    if (builder.runs.length === 0 && images.length === 0) continue
    const block: Block = { runs: builder.runs, images }
    current.blocks.push(block)
  }

  for (const pending of ctx.pendingImages) await validateImage(pending, ctx)

  return { path: abs, relPath, hash, frontmatter, segments }
}

// ---------------------------------------------------------------------------
// Block-level rendering

function renderBlock(node: RootContent, b: RunBuilder, ctx: Ctx): void {
  switch (node.type) {
    case 'paragraph':
      checkTable(node, ctx)
      renderInlines(node.children, b, ctx, undefined)
      return
    case 'heading':
      renderInlines(node.children, b, ctx, undefined)
      return
    case 'code':
      b.push(node.value)
      return
    case 'list':
      renderList(node, b, ctx, 0)
      return
    case 'listItem':
      renderListItem(node, '- ', 0, b, ctx)
      return
    case 'blockquote':
      renderBlockquote(node, b, ctx)
      return
    case 'html':
    case 'thematicBreak':
    case 'yaml':
      return
    case 'definition':
      checkFootnoteDefinition(node, ctx)
      return
    case 'table':
    case 'tableRow':
    case 'tableCell':
      throw error(ctx, node, 'tables are not supported')
    case 'footnoteDefinition':
      throw error(ctx, node, 'footnotes are not supported')
    default: {
      // Phrasing content or an unknown node at block level: render what we can.
      const other = node as { type: string; children?: unknown; value?: unknown }
      if (Array.isArray(other.children)) {
        renderInlines(other.children as PhrasingContent[], b, ctx, undefined)
      } else if (typeof other.value === 'string') {
        b.push(other.value)
      }
    }
  }
}

/** Render a sequence of blocks into `b`, separating the ones that produce text with `sep`. */
function renderBlocks(nodes: RootContent[], b: RunBuilder, ctx: Ctx, sep: string): void {
  let first = true
  for (const node of nodes) {
    if (node.type === 'definition') {
      checkFootnoteDefinition(node, ctx)
      continue
    }
    const tmp = new RunBuilder(b.images)
    renderBlock(node, tmp, ctx)
    if (tmp.runs.length === 0) continue
    if (!first) b.push(sep)
    first = false
    b.append(tmp.runs)
  }
}

function renderList(list: List, b: RunBuilder, ctx: Ctx, depth: number): void {
  const start = list.ordered ? (list.start ?? 1) : 0
  list.children.forEach((item, i) => {
    const marker = list.ordered ? `${start + i}. ` : '- '
    const prefix = '  '.repeat(depth) + marker
    if (i > 0) b.push('\n')
    renderListItem(item, prefix, depth, b, ctx)
  })
}

function renderListItem(item: ListItem, prefix: string, depth: number, b: RunBuilder, ctx: Ctx): void {
  b.push(prefix)
  let wroteText = false
  for (const child of item.children) {
    if (child.type === 'list') {
      b.push('\n')
      renderList(child, b, ctx, depth + 1)
      continue
    }
    const tmp = new RunBuilder(b.images)
    renderBlock(child, tmp, ctx)
    if (tmp.runs.length === 0) continue
    if (wroteText) b.push('\n' + '  '.repeat(depth + 1))
    b.append(tmp.runs)
    wroteText = true
  }
}

function renderBlockquote(node: Blockquote, b: RunBuilder, ctx: Ctx): void {
  const tmp = new RunBuilder(b.images)
  renderBlocks(node.children, tmp, ctx, '\n\n')
  b.append(prefixLines(tmp.runs, '> ', '>'))
}

/** Prefix every line with `prefix` (`emptyPrefix` for empty lines), keeping link runs intact. */
function prefixLines(runs: Run[], prefix: string, emptyPrefix: string): Run[] {
  const out = new RunBuilder([])
  let atLineStart = true
  for (const run of runs) {
    let buf = ''
    const flush = (): void => {
      if (buf) {
        out.push(buf, run.link)
        buf = ''
      }
    }
    for (let i = 0; i < run.text.length; i++) {
      const ch = run.text.charAt(i)
      if (atLineStart) {
        flush()
        out.push(ch === '\n' ? emptyPrefix : prefix)
        atLineStart = false
      }
      buf += ch
      if (ch === '\n') atLineStart = true
    }
    flush()
  }
  return out.runs
}

// ---------------------------------------------------------------------------
// Inline rendering

function renderInlines(nodes: PhrasingContent[], b: RunBuilder, ctx: Ctx, link: string | undefined): void {
  for (const node of nodes) renderInline(node, b, ctx, link)
}

function renderInline(node: PhrasingContent, b: RunBuilder, ctx: Ctx, link: string | undefined): void {
  switch (node.type) {
    case 'text':
      // Without GFM, `[^id]` references and `[^id]: note` definitions arrive as plain text.
      if (FOOTNOTE_RE.test(node.value)) throw error(ctx, node, 'footnotes are not supported')
      b.push(stripStrikethrough(node.value), link)
      return
    case 'emphasis':
    case 'strong':
    case 'delete':
      renderInlines(node.children, b, ctx, link)
      return
    case 'inlineCode':
      b.push(node.value, link)
      return
    case 'break':
      b.push('\n', link)
      return
    case 'html':
      return
    case 'link':
      renderInlines(node.children, b, ctx, checkLinkUrl(node.url, node, ctx))
      return
    case 'linkReference': {
      if (node.identifier.startsWith('^')) throw error(ctx, node, 'footnotes are not supported')
      const def = ctx.definitions.get(node.identifier)
      renderInlines(node.children, b, ctx, def ? checkLinkUrl(def.url, node, ctx) : link)
      return
    }
    case 'image':
      addImage(node.url, node.alt ?? '', node, b, ctx)
      return
    case 'imageReference': {
      if (node.identifier.startsWith('^')) throw error(ctx, node, 'footnotes are not supported')
      const def = ctx.definitions.get(node.identifier)
      if (def) addImage(def.url, node.alt ?? '', node, b, ctx)
      return
    }
    case 'footnoteReference':
      throw error(ctx, node, 'footnotes are not supported')
    default: {
      const other = node as { type: string; children?: unknown; value?: unknown }
      if (Array.isArray(other.children)) {
        renderInlines(other.children as PhrasingContent[], b, ctx, link)
      } else if (typeof other.value === 'string') {
        b.push(other.value, link)
      }
    }
  }
}

const FOOTNOTE_RE = /\[\^[^\]\s]+\]/

/** Without the GFM extension `~~text~~` stays literal; render it as its inner text (SPEC §5). */
function stripStrikethrough(text: string): string {
  return text.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1')
}

function checkLinkUrl(url: string, node: Positioned, ctx: Ctx): string {
  try {
    new URL(url)
  } catch {
    throw error(ctx, node, `link "${url}" is not an absolute URL`)
  }
  return url
}

// ---------------------------------------------------------------------------
// Images

function addImage(url: string, alt: string, node: Positioned, b: RunBuilder, ctx: Ctx): void {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    throw error(ctx, node, `remote images are not supported: ${url} (use a path relative to the file)`)
  }
  const abs = path.resolve(ctx.dir, safeDecode(url))
  const mime = IMAGE_MIME[path.extname(abs).toLowerCase()]
  if (!mime) {
    throw error(ctx, node, `unsupported image type "${url}" (expected .png, .jpg, .jpeg, .webp or .gif)`)
  }
  const ref: ImageRef = { path: abs, alt, mime }
  ctx.pendingImages.push({ ref, url, line: node.position?.start.line })
  b.images.push(ref)
  b.afterImage = true
}

async function validateImage(pending: PendingImage, ctx: Ctx): Promise<void> {
  const where = pending.line === undefined ? ctx.file : `${ctx.file}:${pending.line}`
  let info
  try {
    info = await stat(pending.ref.path)
  } catch {
    throw new Error(`${where}: image not found: ${pending.url} (resolved to ${pending.ref.path})`)
  }
  if (!info.isFile()) throw new Error(`${where}: image is not a file: ${pending.url} (resolved to ${pending.ref.path})`)
  if (info.size > IMAGE_MAX_BYTES) {
    throw new Error(`${where}: image ${pending.url} is ${info.size} bytes (max ${IMAGE_MAX_BYTES})`)
  }
}

function safeDecode(url: string): string {
  try {
    return decodeURIComponent(url)
  } catch {
    return url
  }
}

// ---------------------------------------------------------------------------
// Unsupported constructs

/**
 * Without GFM a pipe table arrives as paragraph text. Detect it by a first line starting with
 * `|` and a second line that is a delimiter row.
 */
function checkTable(node: Paragraph, ctx: Ctx): void {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return
  const lines = ctx.source.slice(start, end).split('\n').map((l) => l.replace(/^[\s>]+/, ''))
  if (lines.length >= 2 && lines[0]!.startsWith('|') && /^\|?\s*:?-+/.test(lines[1]!)) {
    throw error(ctx, node, 'tables are not supported')
  }
}

function checkFootnoteDefinition(node: Definition, ctx: Ctx): void {
  if (node.identifier.startsWith('^') || (node.label ?? '').startsWith('^')) {
    throw error(ctx, node, 'footnotes are not supported')
  }
}

function collectDefinitions(nodes: RootContent[], map = new Map<string, Definition>()): Map<string, Definition> {
  for (const node of nodes) {
    if (node.type === 'definition') {
      if (!map.has(node.identifier)) map.set(node.identifier, node)
    } else if ('children' in node && Array.isArray(node.children)) {
      collectDefinitions(node.children as RootContent[], map)
    }
  }
  return map
}

function error(ctx: Ctx, node: Positioned, message: string): Error {
  const line = node.position?.start.line
  return new Error(line === undefined ? `${ctx.file}: ${message}` : `${ctx.file}:${line}: ${message}`)
}
