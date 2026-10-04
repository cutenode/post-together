/**
 * Plan and publish. See docs/SPEC.md §7.4 to §7.6.
 *
 * `plan` decides per file whether to post or skip. `publishFile` checks the PDS
 * for records that already exist under the deterministic keys (resume), refuses
 * the file when one of them holds different text, reserves the keys in the state
 * file, then creates the missing records in thread order, writing the state after
 * every successful create.
 */
import { readFile } from 'node:fs/promises'
import { type Bluesky, type StrongRef, BlueskyError, classifyError, postUri } from './bluesky.js'
import { fetchLinkCard as defaultFetchLinkCard, type LinkCardMeta } from './linkcard.js'
import { rkeyFor } from './rkey.js'
import { isComplete, type StateStore } from './state.js'
import type { Facet, FacetFeature, Logger, PostRef, RenderedFile, RenderedPost, SkipReason, State, StateEntry } from './types.js'

export interface Candidate {
  relPath: string
  hash: string
  draft: boolean
  /** Absent for drafts (they are not rendered). */
  rendered?: RenderedFile
}

export type PlanItem =
  | { relPath: string; action: 'post'; rendered: RenderedFile }
  | { relPath: string; action: 'skip'; reason: SkipReason }

/** Decide what to do with each candidate. Order is preserved; `limit` 0 means unlimited. */
export function plan(candidates: Candidate[], state: State, limit: number, logger: Logger): PlanItem[] {
  const items: PlanItem[] = []
  let planned = 0
  for (const c of candidates) {
    if (c.draft || !c.rendered) {
      items.push({ relPath: c.relPath, action: 'skip', reason: 'draft' })
      continue
    }
    const entry = state.posts[c.relPath]
    if (entry) {
      if (entry.hash !== c.hash) {
        logger.warn(`${c.relPath} changed since it was posted; post-together never edits or reposts (skipping)`)
        items.push({ relPath: c.relPath, action: 'skip', reason: 'changed' })
        continue
      }
      if (isComplete(entry)) {
        items.push({ relPath: c.relPath, action: 'skip', reason: 'posted' })
        continue
      }
      logger.info(`${c.relPath} has an incomplete state entry; resuming`)
    }
    if (limit > 0 && planned >= limit) {
      items.push({ relPath: c.relPath, action: 'skip', reason: 'limit' })
      continue
    }
    planned++
    items.push({ relPath: c.relPath, action: 'post', rendered: c.rendered })
  }
  return items
}

export interface PublishOptions {
  logger: Logger
  /** Clock override for tests. */
  now?: () => Date
  /** Link-card fetcher override for tests. */
  fetchLinkCard?: (url: string) => Promise<LinkCardMeta>
}

export interface PublishOutcome {
  posts: PostRef[]
  /** True when at least one record already existed on the PDS or in the state file. */
  resumed: boolean
  /**
   * True when a record already on the PDS under one of the file's keys has different text
   * (the file was edited after posting, or another file used this path). Nothing was created
   * or recorded, and `posts` is empty.
   */
  changed: boolean
}

function clonePosts(posts: PostRef[]): PostRef[] {
  return posts.map((p) => (p.cid === undefined ? { rkey: p.rkey, uri: p.uri } : { rkey: p.rkey, uri: p.uri, cid: p.cid }))
}

function baseTime(rendered: RenderedFile, now: Date): Date {
  const raw = rendered.file.frontmatter.createdAt
  if (raw === undefined) return now
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) throw new Error(`${rendered.file.relPath}: createdAt ${JSON.stringify(raw)} is not a valid date`)
  return d
}

/** Publish one rendered file (post or thread), resuming any records that already exist. */
export async function publishFile(
  client: Bluesky,
  store: StateStore,
  rendered: RenderedFile,
  opts: PublishOptions,
): Promise<PublishOutcome> {
  const { logger } = opts
  const now = opts.now ?? (() => new Date())
  const { file, posts } = rendered
  const relPath = file.relPath
  if (posts.length === 0) throw new Error(`${relPath}: nothing to post`)

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      throw classifyError(err, { file: relPath, identifier: client.identifier, service: client.service })
    }
  }

  // 1. Deterministic keys and URIs, known before any network call.
  const refs: PostRef[] = posts.map((_, i) => {
    const rkey = rkeyFor(relPath, i)
    return { rkey, uri: postUri(client.did, rkey) }
  })

  // 2. Trust cids already confirmed in a matching state entry.
  let carried = 0
  const prior = store.get(relPath)
  if (prior && prior.hash === file.hash && prior.did === client.did) {
    prior.posts.forEach((p, i) => {
      const ref = refs[i]
      if (ref && p.rkey === ref.rkey && p.cid !== undefined) {
        ref.cid = p.cid
        carried++
      }
    })
  }

  // 3. Ask the PDS about every post that is not yet confirmed. An existing record only
  //    counts as this post when its text matches; otherwise the keys belong to an earlier
  //    version of the file (or another file at the same path), and continuing would hang
  //    new posts under old ones.
  let found = 0
  for (const [i, ref] of refs.entries()) {
    if (ref.cid !== undefined) continue
    const existing = await guard(() => client.getRecord(ref.rkey))
    if (!existing) continue
    if (existing.value['text'] !== posts[i]?.text) {
      logger.warn(
        `${relPath}: post ${i + 1} already exists on the PDS (${existing.uri}) with different text, so the file changed since it was posted or another file used this path; post-together never edits or reposts (skipping)`,
      )
      return { posts: [], resumed: false, changed: true }
    }
    ref.cid = existing.cid
    found++
    logger.info(`${relPath}: record ${ref.rkey} already exists on the PDS`)
  }

  const entry = (extra: Partial<StateEntry> = {}): StateEntry => ({
    hash: file.hash,
    did: client.did,
    posts: clonePosts(refs),
    ...extra,
  })

  if (refs.every((r) => r.cid !== undefined)) {
    await store.set(relPath, entry({ postedAt: now().toISOString() }))
    return { posts: clonePosts(refs), resumed: true, changed: false }
  }

  // 4. Reserve the keys before the first network write so a crash is resumable.
  await store.set(relPath, entry())

  const base = baseTime(rendered, now())
  const langs = file.frontmatter.langs
  let root: StrongRef | undefined
  let parent: StrongRef | undefined

  for (let i = 0; i < posts.length; i++) {
    const ref = refs[i]
    const post = posts[i]
    if (!ref || !post) continue
    if (ref.cid !== undefined) {
      const sr: StrongRef = { uri: ref.uri, cid: ref.cid }
      root ??= sr
      parent = sr
      continue
    }
    const record = await buildRecord(client, post, {
      relPath,
      createdAt: new Date(base.getTime() + i * 1000).toISOString(),
      langs,
      reply: root && parent ? { root, parent } : undefined,
      logger,
      fetchLinkCard: opts.fetchLinkCard ?? defaultFetchLinkCard,
    })
    const created = await guard(() => client.createRecord(ref.rkey, record))
    ref.cid = created.cid
    await store.set(relPath, entry())
    logger.debug(`${relPath}: created ${created.uri}`)
    const sr: StrongRef = { uri: created.uri, cid: created.cid }
    root ??= sr
    parent = sr
  }

  await store.set(relPath, entry({ postedAt: now().toISOString() }))
  return { posts: clonePosts(refs), resumed: carried + found > 0, changed: false }
}

interface RecordContext {
  relPath: string
  createdAt: string
  langs: string[] | undefined
  reply: { root: StrongRef; parent: StrongRef } | undefined
  logger: Logger
  fetchLinkCard: (url: string) => Promise<LinkCardMeta>
}

/** Build the `app.bsky.feed.post` record: resolve mentions, upload images or fetch a link card. */
export async function buildRecord(client: Bluesky, post: RenderedPost, ctx: RecordContext): Promise<Record<string, unknown>> {
  const record: Record<string, unknown> = { $type: 'app.bsky.feed.post', text: post.text }
  const facets = await resolveMentions(client, post.facets, ctx.relPath, ctx.logger)
  if (facets.length > 0) record['facets'] = facets
  const embed = await buildEmbed(client, post, ctx)
  if (embed) record['embed'] = embed
  if (ctx.langs && ctx.langs.length > 0) record['langs'] = ctx.langs
  record['createdAt'] = ctx.createdAt
  if (ctx.reply) record['reply'] = ctx.reply
  return record
}

/** Replace handles in mention facets with DIDs; drop facets whose handle does not resolve. */
export async function resolveMentions(client: Bluesky, facets: Facet[], relPath: string, logger: Logger): Promise<Facet[]> {
  const out: Facet[] = []
  for (const facet of facets) {
    const features: FacetFeature[] = []
    for (const feature of facet.features) {
      if (feature.$type === 'app.bsky.richtext.facet#mention' && !feature.did.startsWith('did:')) {
        const handle = feature.did.replace(/^@/, '')
        const did = await client.resolveHandle(handle)
        if (did === undefined) {
          logger.warn(`${relPath}: could not resolve @${handle}; leaving it as plain text`)
          continue
        }
        features.push({ $type: feature.$type, did })
      } else {
        features.push(feature)
      }
    }
    if (features.length > 0) out.push({ index: facet.index, features })
  }
  return out
}

async function buildEmbed(client: Bluesky, post: RenderedPost, ctx: RecordContext): Promise<Record<string, unknown> | undefined> {
  if (post.images.length > 0) {
    const images: Record<string, unknown>[] = []
    for (const img of post.images) {
      const bytes = new Uint8Array(await readFile(img.path))
      const blob = await uploadOrClassify(client, bytes, img.mime, ctx)
      images.push({ image: blob, alt: img.alt })
    }
    return { $type: 'app.bsky.embed.images', images }
  }
  if (post.linkCardUrl !== undefined) {
    return buildLinkCard(client, post.linkCardUrl, ctx)
  }
  return undefined
}

async function uploadOrClassify(client: Bluesky, bytes: Uint8Array, mime: string, ctx: RecordContext): Promise<unknown> {
  try {
    return await client.uploadBlob(bytes, mime)
  } catch (err) {
    throw classifyError(err, { file: ctx.relPath, identifier: client.identifier, service: client.service })
  }
}

async function buildLinkCard(client: Bluesky, url: string, ctx: RecordContext): Promise<Record<string, unknown> | undefined> {
  let meta: LinkCardMeta
  try {
    meta = await ctx.fetchLinkCard(url)
  } catch (err) {
    ctx.logger.warn(`${ctx.relPath}: no link card for ${url} (${(err as Error).message})`)
    return undefined
  }
  const external: Record<string, unknown> = { uri: meta.uri, title: meta.title, description: meta.description }
  if (meta.thumb) {
    try {
      external['thumb'] = await client.uploadBlob(meta.thumb.bytes, meta.thumb.mime)
    } catch (err) {
      const classified = classifyError(err, { file: ctx.relPath, identifier: client.identifier, service: client.service })
      if (classified instanceof BlueskyError && (classified.kind === 'rate-limited' || classified.kind === 'auth')) throw classified
      ctx.logger.warn(`${ctx.relPath}: link card thumbnail for ${url} not uploaded (${(err as Error).message})`)
    }
  }
  return { $type: 'app.bsky.embed.external', external }
}
