# post-together design spec

Status: v1 design, final. This document is the source of truth for implementation.
Companion: `docs/RESEARCH.md` (decision digest) and `docs/research/*.md` (full verified reports with citations).

## 1. What it is

`post-together` reads Markdown files from a directory and publishes each unposted file to Bluesky as a post or a thread. One codebase ships as:

| Surface | Entry | How it is invoked |
|---|---|---|
| GitHub Action | `action.yml` → `dist/action.js` | `uses: cutenode/post-together@v1` |
| Tangled Spindle step | npm `bin` → `dist/cli.js` | `npx --yes @cutenode/post-together@1 ...` inside a Spindle workflow step |
| Plain CLI / library | `dist/cli.js`, `dist/index.js` | `npx @cutenode/post-together`, `import { run } from '@cutenode/post-together'` |

All three call the same `run(options)` in `src/index.ts`. Surfaces differ only in how they gather options and how they log.

## 2. Non-goals (v1)

- No OAuth. App passwords only (headless CI has no browser; see RESEARCH).
- No editing or deleting posts. A file changed after posting produces a warning only.
- No video embeds. Images (≤ 4 per post) and one external link card per post.
- No scheduling. Posting happens when the workflow runs.

## 3. Runtime and packaging

- Node ≥ 22 (required by `@atproto/api` 0.21 through 0.23). `package.json` `"type": "module"`, ESM throughout. `engines.node: ">=22"`.
- TypeScript 7, `module: nodenext`, `moduleResolution: nodenext`, `target: es2023`, `strict`, `verbatimModuleSyntax`, `isolatedModules`. Source imports use `.js` extensions.
- Runtime dependencies: `@atproto/api`, `@atproto/common-web` (for `TID`), `mdast-util-from-markdown`, `yaml`.
- Dev: `@actions/core` (used only by `src/action.ts` and bundled into `dist/action.js`, so npm installs never need it), `esbuild`, `vitest`, `typescript`, `tsx`, `@types/node`.
- Bluesky client: `new CredentialSession(new URL(service))`, `await session.login({ identifier, password })`, `new Agent(session)`. Do not use `AtpAgent` or `BskyAgent` (both on a deprecation path).
- Build outputs:
  - `dist/index.js`, `dist/cli.js`, `dist/*.d.ts`: compiled by `tsc`, unbundled, published to npm (`files: ["dist", "!dist/action.js", "!dist/action.d.ts"]`; `action.yml` is not shipped because the bundle it points at is not).
  - `dist/action.js`: single-file ESM bundle by esbuild, committed to git, no `node_modules` at runtime. Command: `esbuild src/action.ts --bundle --platform=node --format=esm --target=node24 --outfile=dist/action.js --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"`. The banner is required: without it the bundle throws `Dynamic require of "..." is not supported` (verified). Do not minify (keeps `check-dist` diffs readable). Output is about 2 MB.
- Grapheme counting uses `RichText.graphemeLength` from `@atproto/api` (backed by `Intl.Segmenter`).

## 4. Configuration

One options object, `RunOptions`, resolved from three layers. Later layers win.

1. GitHub Action inputs: `INPUT_<NAME>` env vars (uppercased; hyphens kept, e.g. `INPUT_APP-PASSWORD`). Read by `src/action.ts` via `@actions/core`. The CLI also reads them as a last-resort fallback so the same binary works when invoked from a `run:` step.
2. Environment variables (Spindle and any CI): see table.
3. CLI flags (Spindle and local runs). Parsed with `node:util` `parseArgs`.

| Option | Flag | Env | Action input | Default | Notes |
|---|---|---|---|---|---|
| `dir` | `--dir` | `POST_TOGETHER_DIR` | `dir` | `posts` | Directory scanned recursively for `*.md` |
| `stateFile` | `--state-file` | `POST_TOGETHER_STATE_FILE` | `state-file` | `<dir>/.post-together.json` | Path relative to `cwd`. `none` disables the state file entirely |
| `identifier` | `--identifier` | `BSKY_IDENTIFIER` | `identifier` | — | Handle, email or DID. Required unless `--dry-run` |
| `password` | `--password` | `BSKY_APP_PASSWORD` | `app-password` | — | App password. Required unless `--dry-run`. Never logged |
| `service` | `--service` | `BSKY_SERVICE` | `service` | `https://bsky.social` | PDS or entryway URL |
| `dryRun` | `--dry-run` | `POST_TOGETHER_DRY_RUN=true` | `dry-run` | `false` | Render and print; no login, no network, no state writes |
| `limit` | `--limit` | `POST_TOGETHER_LIMIT` | `limit` | `0` (unlimited) | Max files to post this run |
| `linkCards` | `--no-link-cards` | `POST_TOGETHER_LINK_CARDS=false` | `link-cards` | `true` | Attach an external embed for the first link in a post that has no images |
| `threadCounter` | `--thread-counter` | `POST_TOGETHER_THREAD_COUNTER=true` | `thread-counter` | `false` | Append ` (i/n)` to each post of a thread with n > 1 |
| `commit` | `--commit` | `POST_TOGETHER_COMMIT=true` | `commit` | `false` | After posting, `git add` the state file, commit, push |
| `commitMessage` | `--commit-message` | `POST_TOGETHER_COMMIT_MESSAGE` | `commit-message` | `chore: record posted files` | |
| `cwd` | `--cwd` | — | — | `process.cwd()` | Base for relative paths (`dir`, `stateFile`). State and record keys are relative to the key root (§7.1), not to `cwd` |

Booleans accept `true|false|1|0|yes|no` case-insensitively; anything else is a usage error.

Subcommands (CLI only):
- `post-together` (default): post.
- `post-together init`: mark every current file as posted without posting; writes the state file. Requires a state file. With `--dry-run`, list the files it would mark and write nothing (and never commit).
- `post-together render <file>`: print the rendered posts for one file as JSON (no network).

The action exposes `mode: post | init` for the same purpose, and the env var `POST_TOGETHER_MODE` selects it too (flags and subcommands win over it).

Precedence example: in a Spindle step, `BSKY_APP_PASSWORD` comes from the secret store and `--dir` from the command line.

## 5. Markdown file contract

Each `*.md` file under `dir` is one post or one thread. Files whose name starts with `_` or `.` are ignored, as are `node_modules` directories. Frontmatter is optional YAML between `---` fences at the very top of the file.

```yaml
---
draft: true                 # skip this file entirely (default false)
langs: [en]                 # up to 3 BCP-47 codes for app.bsky.feed.post.langs (default: none)
createdAt: 2026-09-28T09:00:00Z  # override post timestamp (default: now). Must parse as a date; re-serialised with toISOString()
link: https://example.com   # link card URL. Also `auto` (first link in the post; the default when linkCards is on) or `false`
thread: auto                # auto | manual | off (default auto). See §7.3
---
```
Unknown frontmatter keys are an error naming the key and file. Wrong types are an error.

Body rendering rules (Markdown → plain text; Bluesky has no markup):

| Markdown | Rendered |
|---|---|
| Paragraph | Text. Paragraphs separated by one blank line |
| Heading | Its text on its own line (no `#`) |
| Emphasis / strong / delete | Inner text only |
| Inline code | Inner text only (no backticks) |
| Fenced or indented code block | Verbatim text |
| `[text](url)` | `text` with a link facet to `url`. If `text` equals `url`, still a manual facet |
| Bare URL, `#hashtag`, `@handle.tld` | Detected by `RichText`; mentions resolved to DIDs at publish time; unresolvable mentions become plain text |
| `![alt](./path.png)` | Removed from text; attached as an image embed on the post it appears in (alt = `alt`). Paths resolve relative to the Markdown file. Max 4 per post; a 5th is an error. Each ≤ 2,000,000 bytes; `.png .jpg .jpeg .webp .gif` map to `image/png image/jpeg image/webp image/gif`; other extensions are an error |
| Ordered / unordered list | One line per item, prefixed `1. ` / `- `; nested lists indent two spaces |
| Blockquote | Inner text, each line prefixed `> ` |
| `---` thematic break | Thread boundary (next post) |
| Hard line break | Newline |
| Raw HTML | Dropped |
| Table, footnote | Error: unsupported, naming the file and line |

Whitespace: collapse 3+ consecutive newlines to 2, trim each post. A block that renders to empty text (e.g. an image-only paragraph) contributes no text and no blank line.

## 6. Shared types (`src/types.ts`)

```ts
export interface Run { text: string; link?: string }               // inline run of text, optionally linked
export interface ImageRef { path: string; alt: string; mime: string } // absolute path
export interface Block { runs: Run[]; images: ImageRef[] }           // one block-level node
export interface Segment { blocks: Block[] }                         // explicit thread segment (split on ---)

export interface Frontmatter {
  draft?: boolean; langs?: string[]; createdAt?: string;
  link?: string | false | 'auto'; thread?: 'auto' | 'manual' | 'off';
}
export interface ParsedFile { path: string; relPath: string; hash: string; frontmatter: Frontmatter; segments: Segment[] }

export interface Facet { index: { byteStart: number; byteEnd: number }; features: FacetFeature[] }
export type FacetFeature =
  | { $type: 'app.bsky.richtext.facet#link'; uri: string }
  | { $type: 'app.bsky.richtext.facet#mention'; did: string }   // did = handle until resolved
  | { $type: 'app.bsky.richtext.facet#tag'; tag: string }

export interface RenderedPost { text: string; facets: Facet[]; images: ImageRef[]; linkCardUrl?: string; graphemes: number; bytes: number }
export interface RenderedFile { file: ParsedFile; posts: RenderedPost[] }   // posts.length >= 1

export interface PostRef { rkey: string; uri: string; cid?: string }        // cid absent = not yet confirmed on the PDS
export interface StateEntry { hash: string; did: string; postedAt?: string; posts: PostRef[] } // postedAt set when complete
export interface State { version: 1; posts: Record<string, StateEntry> }   // keyed by relPath (posix separators)

export interface RunOptions { /* §4 fields */ mode?: 'post' | 'init'; logger?: Logger }
export interface Logger { info(msg: string): void; warn(msg: string): void; error(msg: string): void; debug(msg: string): void }
export interface RunResult {
  posted: { relPath: string; posts: PostRef[] }[];
  resumed: { relPath: string; posts: PostRef[] }[];
  skipped: { relPath: string; reason: 'draft' | 'posted' | 'changed' | 'limit' }[];
  rendered: RenderedFile[];           // everything rendered this run (dry-run fills this)
  did?: string;
}
```

## 7. Pipeline

```
discover(dir) → parseFile(path) → render(parsed, opts) → plan(state, pds) → publish(agent, rendered) → state.write → git.commit?
```

### 7.1 discover (`src/discover.ts`)
Recursive `*.md` under `dir`, sorted by path, excluding `_*` and `.*` names and `node_modules`. Symlinks are followed, but a directory (by real path) is entered at most once, so a symlink loop ends. Returns absolute paths and `relPath` (posix, relative to the **key root**).

The key root is the nearest directory at or above `dir` (resolved against `cwd`) that contains a `.git` entry (a directory, or a file in a worktree or submodule); outside a git work tree it is `cwd`. `relPath` is both the state key and the input to the record key (§7.4), so it must not depend on where the tool is run from: `post-together --dir posts` at the repository root and `post-together --dir .` inside `posts/` give the same keys. `render <file>` uses the same rule.

### 7.2 parse (`src/parse.ts`, `src/frontmatter.ts`)
Read file, split frontmatter (`yaml` package, validate keys and types), hash the raw file bytes (`sha256:` + hex), parse body with `mdast-util-from-markdown`, walk to `Segment[]` per §5. Image paths are resolved against the file's directory and checked for existence and size at parse time so dry-run reports problems.

### 7.3 render (`src/render.ts`, `src/split.ts`, `src/facets.ts`)
For each segment produce one or more `RenderedPost`:
- Join blocks to text; record link-run byte ranges (UTF-8 offsets via `TextEncoder`) as manual link facets.
- Run `new RichText({ text }).detectFacetsWithoutResolution()` for tags, bare links and mentions; drop any detected facet that overlaps a manual facet. Mention facets keep the handle in `did` until publish resolves them.
- When `thread: auto` and a segment exceeds 300 graphemes or 3000 bytes, split it into a thread. Split at block boundaries first; if one block is still too long, split at sentence boundaries (`. `, `! `, `? `, `\n`), then at word boundaries. Never split inside a link run. Images attach to the post containing their block. With `threadCounter`, reserve 8 graphemes per post for ` (i/n)` during splitting, then append the counter (only when the thread has more than one post).
- `thread: manual` splits only on `---` and errors if any post exceeds limits. `thread: off` errors on any `---` or overflow. The error names the file and the offending post's grapheme count.
- `linkCardUrl`: from frontmatter `link` if a URL; `auto` (or unset with `linkCards` on) → the first link facet's URI in that post; only set when the post has no images.
- `graphemes` and `bytes` are recorded on every rendered post.

### 7.4 record keys and idempotency (`src/rkey.ts`)
Bluesky has no server-side dedupe, and Spindle cannot push a state file back (no credentials). So every post gets a **deterministic record key** derived from the file, and existence is checked on the PDS before creating.

- `rkey(relPath, index)`: `h = sha256("post-together:v1:" + relPath + "#" + index)`; take the first 8 bytes as an unsigned 64-bit big-endian integer `n`; `micros = 1672531200000000n + (n % 94608000000000n)` (a microsecond timestamp inside 2023-01-01 .. 2025-12-31 UTC); `clockid = Number((n >> 54n) & 1023n)`; return `TID.fromTime(Number(micros), clockid).toString()` (13 chars; verified to match `^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$`). The PDS validates only the format of a TID, not its timestamp.
- The AT-URI is known before posting: `at://<did>/app.bsky.feed.post/<rkey>`.
- Consequence to document: renaming or moving a file gives it new keys, so it would be posted again unless the state file says otherwise.
- The keys depend only on the path and index, so a record found under them may belong to an earlier version of the file, or to a different file that once had the same path (in another repository posting to the same account, say). §7.5 therefore compares text before reusing a record.

### 7.5 plan (`src/publish.ts`)
For each rendered file, decide: `skip:draft`, `skip:posted` (state entry complete and hash matches), `skip:changed` (state entry exists and hash differs, warn), `skip:limit`, or `post`. Then, for files to post, and for files whose state entry is incomplete (some post lacks `cid`), check the PDS: `agent.com.atproto.repo.getRecord({ repo: did, collection: 'app.bsky.feed.post', rkey })` for each post index in order. A found record yields `{ uri, cid, value }`; `RecordNotFound` (XRPCError `error === 'RecordNotFound'`, HTTP 400) means create it. A found record is reused only when `value.text` equals the rendered post's text. If any found record's text differs, the file is reported as `skip:changed` with a warning, and nothing is created or written to state for it; otherwise a mixed thread would result (new posts replying to an old one). This is the only change detection available with `stateFile: 'none'`. If every post already exists with matching text, the file is recorded as complete in state and reported under `resumed` without creating anything.

### 7.6 publish (`src/bluesky.ts`, `src/publish.ts`)
- One login per run. `did = agent.assertDid`.
- Per file, in post order: resolve mention handles via `agent.resolveHandle` (cache per run; on failure drop the facet and log a warning), upload images (`agent.uploadBlob(bytes, { encoding: mime })`), fetch link card metadata (`src/linkcard.ts`: GET with a 10 s `AbortSignal.timeout`, `user-agent: post-together`, read at most 512,000 bytes of the page, parse `og:title`, `og:description`, `og:image` and `<title>` with regexes tolerant of attribute order, resolve `og:image` against the page URL, upload the thumb only if ≤ 1,000,000 bytes (the body is read with that cap, whether or not `content-length` is sent) and `content-type` starts with `image/`; on any failure post without a card and warn), then create the record: `agent.com.atproto.repo.createRecord({ repo: did, collection: 'app.bsky.feed.post', rkey, record })` where `record = { $type: 'app.bsky.feed.post', text, facets, embed?, langs?, createdAt, reply? }`.
- Before the first network write for a file, write the state entry with all `rkey`/`uri` values and no `cid`s (so a crash leaves a resumable entry). After each successful create, write the `cid`. When all posts have a `cid`, set `postedAt`.
- Thread: first post has no `reply`; each subsequent post has `reply: { root: first, parent: previous }` with `{ uri, cid }` strong refs. `createdAt` for post i is `base + i` seconds so replies sort after their parent.
- Files are posted sequentially; `limit` caps how many files.
- Errors (`XRPCError` from `@atproto/api`): `status 429` → stop the run, keep state, exit non-zero with the `retry-after` header in the message. `status 401` or `error === 'AuthenticationRequired'` → message naming the identifier and hinting at app passwords. `error === 'InvalidRequest'` → report the PDS message and the file; do not retry. `RecordNotFound` is only expected from `getRecord`. Anything else rethrows. Never print the password; when logging options replace it with `***`.
- `init` mode: no login. Every discovered non-draft file gets a state entry `{ hash, did: '', postedAt: now, posts: [] }`. With `dryRun`, the files are listed and nothing is written or committed.

### 7.7 state (`src/state.ts`)
Read JSON (missing file → empty state; `version !== 1` → error). `stateFile: 'none'` disables reads and writes; dedupe then relies on 7.5 alone. Writes are atomic (temp file + rename), pretty-printed with a trailing newline, and happen after every change. Entries with `posts: []` and `postedAt` count as complete.

### 7.8 git (`src/git.ts`)
When `commit` is on and the state file changed: `git add <state>`, `git commit -m <msg>`, `git push`. Author/committer: `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` if set, else on GitHub `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`, else `post-together <post-together@users.noreply.tangled.org>`, passed with `-c user.name=... -c user.email=...`. Skip with a warning (not an error) when not in a git repo, on a detached HEAD, or when `git push` fails; the posts were already made, so the run still succeeds. On GitHub the workflow needs `permissions: contents: write`; pushes made with `GITHUB_TOKEN` do not retrigger workflows, so no `[skip ci]` is needed. On Spindle the checkout is a detached HEAD with no push credentials, so `commit` is documented as GitHub-only. The commit step runs after the posting loop even when a file fails (a `finally`), so files posted before the failure are recorded in the repository; the original error is still raised.

## 8. Surfaces

### 8.1 GitHub Action (`action.yml`, `src/action.ts`)
- `runs: { using: node24, main: dist/action.js }`. `node24` is the only runtime GitHub hosts today (Node 20 removed 2026-09-23).
- Inputs mirror §4 in kebab-case plus `mode`. `app-password` is `required: false` (dry-run) and validated in code. Call `core.setSecret(password)` before anything else.
- Outputs: `posted-count`, `posted` (JSON array of `{ file, uris }`), `skipped-count`.
- Step summary: a Markdown table of posted files with links `https://bsky.app/profile/<did>/post/<rkey>`.
- Logging: `core.info/warning/error/debug`; `core.setFailed` on error.
- `branding: { icon: 'send', color: 'blue' }`.
- The action bundle imports `run` from `./index.js`; nothing in `src/index.ts` or below imports `@actions/core`.

### 8.2 Tangled Spindle (`examples/workflows/tangled/post.yml`)
Spindle has no `uses:`; a step runs shell commands in bash with secrets injected as env vars. Ship two example workflows (nixery and microvm) under `examples/`, where they never run in this repository, and document both in the README:
```yaml
when:
  - event: ["push", "manual"]
    branch: ["main"]
engine: nixery
clone:
  submodules: false
  tags: false
dependencies:
  nixpkgs:
    - nodejs_24
environment:
  NO_COLOR: "1"
steps:
  - name: post to bluesky
    command: |
      set -euo pipefail
      npx --yes @cutenode/post-together@1 --dir posts --state-file none
```
Secrets `BSKY_IDENTIFIER` and `BSKY_APP_PASSWORD` are added under the repo's Settings → Pipelines → Secrets. The microvm variant is `engine: microvm`, `image: nixos`, `dependencies: [nodejs_24]`. Hosted Spindle has a 15 minute workflow timeout.

### 8.3 CLI (`src/cli.ts`)
- `parseArgs` with `allowPositionals` for the subcommand. `--help`, `--version` (read from `package.json` via `createRequire`).
- Exit codes: `0` success, `1` posting/config error, `2` usage error.
- Output, one line per file: `posted posts/hello.md → https://bsky.app/profile/<did>/post/<rkey> (2 posts)`; `skipped posts/old.md (already posted)`; dry-run prints each rendered post's text, grapheme count, facets and embeds in a readable block.
- Detects GitHub (`GITHUB_ACTIONS=true`) only to pick the git identity; never writes `::` workflow commands.

## 9. Repository layout

```
action.yml  package.json  package-lock.json  tsconfig.json  .node-version  .gitignore  README.md  LICENSE (MIT)
src/{index,cli,action,config,discover,frontmatter,parse,render,split,facets,rkey,bluesky,linkcard,publish,state,git,log,types}.ts
test/*.test.ts  test/fixtures/**  test/fake-pds.ts
dist/action.js (committed)   dist/{index,cli}.js + .d.ts (gitignored; built on publish)
examples/posts/*.md (+ an image)
.github/workflows/{ci.yml,check-dist.yml,release.yml}
.tangled/workflows/ci.yml
examples/workflows/github/post.yml  examples/workflows/tangled/{post.yml,post-microvm.yml}   (consumer examples; never run here)
docs/{SPEC,RESEARCH}.md  docs/research/*.md
```
`package.json`: name `@cutenode/post-together` (`publishConfig.access: "public"`, required for a scoped package). Scripts: `build` (tsc + esbuild action bundle), `build:action`, `typecheck`, `test`, `check-dist`. `bin: { "post-together": "dist/cli.js" }`, `exports: { ".": "./dist/index.js" }`, `files: ["dist", "!dist/action.js", "!dist/action.d.ts"]`.

## 10. Testing

- Unit (`vitest`): frontmatter (variants, bad YAML, unknown keys, bad types), render (every row of the §5 table, byte offsets with multi-byte characters and emoji, overlapping facet precedence, image-only paragraphs), split (300-grapheme edge cases, ZWJ emoji, counters, never splitting a link, manual/off errors), rkey (determinism, format regex, distinct for different inputs), state (missing file, version check, hash mismatch, atomic write), config (three-layer precedence, boolean parsing, `INPUT_*` names incl. hyphen).
- Integration: `test/fake-pds.ts` is a `node:http` server implementing `com.atproto.server.createSession` (returns no `didDoc`, so the client keeps using the fake origin), `com.atproto.identity.resolveHandle`, `com.atproto.repo.uploadBlob`, `com.atproto.repo.getRecord`, `com.atproto.repo.createRecord`, recording every request. Tests run the real `@atproto/api` client against it and assert record shapes, client-supplied rkeys, thread `reply` chains, blob refs, resume without duplicates, and 429 handling.
- Surface smoke (in CI): `node dist/cli.js --dry-run --dir examples/posts` and `env INPUT_DRY-RUN=true INPUT_DIR=examples/posts GITHUB_OUTPUT=$(mktemp) GITHUB_STEP_SUMMARY=$(mktemp) node dist/action.js` (the `env` prefix is required because a hyphen is not legal in a shell variable assignment).
- `check-dist` workflow: rebuild and `git diff --exit-code dist/action.js`.

## 11. Acceptance checklist

- [ ] `npm run build`, `npm test`, `npm run typecheck` pass on Node 22 and 24.
- [ ] `examples/posts` renders in dry-run as: a single post; a 2-post manual thread; an auto-split thread with link facets intact; a post with an image embed; a post with a link card.
- [ ] Fake-PDS integration test posts a 3-post thread and asserts the reply chain and deterministic rkeys.
- [ ] Fake-PDS integration test: a state entry missing a `cid` resumes without duplicating the existing record; with `state-file none`, a second run creates nothing, and an edited file is skipped as changed instead of extending the old thread.
- [ ] Running from a subdirectory of the repository gives the same state and record keys.
- [ ] `action.yml` inputs, the README table and §4 agree.
- [ ] Spindle example workflows use only keys from RESEARCH (`when`, `engine`, `clone`, `dependencies`, `environment`, `steps[].name/command/environment`, `image`).
