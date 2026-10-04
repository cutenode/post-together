/**
 * GitHub Action entry point. See docs/SPEC.md §8.1.
 *
 * Bundled by esbuild into dist/action.js. This is the only module that imports
 * `@actions/core`.
 */
import * as core from '@actions/core'
import { parseBoolean, parseLimit, parseMode } from './config.js'
import { run } from './index.js'
import type { Logger, RunOptions, RunResult } from './types.js'

function input(name: string): string | undefined {
  const value = core.getInput(name)
  return value === '' ? undefined : value
}

function booleanInput(name: string): boolean | undefined {
  return parseBoolean(input(name), `input ${name}`)
}

function bskyLink(did: string | undefined, rkey: string, uri: string): string {
  if (!did) return uri
  return `https://bsky.app/profile/${did}/post/${rkey}`
}

async function writeSummary(result: RunResult, dryRun: boolean): Promise<void> {
  const live = [...result.posted, ...result.resumed]
  const summary = core.summary.addHeading('post-together', 2)
  if (dryRun) {
    summary.addRaw(`Dry run: ${result.rendered.length} file(s) rendered, nothing was posted.`, true)
  } else if (live.length === 0) {
    summary.addRaw('No files were posted.', true)
  } else {
    const rows: (string | { data: string; header: boolean })[][] = [
      [
        { data: 'File', header: true },
        { data: 'Posts', header: true },
        { data: 'Link', header: true },
      ],
    ]
    for (const item of live) {
      const first = item.posts[0]
      const link = first ? bskyLink(result.did, first.rkey, first.uri) : ''
      rows.push([item.relPath, String(item.posts.length), link ? `<a href="${link}">${link}</a>` : ''])
    }
    summary.addTable(rows)
  }
  if (result.skipped.length > 0) {
    summary.addRaw(`Skipped ${result.skipped.length} file(s): ${result.skipped.map((s) => `${s.relPath} (${s.reason})`).join(', ')}`, true)
  }
  await summary.write()
}

async function main(): Promise<void> {
  const password = input('app-password')
  if (password !== undefined) core.setSecret(password)

  const logger: Logger = {
    info: (msg) => core.info(msg),
    warn: (msg) => core.warning(msg),
    error: (msg) => core.error(msg),
    debug: (msg) => core.debug(msg),
  }

  const options: RunOptions = { logger }
  const dir = input('dir')
  if (dir !== undefined) options.dir = dir
  const stateFile = input('state-file')
  if (stateFile !== undefined) options.stateFile = stateFile
  const identifier = input('identifier')
  if (identifier !== undefined) options.identifier = identifier
  if (password !== undefined) options.password = password
  const service = input('service')
  if (service !== undefined) options.service = service
  const dryRun = booleanInput('dry-run')
  if (dryRun !== undefined) options.dryRun = dryRun
  const limit = parseLimit(input('limit'), 'input limit')
  if (limit !== undefined) options.limit = limit
  const linkCards = booleanInput('link-cards')
  if (linkCards !== undefined) options.linkCards = linkCards
  const threadCounter = booleanInput('thread-counter')
  if (threadCounter !== undefined) options.threadCounter = threadCounter
  const commit = booleanInput('commit')
  if (commit !== undefined) options.commit = commit
  const commitMessage = input('commit-message')
  if (commitMessage !== undefined) options.commitMessage = commitMessage
  const mode = parseMode(input('mode'), 'input mode')
  if (mode !== undefined) options.mode = mode
  const cwd = process.env['GITHUB_WORKSPACE']
  if (cwd) options.cwd = cwd

  const result = await run(options)

  const live = [...result.posted, ...result.resumed]
  core.setOutput('posted-count', String(live.length))
  core.setOutput('posted', JSON.stringify(live.map((p) => ({ file: p.relPath, uris: p.posts.map((x) => x.uri) }))))
  core.setOutput('skipped-count', String(result.skipped.length))

  if (process.env['GITHUB_STEP_SUMMARY']) {
    try {
      await writeSummary(result, dryRun ?? false)
    } catch (err) {
      core.warning(`could not write the step summary: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

main().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
