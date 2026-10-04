import { buildFacets, firstLinkUri, graphemeLength, byteLength, piecesText } from './facets.js'
import {
  COUNTER_LIMITS,
  FULL_LIMITS,
  blockHasText,
  measure,
  normalizeBlock,
  splitBlocks,
  type Limits,
  type PostDraft,
} from './split.js'
import { POST_MAX_BYTES, POST_MAX_GRAPHEMES, POST_MAX_IMAGES } from './types.js'
import type { Block, Facet, ImageRef, ParsedFile, RenderOptions, RenderedFile, RenderedPost } from './types.js'

/**
 * Turn a parsed file into one or more posts: text, facets (UTF-8 byte offsets), images,
 * link card URL, and thread splitting per the file's `thread` mode. Pure and offline.
 * Mention facets keep the handle in `did`; publish resolves them.
 */
export function render(file: ParsedFile, opts: RenderOptions): RenderedFile {
  const mode = file.frontmatter.thread ?? 'auto'
  const name = file.relPath

  if (mode === 'off' && file.segments.length > 1) {
    throw new Error(`${name}: thread is "off" but the file contains a --- thread break`)
  }

  // Normalise whitespace and drop blocks that carry neither text nor images.
  const segments = file.segments
    .map((s) => s.blocks.map(normalizeBlock).filter((b) => blockHasText(b) || b.images.length > 0))
    .filter((blocks) => blocks.length > 0)
  if (segments.length === 0) throw new Error(`${name}: no content to post`)

  let drafts: PostDraft[]
  if (mode === 'auto') {
    drafts = segments.flatMap((blocks) => splitBlocks(blocks, FULL_LIMITS, name))
    if (opts.threadCounter && drafts.length > 1) {
      // The thread needs counters: redo the split with room reserved for ` (i/n)`.
      drafts = segments.flatMap((blocks) => splitBlocks(blocks, COUNTER_LIMITS, name))
    }
  } else {
    const limits = opts.threadCounter && segments.length > 1 ? COUNTER_LIMITS : FULL_LIMITS
    drafts = segments.map((blocks) => oneDraft(blocks))
    drafts.forEach((draft, i) => assertFits(draft, i, limits, name, mode))
  }

  const n = drafts.length
  const posts = drafts.map((draft, i) => finalisePost(draft, i, n, file, opts))
  return { file, posts }
}

function oneDraft(blocks: Block[]): PostDraft {
  const images: ImageRef[] = []
  for (const b of blocks) images.push(...b.images)
  return { pieces: blocks.map((b) => b.runs), images }
}

function assertFits(draft: PostDraft, index: number, limits: Limits, name: string, mode: string): void {
  const m = measure(piecesText(draft.pieces))
  if (m.graphemes > limits.graphemes || m.bytes > limits.bytes) {
    const reserved = limits.graphemes < POST_MAX_GRAPHEMES ? ` (${POST_MAX_GRAPHEMES} minus room for the thread counter)` : ''
    const hint = mode === 'off' ? 'set thread: auto or manual' : 'split it with --- or set thread: auto'
    throw new Error(
      `${name}: post ${index + 1} is ${m.graphemes} graphemes / ${m.bytes} bytes, max ${limits.graphemes} graphemes${reserved} / ${limits.bytes} bytes; ${hint}`,
    )
  }
}

function finalisePost(draft: PostDraft, index: number, count: number, file: ParsedFile, opts: RenderOptions): RenderedPost {
  const name = file.relPath
  if (draft.images.length > POST_MAX_IMAGES) {
    throw new Error(`${name}: post ${index + 1} has ${draft.images.length} images (max ${POST_MAX_IMAGES})`)
  }

  const built = buildFacets(draft.pieces)
  let text = built.text
  if (opts.threadCounter && count > 1) text += ` (${index + 1}/${count})`

  const graphemes = graphemeLength(text)
  const bytes = byteLength(text)
  if (graphemes > POST_MAX_GRAPHEMES || bytes > POST_MAX_BYTES) {
    throw new Error(`${name}: post ${index + 1} is ${graphemes} graphemes / ${bytes} bytes (max ${POST_MAX_GRAPHEMES} / ${POST_MAX_BYTES})`)
  }

  const post: RenderedPost = { text, facets: built.facets, images: draft.images, graphemes, bytes }
  const linkCardUrl = linkCardFor(file, index, draft.images, built.facets, opts)
  if (linkCardUrl !== undefined) post.linkCardUrl = linkCardUrl
  return post
}

/**
 * SPEC §7.3: never when the post has images. A frontmatter URL goes on the first post (later
 * posts of the thread follow the default); `auto` (or unset with `linkCards` on) uses the first
 * link facet in that post; `false` disables cards for the whole file.
 */
function linkCardFor(file: ParsedFile, index: number, images: ImageRef[], facets: Facet[], opts: RenderOptions): string | undefined {
  if (images.length > 0) return undefined
  const link = file.frontmatter.link
  if (link === false) return undefined
  if (typeof link === 'string' && link !== 'auto' && index === 0) return link
  if (link === 'auto' || opts.linkCards) return firstLinkUri(facets)
  return undefined
}
