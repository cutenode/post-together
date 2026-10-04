# post-together

Post Markdown files from a directory to Bluesky. Each `*.md` file becomes one post or one thread. The same code runs as a GitHub Action, as a step in a Tangled Spindle workflow, or as a plain CLI; only the way options are gathered and the log format differ.

## How it works

1. post-together searches `dir` (default `posts`) recursively for `*.md` files. Names starting with `_` or `.` and `node_modules` directories are skipped.
2. Frontmatter is validated, the Markdown body becomes plain text with link, mention and hashtag facets, images become embeds, and text longer than one post is split into a thread.
3. Every post gets a deterministic record key derived from the file's path and its position in the thread (`sha256("post-together:v1:<relPath>#<index>")`, encoded as a TID). The post's AT-URI, `at://<did>/app.bsky.feed.post/<rkey>`, is therefore known before anything is sent.
4. Before creating a record, post-together asks the PDS whether a record with that key already exists, and reuses the existing record if it does. This is why a file is posted at most once even when there is no state file, and why an interrupted run can be resumed without duplicates.
5. Results are written to `<dir>/.post-together.json` unless the state file is disabled. On GitHub the action can commit that file back to the repository.

Bluesky has no server-side deduplication, so only the deterministic keys and the optional state file stop a rerun from posting a file again.

Non-goals for v1: no OAuth (app passwords only; headless CI has no browser), no editing or deleting posts (a file changed after posting only produces a warning), no video embeds, no scheduling.

## Quick start

### GitHub Action

Copy this file to `.github/workflows/post.yml` in your repository. It posts new files under `posts/` on every push to `main` that touches that directory, then commits the updated state file. The same file is in this repository as [`examples/workflows/github/post.yml`](examples/workflows/github/post.yml).

```yaml
name: Post to Bluesky

on:
  push:
    branches: [main]
    paths:
      - "posts/**"

# Serialize runs; two pushes must not post in parallel or race to commit the state file.
concurrency:
  group: post-together
  cancel-in-progress: false

# commit: true pushes posts/.post-together.json back with GITHUB_TOKEN.
permissions:
  contents: write

jobs:
  post:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: cutenode/post-together@v1
        with:
          identifier: ${{ vars.BSKY_IDENTIFIER }}
          app-password: ${{ secrets.BSKY_APP_PASSWORD }}
          dir: posts
          commit: true
```

Set a repository variable `BSKY_IDENTIFIER` (your handle, email or DID) and a repository secret `BSKY_APP_PASSWORD` (an app password created in the Bluesky app, never your account password).

Inputs are the kebab-case names in the [configuration table](#configuration) plus `mode` (`post`, the default, or `init`). Outputs: `posted-count`, `posted` (a JSON array of `{ file, uris }`), `skipped-count`. The action also writes a table of posted files with `https://bsky.app/profile/<did>/post/<rkey>` links to the job summary.

Pushes made with `GITHUB_TOKEN` do not trigger workflows, so the commit cannot start another run and no `[skip ci]` marker is needed. Pull requests from forks get a read-only token, so keep the trigger on `push` to your default branch.

### Tangled Spindle

Spindle has no `uses:`; a step is a shell command. Copy this file to `.tangled/workflows/post.yml` in your repository. It is in this repository as [`examples/workflows/tangled/post.yml`](examples/workflows/tangled/post.yml).

```yaml
when:
  - event: ["push", "manual"]
    branch: ["main"]
    paths: ["posts/**"]

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

Add the two secrets under the repository's Settings → Pipelines → Secrets: `BSKY_IDENTIFIER` and `BSKY_APP_PASSWORD`. Spindle injects secrets into every step as environment variables and masks their values as `***` in logs. Keys must match `^[a-zA-Z_][a-zA-Z0-9_]*$` and values are limited to 200 characters. Do not put them under `environment:`, which anyone who can see the repository can read.

`--state-file none` is used because the Spindle checkout is a detached HEAD with no push credentials, so a state file could not be committed back (see [State and idempotency](#state-and-idempotency)). `NO_COLOR` is set because Tangled's UI renders ANSI colour codes as raw text. `clone.submodules` and `clone.tags` are set explicitly because omitted values compile to `true`.

The microvm variant, [`examples/workflows/tangled/post-microvm.yml`](examples/workflows/tangled/post-microvm.yml), differs only in the engine block: `engine: microvm`, `image: nixos`, and `dependencies` as a flat list (`- nodejs_24`) instead of the nixery registry map. Secrets are configured in the same place. Keep one of the two files; every workflow file in `.tangled/workflows/` runs in parallel on each event. The hosted Spindle has a 15 minute workflow timeout.

### CLI

```bash
export BSKY_IDENTIFIER=you.bsky.social
export BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx

npx @cutenode/post-together --dir posts
```

Output is one line per file:

```
posted posts/hello.md → https://bsky.app/profile/<did>/post/<rkey> (2 posts)
skipped posts/old.md (already posted)
```

Other invocations:

| Command | What it does |
|---|---|
| `npx @cutenode/post-together --dry-run --dir posts` | Render and print every post that would be created: text, grapheme count, facets, embeds. No login, no network, no state writes. Credentials are not required. |
| `npx @cutenode/post-together render posts/hello.md` | Print the rendered posts for one file as JSON. No network. |
| `npx @cutenode/post-together init --dir posts` | Mark every current non-draft file as posted without posting anything, and write the state file. Requires a state file (not `none`). With `--dry-run` it lists the files it would mark and writes nothing. |
| `npx @cutenode/post-together --help`, `--version` | Usage and version. |

Requires Node 22 or later. A global install (`npm i -g @cutenode/post-together`) makes the same commands available under the name `post-together`. The CLI can be run from a GitHub `run:` step too; it reads `INPUT_*` variables as a last-resort fallback so the same binary works there.

## Markdown file contract

Each `*.md` file under `dir` is one post or one thread. Files whose name starts with `_` or `.` are ignored, as are `node_modules` directories. Frontmatter is optional YAML between `---` fences at the very top of the file.

```yaml
---
draft: true                 # skip this file entirely (default false)
langs: [en]                 # up to 3 BCP-47 codes for app.bsky.feed.post.langs (default: none)
createdAt: 2026-09-28T09:00:00Z  # override post timestamp (default: now). Must parse as a date; re-serialised with toISOString()
link: https://example.com   # link card URL. Also `auto` (first link in the post; the default when linkCards is on) or `false`
thread: auto                # auto | manual | off (default auto). See Threads
---
```

Unknown frontmatter keys are an error naming the key and file. Wrong types are an error.

Body rendering rules (Markdown to plain text; Bluesky has no markup):

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

Whitespace: 3 or more consecutive newlines collapse to 2, and each post is trimmed. A block that renders to empty text (for example an image-only paragraph) contributes no text and no blank line.

A post is limited to 300 graphemes and 3,000 UTF-8 bytes. Graphemes are counted the way Bluesky counts them (`Intl.Segmenter`; a family emoji is one grapheme) and URLs in the text count in full. Link text does not need to be the URL, so `[short text](https://long.example/url)` is the way to save characters.

The files in [`examples/posts/`](examples/posts/) cover each case: a single post, a two-post manual thread, an auto-split thread with a link across the split point, a post with an image, and a post with a link card. `_template.md` there documents every frontmatter key and is ignored by the tool because of the leading underscore.

## Configuration

One options object, resolved from three layers. Later layers win.

1. GitHub Action inputs, delivered as `INPUT_<NAME>` environment variables (uppercased; hyphens kept, for example `INPUT_APP-PASSWORD`). The CLI also reads these as a last-resort fallback.
2. Environment variables.
3. CLI flags.

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
| `cwd` | `--cwd` | — | — | `process.cwd()` | Base for relative paths (`dir`, `stateFile`). State and record keys are relative to the repository root instead; see [State and idempotency](#state-and-idempotency) |

Booleans accept `true`, `false`, `1`, `0`, `yes`, `no`, case-insensitively; anything else is a usage error.

The action has one extra input, `mode` (`post` or `init`), matching the CLI's `init` subcommand. `service` defaults to Bluesky's entryway; login reads the account's DID document and routes later calls to its PDS, so a self-hosted PDS URL only has to be given for accounts that live there.

Precedence example: in a Spindle step, `BSKY_APP_PASSWORD` comes from the secret store and `--dir` from the command line.

## State and idempotency

The state file, `<dir>/.post-together.json` by default, records what has been posted:

```json
{
  "version": 1,
  "posts": {
    "posts/2026-09-28-hello.md": {
      "hash": "sha256:…",
      "did": "did:plc:…",
      "postedAt": "2026-09-28T09:00:03.000Z",
      "posts": [
        { "rkey": "3k…", "uri": "at://did:plc:…/app.bsky.feed.post/3k…", "cid": "bafy…" },
        { "rkey": "3k…", "uri": "at://did:plc:…/app.bsky.feed.post/3k…", "cid": "bafy…" }
      ]
    }
  }
}
```

Entries are keyed by the file's path relative to the repository root, with `/` separators. The repository root is the nearest directory at or above `dir` that contains `.git`; outside a git work tree it is `cwd`. Record keys are derived from the same path, so running from a subdirectory (`cd posts && post-together --dir .`) finds the same entries and the same records instead of posting everything again. `hash` is the SHA-256 of the raw file bytes. Writes are atomic (temp file plus rename) and happen after every change. A missing file is an empty state; any `version` other than `1` is an error.

On each run, a file is:

| Decision | When |
|---|---|
| skipped (`draft`) | frontmatter `draft: true` |
| skipped (`posted`) | its state entry is complete and the hash matches |
| skipped (`changed`) | its state entry exists but the hash differs, or a record already on the PDS under one of its keys has different text. A warning is logged; v1 does not edit posts |
| skipped (`limit`) | `limit` files have already been posted this run |
| posted | otherwise |

So that a crashed run can be resumed, a file's state entry is written before its first network write, with every `rkey` and `uri` but no `cid`. After each successful create the `cid` is filled in, and `postedAt` is set once every post has one. If the run dies part-way (a network error, the Spindle timeout, a cancelled job), the next run finds the incomplete entry, asks the PDS for each key in order, reuses the records that exist (after checking that their text matches) and creates only the missing ones, so a thread continues from where it stopped without duplicates. The file is reported as resumed.

With `--state-file none`, nothing is read or written locally. Instead, every non-draft file is checked on the PDS by its deterministic keys on every run: if all of its records exist it is reported as resumed and nothing is created; otherwise the missing records are created. Each existing record's text is compared with the rendered post first. If any differs (the file was edited after posting, or another file once used the same path), the file is skipped as `changed` with a warning and nothing is created, so an edit can never hang new posts under an old thread. Two consequences remain: an edit that leaves the post text unchanged (frontmatter, images or link card only) is not noticed, and each run costs one `getRecord` per post already made.

Renaming or moving a file changes its path, so it gets new keys and would be posted again, unless the state file has an entry for the new path.

Spindle cannot commit the state file, because its clone is `git fetch --depth=1 origin <sha>` followed by `git checkout FETCH_HEAD`: a detached HEAD with no local branch, and no credentials that could push to the knot. The `commit` option is therefore supported on GitHub only; on Spindle use `--state-file none`.

When `commit` is on and the state file changed, post-together runs `git add <state>`, `git commit -m <message>`, `git push` as `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` if set, else `github-actions[bot]` on GitHub, else `post-together <post-together@users.noreply.tangled.org>`. Not being in a git repository, a detached HEAD, or a failed push only produces a warning: the posts were already made, so the run still succeeds. The commit is also attempted when a later file fails (a 429, say), so the files posted before the failure are recorded in the repository.

To adopt a `posts/` directory that already holds files you have published some other way, run `npx @cutenode/post-together init --dir posts` (or the action with `mode: init`). Every discovered non-draft file gets a state entry `{ hash, did: "", postedAt: <now>, posts: [] }` without logging in or posting; such entries count as complete. Commit the resulting file, and only files added afterwards will be posted. `init` requires a state file. Add `--dry-run` (`dry-run: true`) to see which files it would mark without writing anything.

## Threads

A `---` on its own line ends one post and starts the next. What happens to text that is too long for a post depends on the `thread` frontmatter key:

| `thread` | Behaviour |
|---|---|
| `auto` (default) | Splits on `---`, and also splits any segment over 300 graphemes or 3,000 bytes |
| `manual` | Splits only on `---`. A post over the limit is an error |
| `off` | One post. Any `---` or overflow is an error |

Errors name the file and the offending post's grapheme count.

Auto-splitting works from the coarsest boundary down: between blocks (paragraphs, list items, and so on) first; if a single block is still too long, at sentence boundaries (`. `, `! `, `? `, newline); then at word boundaries. It never splits inside a link, and each post keeps the link facets that fall inside it with byte offsets recomputed for that post. Images stay attached to the post that contains their block.

`--thread-counter` (`thread-counter: true`, `POST_TOGETHER_THREAD_COUNTER=true`) appends ` (i/n)` to each post of a thread with more than one post. Eight graphemes per post are reserved for the counter while splitting, so the limit still holds after it is added. Single-post files get no counter.

Posts are created in order. The first has no `reply`; every later post carries `reply: { root, parent }` strong references to the first and the previous post. Post `i` gets `createdAt` of the base time plus `i` seconds so replies sort after their parent. Files are posted one at a time; `limit` caps how many files a run posts.

## Images and link cards

An image written as `![alt](./relative/path.png)` anywhere in a post is removed from the text and attached as an embed on that post. Paths resolve relative to the Markdown file and are checked for existence, size and extension at parse time, so a dry run reports problems.

| Limit | Value |
|---|---|
| Images per post | 4. A 5th is an error |
| Size per image | 2,000,000 bytes |
| Formats | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` (`image/png`, `image/jpeg`, `image/webp`, `image/gif`). Other extensions are an error |
| Alt text | The Markdown `alt`, sent as the embed's `alt` |

A post that has no images can carry one external link card. Its URL comes from the frontmatter `link` key: a URL, `auto` (the first link facet in that post; the default while link cards are enabled), or `false`. The server does not build cards, so post-together builds them on the client: it fetches the page (10 second timeout, `user-agent: post-together`, at most the first 512,000 bytes), reads `og:title`, `og:description`, `og:image` and `<title>`, resolves `og:image` against the page URL, and uploads the image as the card's thumbnail only if it is at most 1,000,000 bytes and served with an `image/*` content type. If any of that fails, the post is made without a card and a warning is logged. `--no-link-cards` (`link-cards: false`, `POST_TOGETHER_LINK_CARDS=false`) turns cards off for the whole run.

A Bluesky post has exactly one embed, and no embed type combines images with an external link, so a post with images never gets a card even when `link` is set. A bare URL in the text is still a clickable link facet.

## Errors and exit codes

CLI exit codes:

| Code | Meaning |
|---|---|
| `0` | Success (including runs where every file was skipped) |
| `1` | Posting or configuration error |
| `2` | Usage error: unknown flag or subcommand, bad boolean value, missing argument |

In the action, any error calls `setFailed`, which fails the step.

| Situation | Behaviour |
|---|---|
| HTTP 429 `RateLimitExceeded` | The run stops, state is kept, the exit is non-zero and the message includes the `retry-after` header. Rerun later; already-created posts are resumed |
| HTTP 401 or `AuthenticationRequired` | The message names the identifier and points at app passwords (an account password does not work) |
| `InvalidRequest` | The PDS message and the file are reported. Not retried: fix the file |
| Unresolvable `@mention` | The facet is dropped with a warning and the handle stays as plain text |
| Link card fetch fails | Warning; the post is made without a card |
| `commit` cannot push | Warning; the posts were made, so the run succeeds |
| Unsupported Markdown, bad frontmatter, too many or too large images, post over the limit under `manual`/`off` | Error naming the file (and line where possible); a dry run reports the same, so problems can be caught before posting |

The app password is never printed; when options are logged it is replaced with `***`. The action also registers it as a masked secret.

Bluesky-hosted PDSs allow 5,000 repo-write points per hour and 35,000 per day per account, with a create costing 3 points: 1,666 creates per hour and 11,666 per day. Logins (`createSession`) are limited to 30 per 5 minutes and 300 per day per identifier and IP; post-together logs in once per run. All endpoints together are limited to 3,000 requests per 5 minutes per IP. A CI job posting a handful of files per run is far below every one of these, so rate limits are not a practical concern. If a 429 does happen, the run stops cleanly and can be rerun.

## Development

This repository's own checks run in two places: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on GitHub and [`.tangled/workflows/ci.yml`](.tangled/workflows/ci.yml) on a Tangled Spindle. Both typecheck, test, build, and run the two dry-run smoke checks.

Node 24 is pinned in `.node-version`; [`fnm`](https://github.com/Schniz/fnm) picks it up with `fnm use`. The package requires Node 22 or later and CI runs the tests on both 22 and 24.

```bash
fnm use
npm ci
npm run build        # tsc → dist/index.js, dist/cli.js, .d.ts; esbuild → dist/action.js
npm test             # vitest: unit tests plus integration tests against a fake PDS
npm run typecheck
npm run check-dist   # rebuild dist/action.js and fail if it differs from the committed file
```

`dist/action.js` is a single-file ESM bundle that GitHub runs directly from the repository at the requested ref, with no install step, so it is committed. Rebuild and commit it with every source change; the `check-dist` workflow rejects pull requests where it is stale. The bundle is not minified, so its diffs stay readable, and it is excluded from the npm package together with its type declarations and `action.yml` (`files` lists `!dist/action.js` and `!dist/action.d.ts`). `@actions/core` is therefore a dev dependency: esbuild bundles it, and npm installs of the CLI or library never need it.

Smoke tests, run in CI after the build:

```bash
node dist/cli.js --dry-run --dir examples/posts
env INPUT_DRY-RUN=true INPUT_DIR=examples/posts GITHUB_OUTPUT=$(mktemp) GITHUB_STEP_SUMMARY=$(mktemp) node dist/action.js
```

(`env` is needed for the second one: `INPUT_DRY-RUN` is not a valid shell variable name.)

Releases follow the GitHub Actions convention of an exact tag plus a moving major tag:

```bash
# after bumping package.json, rebuilding, and committing dist/action.js
git tag -a v1.2.3 -m "v1.2.3"
git push --follow-tags
git tag -fa v1 -m "Update v1 tag"
git push origin v1 --force
```

The very first version cannot come from the release workflow, because npm can only attach a trusted publisher to a package that already exists. Publish it by hand (`npm login` with 2FA, then `npm publish`), or stage it with `npm stage publish` (npm 11.15 or later) and approve it on npmjs.com. Then, under the package's Settings → Trusted publishing, add the repository `cutenode/post-together`, the workflow `release.yml` and the environment `npm`, and allow `npm publish`. Create the moving `v1` tag at the same commit so `uses: cutenode/post-together@v1` resolves.

Pushing `v1.2.3` runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which checks the tag against `package.json`, reruns the typecheck, tests and build, confirms `dist/action.js` is current, and publishes to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers): no npm token is stored anywhere, and each version carries a provenance attestation linking it to the workflow run. A prerelease tag (`v1.2.3-rc.1`) publishes under the `next` dist-tag. The moving `v1` tag does not match the workflow's tag filter, so updating it publishes nothing.

Consumers referencing `cutenode/post-together@v1` get the latest `1.x`; `@v1.2.3` or a full 40-character commit SHA pins an exact version. A breaking change gets a new major tag (`v2`) and leaves `v1` where it is. The Spindle examples pin the npm package the same way (`@cutenode/post-together@1`).

## Verified facts

The behaviour described above rests on facts checked against primary sources on 2026-09-28: the `@atproto/api` 0.21 client and lexicons (length limits, facet byte offsets, embed shapes, client-supplied TID record keys, rate limits, error shapes), the GitHub Actions metadata and runner behaviour (`node24`, `INPUT_*` naming, committed `dist/`, token permissions), and the Tangled Spindle workflow schema (allowed keys, engines, secrets, clone behaviour, limits). The package now depends on `@atproto/api` 0.23, whose session, agent, rich-text and `com.atproto.repo` code is unchanged from 0.21. The decision digest is in [`docs/RESEARCH.md`](docs/RESEARCH.md); the full reports with citations and any items marked unverified are in [`docs/research/`](docs/research/). The design is in [`docs/SPEC.md`](docs/SPEC.md).
