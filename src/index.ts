/**
 * post-together library entry point. See docs/SPEC.md §1 and §7.
 *
 * `run(options)` is what every surface (CLI, GitHub Action, Spindle step) calls.
 * Nothing here imports `@actions/core`.
 */
import { bskyAppUrl, login } from './bluesky.js'
import { describeOptions, type ResolvedOptions, UsageError, withDefaults } from './config.js'
import { discover, keyRoot } from './discover.js'
import { commitState } from './git.js'
import { consoleLogger } from './log.js'
import { parseFile } from './parse.js'
import { type Candidate, plan, type PlanItem, publishFile } from './publish.js'
import { render } from './render.js'
import { isComplete, resolveStatePath, StateStore } from './state.js'
import type { Logger, RenderedFile, RenderedPost, RunOptions, RunResult, SkipReason } from './types.js'

export type {
  Facet,
  FacetFeature,
  Frontmatter,
  ImageRef,
  Logger,
  ParsedFile,
  PostRef,
  RenderedFile,
  RenderedPost,
  RenderOptions,
  RunOptions,
  RunResult,
  SkipReason,
  State,
  StateEntry,
} from './types.js'
export { UsageError, resolveOptions, withDefaults } from './config.js'
export type { RawFlags, ResolvedOptions } from './config.js'
export { BlueskyError } from './bluesky.js'
export { consoleLogger, silentLogger } from './log.js'

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  draft: 'draft',
  posted: 'already posted',
  changed: 'changed since it was posted',
  limit: 'limit reached',
}

/** Human-readable dump of a rendered file for dry runs. */
export function formatRenderedFile(rendered: RenderedFile): string {
  const n = rendered.posts.length
  const lines: string[] = [`${rendered.file.relPath} (${n} post${n === 1 ? '' : 's'})`]
  rendered.posts.forEach((post, i) => {
    lines.push(`  [${i + 1}/${n}] ${post.graphemes} graphemes, ${post.bytes} bytes`)
    for (const line of post.text.split('\n')) lines.push(`  | ${line}`)
    const facets = describeFacets(post)
    if (facets) lines.push(`    facets: ${facets}`)
    if (post.images.length > 0) {
      lines.push(`    images: ${post.images.map((img) => `${img.path} (${img.mime}, alt ${JSON.stringify(img.alt)})`).join(', ')}`)
    }
    if (post.linkCardUrl !== undefined) lines.push(`    link card: ${post.linkCardUrl}`)
  })
  return lines.join('\n')
}

function describeFacets(post: RenderedPost): string {
  const parts: string[] = []
  for (const facet of post.facets) {
    for (const f of facet.features) {
      if (f.$type === 'app.bsky.richtext.facet#link') parts.push(`link ${f.uri}`)
      else if (f.$type === 'app.bsky.richtext.facet#mention') parts.push(`mention ${f.did.startsWith('did:') ? f.did : '@' + f.did}`)
      else parts.push(`tag #${f.tag}`)
    }
  }
  return parts.join(', ')
}

/** Run the pipeline: discover, parse, render, plan, publish, record, commit. */
export async function run(options: RunOptions = {}): Promise<RunResult> {
  const logger: Logger = options.logger ?? consoleLogger
  const opts = withDefaults(options)
  logger.debug(`options: ${describeOptions(opts)}`)
  const cwd = opts.cwd

  // State keys and record keys are relative to the repository root, not to cwd, so running
  // from a subdirectory cannot give the same file a new key and post it twice.
  const root = await keyRoot(opts.dir, cwd)
  if (root !== cwd) logger.debug(`state and record keys are relative to ${root}`)

  const files = await discover(opts.dir, cwd, root)
  if (files.length === 0) logger.warn(`no Markdown files found under ${opts.dir}`)

  const candidates: Candidate[] = []
  const rendered: RenderedFile[] = []
  const problems: string[] = []
  for (const f of files) {
    try {
      const parsed = await parseFile(f.path, cwd, root)
      if (parsed.frontmatter.draft) {
        candidates.push({ relPath: parsed.relPath, hash: parsed.hash, draft: true })
        continue
      }
      const out = render(parsed, { threadCounter: opts.threadCounter, linkCards: opts.linkCards })
      rendered.push(out)
      candidates.push({ relPath: parsed.relPath, hash: parsed.hash, draft: false, rendered: out })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const named = message.includes(f.relPath) ? message : `${f.relPath}: ${message}`
      problems.push(named)
      logger.error(named)
    }
  }
  if (problems.length > 0) {
    throw new Error(`${problems.length} file${problems.length === 1 ? '' : 's'} could not be rendered:\n${problems.join('\n')}`)
  }

  const statePath = resolveStatePath(opts.stateFile, cwd)
  const store = await StateStore.open(statePath)

  if (opts.mode === 'init') return init(candidates, rendered, store, opts, logger)

  const items = plan(candidates, store.state, opts.limit, logger)
  const result: RunResult = { posted: [], resumed: [], skipped: [], rendered }
  const toPost: Extract<PlanItem, { action: 'post' }>[] = []
  for (const item of items) {
    if (item.action === 'skip') {
      result.skipped.push({ relPath: item.relPath, reason: item.reason })
      logger.info(`skipped ${item.relPath} (${SKIP_REASON_TEXT[item.reason]})`)
    } else {
      toPost.push(item)
    }
  }

  if (opts.dryRun) {
    for (const item of toPost) logger.info(formatRenderedFile(item.rendered))
    logger.info(`dry run: would post ${toPost.length} file${toPost.length === 1 ? '' : 's'} (${result.skipped.length} skipped); nothing was sent`)
    return result
  }

  if (toPost.length === 0) {
    logger.info('nothing to post')
    return result
  }

  if (!opts.identifier || !opts.password) {
    throw new UsageError(
      'identifier and app password are required to post: set BSKY_IDENTIFIER and BSKY_APP_PASSWORD (or --identifier/--password), or use --dry-run',
    )
  }

  const client = await login({ service: opts.service, identifier: opts.identifier, password: opts.password })
  result.did = client.did
  logger.info(`logged in as ${client.did} via ${opts.service}`)

  // Commit whatever was recorded even when a later file fails (a 429, say), so the
  // progress made before the failure is not lost from the repository.
  try {
    for (const item of toPost) {
      const outcome = await publishFile(client, store, item.rendered, { logger })
      if (outcome.changed) {
        result.skipped.push({ relPath: item.relPath, reason: 'changed' })
        logger.info(`skipped ${item.relPath} (${SKIP_REASON_TEXT.changed})`)
        continue
      }
      const first = outcome.posts[0]
      const link = first ? bskyAppUrl(client.did, first.rkey) : '(no posts)'
      const n = outcome.posts.length
      const entry = { relPath: item.relPath, posts: outcome.posts }
      if (outcome.resumed) result.resumed.push(entry)
      else result.posted.push(entry)
      logger.info(`${outcome.resumed ? 'resumed' : 'posted'} ${item.relPath} → ${link} (${n} post${n === 1 ? '' : 's'})`)
    }
  } finally {
    await maybeCommit(store, opts.commit, opts.commitMessage, cwd, logger)
  }
  return result
}

async function init(
  candidates: Candidate[],
  rendered: RenderedFile[],
  store: StateStore,
  opts: ResolvedOptions,
  logger: Logger,
): Promise<RunResult> {
  if (store.path === null) throw new UsageError('init needs a state file; state-file is set to none')
  const result: RunResult = { posted: [], resumed: [], skipped: [], rendered }
  const now = new Date().toISOString()
  let marked = 0
  for (const c of candidates) {
    if (c.draft) {
      result.skipped.push({ relPath: c.relPath, reason: 'draft' })
      logger.info(`skipped ${c.relPath} (draft)`)
      continue
    }
    const prior = store.get(c.relPath)
    if (prior && prior.hash === c.hash && isComplete(prior)) {
      result.skipped.push({ relPath: c.relPath, reason: 'posted' })
      logger.info(`skipped ${c.relPath} (already posted)`)
      continue
    }
    marked++
    if (opts.dryRun) {
      logger.info(`would mark ${c.relPath} as posted`)
      continue
    }
    await store.set(c.relPath, { hash: c.hash, did: '', postedAt: now, posts: [] })
    logger.info(`marked ${c.relPath} as posted`)
  }
  const files = `${marked} file${marked === 1 ? '' : 's'}`
  if (opts.dryRun) {
    logger.info(`dry run: init would mark ${files} as posted in ${store.path}; nothing was written`)
    return result
  }
  logger.info(`init: marked ${files} as posted in ${store.path}`)
  await maybeCommit(store, opts.commit, opts.commitMessage, opts.cwd, logger)
  return result
}

async function maybeCommit(store: StateStore, commit: boolean, message: string, cwd: string, logger: Logger): Promise<void> {
  if (!commit) return
  if (store.path === null) {
    logger.warn('commit requested but the state file is disabled (none); nothing to commit')
    return
  }
  if (!store.changed) {
    logger.info('commit skipped: the state file did not change')
    return
  }
  await commitState({ cwd, file: store.path, message, logger })
}
