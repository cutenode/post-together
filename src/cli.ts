#!/usr/bin/env node
/**
 * post-together CLI. See docs/SPEC.md §8.3.
 *
 * Exit codes: 0 success, 1 posting/config error, 2 usage error. Never prints
 * GitHub `::` workflow commands.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { BlueskyError } from './bluesky.js'
import { type RawFlags, resolveOptions, toRunOptions, UsageError } from './config.js'
import { run } from './index.js'
import { consoleLogger } from './log.js'
import { parseFile } from './parse.js'
import { render } from './render.js'

const USAGE = `Usage: post-together [command] [options]

Post Markdown files from a directory to Bluesky as posts and threads.

Commands:
  (default)             post every unposted file under --dir
  init                  mark every current file as posted without posting
  render <file>         print the rendered posts for one file as JSON

Options:
  --dir <path>          directory scanned recursively for *.md (default: posts)
  --state-file <path>   state file, or "none" to disable (default: <dir>/.post-together.json)
  --identifier <id>     Bluesky handle, email or DID (env BSKY_IDENTIFIER)
  --password <pw>       Bluesky app password (env BSKY_APP_PASSWORD)
  --service <url>       PDS or entryway URL (default: https://bsky.social)
  --dry-run             render and print; no login, no network, no state writes
  --limit <n>           max files to post this run (default: 0 = unlimited)
  --no-link-cards       do not attach link cards
  --thread-counter      append " (i/n)" to each post of a thread
  --commit              git add, commit and push the state file after posting
  --commit-message <m>  commit message (default: "chore: record posted files")
  --cwd <path>          root for relative paths and state keys (default: current directory)
  -h, --help            show this help
  -v, --version         print the version

Environment: POST_TOGETHER_DIR, POST_TOGETHER_STATE_FILE, POST_TOGETHER_DRY_RUN,
POST_TOGETHER_LIMIT, POST_TOGETHER_LINK_CARDS, POST_TOGETHER_THREAD_COUNTER,
POST_TOGETHER_COMMIT, POST_TOGETHER_COMMIT_MESSAGE, BSKY_IDENTIFIER,
BSKY_APP_PASSWORD, BSKY_SERVICE. GitHub Action INPUT_* variables are read last.
Flags override environment variables.`

function version(): string {
  const require = createRequire(import.meta.url)
  const pkg = require('../package.json') as { version?: string }
  return pkg.version ?? '0.0.0'
}

function isParseArgsError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<typeof PARSE_CONFIG>>
  try {
    parsed = parseArgs({ ...PARSE_CONFIG, args: argv })
  } catch (err) {
    if (isParseArgsError(err)) {
      console.error(`error: ${err.message}`)
      console.error('Run post-together --help for usage.')
      return 2
    }
    throw err
  }
  const { values, positionals } = parsed

  if (values.help) {
    console.log(USAGE)
    return 0
  }
  if (values.version) {
    console.log(version())
    return 0
  }

  const [command, ...rest] = positionals
  if (command !== undefined && command !== 'init' && command !== 'render') {
    console.error(`error: unknown command ${JSON.stringify(command)}`)
    console.error('Run post-together --help for usage.')
    return 2
  }
  if (command === 'render' && rest.length !== 1) {
    console.error('error: render takes exactly one file argument')
    console.error('Run post-together --help for usage.')
    return 2
  }
  if (command !== 'render' && rest.length > 0) {
    console.error(`error: unexpected argument ${JSON.stringify(rest[0])}`)
    console.error('Run post-together --help for usage.')
    return 2
  }

  const flags: RawFlags = {}
  if (values.dir !== undefined) flags.dir = values.dir
  if (values['state-file'] !== undefined) flags.stateFile = values['state-file']
  if (values.identifier !== undefined) flags.identifier = values.identifier
  if (values.password !== undefined) flags.password = values.password
  if (values.service !== undefined) flags.service = values.service
  if (values['dry-run'] !== undefined) flags.dryRun = values['dry-run']
  if (values.limit !== undefined) flags.limit = values.limit
  if (values['link-cards'] !== undefined) flags.linkCards = values['link-cards']
  else if (values['no-link-cards']) flags.linkCards = false
  if (values['thread-counter'] !== undefined) flags.threadCounter = values['thread-counter']
  if (values.commit !== undefined) flags.commit = values.commit
  if (values['commit-message'] !== undefined) flags.commitMessage = values['commit-message']
  if (values.cwd !== undefined) flags.cwd = values.cwd
  if (command === 'init') flags.mode = 'init'

  const opts = resolveOptions(flags, process.env)

  if (command === 'render') {
    const file = path.resolve(opts.cwd, rest[0] ?? '')
    const parsedFile = await parseFile(file, opts.cwd)
    const out = render(parsedFile, { threadCounter: opts.threadCounter, linkCards: opts.linkCards })
    console.log(JSON.stringify({ file: out.file.relPath, frontmatter: out.file.frontmatter, posts: out.posts }, null, 2))
    return 0
  }

  await run(toRunOptions(opts, consoleLogger))
  return 0
}

const PARSE_CONFIG = {
  allowPositionals: true,
  strict: true,
  options: {
    dir: { type: 'string' },
    'state-file': { type: 'string' },
    identifier: { type: 'string' },
    password: { type: 'string' },
    service: { type: 'string' },
    'dry-run': { type: 'boolean' },
    limit: { type: 'string' },
    'link-cards': { type: 'boolean' },
    'no-link-cards': { type: 'boolean' },
    'thread-counter': { type: 'boolean' },
    commit: { type: 'boolean' },
    'commit-message': { type: 'string' },
    cwd: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
} as const

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`error: ${err.message}`)
    console.error('Run post-together --help for usage.')
    process.exitCode = 2
  } else if (err instanceof BlueskyError) {
    console.error(`error: ${err.message}`)
    process.exitCode = 1
  } else {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    if (process.env['POST_TOGETHER_DEBUG'] === 'true' && err instanceof Error && err.stack) console.error(err.stack)
    process.exitCode = 1
  }
}
