/**
 * Shared types for post-together. See docs/SPEC.md §6.
 * Every module imports its contracts from here; do not redefine these shapes elsewhere.
 */

/** An inline run of text, optionally carrying a link facet. */
export interface Run {
  text: string
  link?: string
}

/** An image referenced from Markdown, resolved to an absolute path. */
export interface ImageRef {
  path: string
  alt: string
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

/** One block-level Markdown node rendered to runs. Images are lifted out of the text. */
export interface Block {
  runs: Run[]
  images: ImageRef[]
}

/** An explicit thread segment: blocks between `---` thematic breaks. */
export interface Segment {
  blocks: Block[]
}

export interface Frontmatter {
  draft?: boolean
  langs?: string[]
  createdAt?: string
  link?: string | false | 'auto'
  thread?: 'auto' | 'manual' | 'off'
}

export interface ParsedFile {
  /** Absolute path. */
  path: string
  /** Posix path relative to `cwd`; the state key. */
  relPath: string
  /** `sha256:<hex>` of the raw file bytes. */
  hash: string
  frontmatter: Frontmatter
  segments: Segment[]
}

export interface FacetIndex {
  byteStart: number
  byteEnd: number
}

export type FacetFeature =
  | { $type: 'app.bsky.richtext.facet#link'; uri: string }
  /** `did` holds the bare handle until publish resolves it to a DID. */
  | { $type: 'app.bsky.richtext.facet#mention'; did: string }
  | { $type: 'app.bsky.richtext.facet#tag'; tag: string }

export interface Facet {
  index: FacetIndex
  features: FacetFeature[]
}

export interface RenderedPost {
  text: string
  facets: Facet[]
  images: ImageRef[]
  linkCardUrl?: string
  graphemes: number
  bytes: number
}

export interface RenderedFile {
  file: ParsedFile
  /** At least one post. */
  posts: RenderedPost[]
}

export interface PostRef {
  rkey: string
  uri: string
  /** Absent until the record is confirmed to exist on the PDS. */
  cid?: string
}

export interface StateEntry {
  hash: string
  did: string
  /** Set once every post has a cid (or the entry was created by `init`). */
  postedAt?: string
  posts: PostRef[]
}

export interface State {
  version: 1
  posts: Record<string, StateEntry>
}

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
  debug(msg: string): void
}

export interface RunOptions {
  /** Directory scanned recursively for `*.md`. Default `posts`. */
  dir?: string
  /** State file path relative to cwd, or `'none'` to disable. Default `<dir>/.post-together.json`. */
  stateFile?: string
  identifier?: string
  password?: string
  /** PDS or entryway URL. Default `https://bsky.social`. */
  service?: string
  dryRun?: boolean
  /** Max files to post this run; 0 = unlimited. */
  limit?: number
  linkCards?: boolean
  threadCounter?: boolean
  commit?: boolean
  commitMessage?: string
  cwd?: string
  mode?: 'post' | 'init'
  logger?: Logger
}

export type SkipReason = 'draft' | 'posted' | 'changed' | 'limit'

export interface RunResult {
  posted: { relPath: string; posts: PostRef[] }[]
  /** Files whose records already existed on the PDS (or partially existed) and were completed without duplicates. */
  resumed: { relPath: string; posts: PostRef[] }[]
  skipped: { relPath: string; reason: SkipReason }[]
  /** Everything rendered this run; dry-run fills this and posts nothing. */
  rendered: RenderedFile[]
  did?: string
}

/** Options that affect rendering only. */
export interface RenderOptions {
  threadCounter: boolean
  linkCards: boolean
}

export const POST_MAX_GRAPHEMES = 300
export const POST_MAX_BYTES = 3000
export const POST_MAX_IMAGES = 4
export const IMAGE_MAX_BYTES = 2_000_000
export const THUMB_MAX_BYTES = 1_000_000
export const POST_COLLECTION = 'app.bsky.feed.post'
