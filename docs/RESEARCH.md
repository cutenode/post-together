# post-together: research digest

Verified 2026-09-28. Each decision below links to the full report with citations in `docs/research/`.
Implementers: read this file and `SPEC.md`; open a full report only when you need the exact quote.

## Decisions and the facts behind them

| Decision | Fact | Report |
|---|---|---|
| ESM only, Node ≥ 22 | `@atproto/api` 0.21.0 is pure ESM with `engines.node >= 22` since 0.20.0; `@actions/core` 3.x is ESM-only | bluesky-api §1, github-action §4 |
| `Agent` + `CredentialSession`, not `AtpAgent`/`BskyAgent` | `BskyAgent` is `@deprecated`; `AtpAgent` JSDoc says it "will be deprecated in the near future" | bluesky-api §2 |
| App passwords, no OAuth | Docs: OAuth "is not currently recommended as an auth solution for 'headless' clients, such as command-line tools or bots" | bluesky-api §2 |
| `service` defaults to `https://bsky.social` | It is the entryway; `CredentialSession.login()` reads the DID doc and routes later calls to the account's PDS automatically | bluesky-api §2 |
| 300 graphemes / 3000 bytes per post, URLs count in full | Lexicon `maxGraphemes: 300`, `maxLength: 3000`; enforced at `createRecord` → 400 `InvalidRequest` | bluesky-api §5 |
| Facet byte offsets are UTF-8 | Lexicon: `byteStart`/`byteEnd` are zero-indexed UTF-8 byte offsets, end exclusive; facets must not overlap | bluesky-api §4 |
| Link text may differ from URL | Lexicon: "The text URL may have been simplified or truncated, but the facet reference should be a complete URL" | bluesky-api §4 |
| Drop mentions that fail to resolve | `RichText.detectFacets` sets `did: ''` for unresolvable handles (verified in the installed 0.21.0 source) | bluesky-api §4 |
| Images ≤ 4 per post, ≤ 2,000,000 bytes each | `app.bsky.embed.images` lexicon: `maxLength: 4`, blob `maxSize: 2000000` | bluesky-api §7 |
| Link card thumb ≤ 1,000,000 bytes; client fetches OpenGraph itself | `app.bsky.embed.external` `thumb.maxSize: 1000000`; "each client fetches and embeds this card metadata" | bluesky-api §7 |
| A post cannot have both images and a link card | `embed` is a single union member; `recordWithMedia` is only for quote posts | bluesky-api §7 |
| Threads via `reply: { root, parent }` strong refs | Posts guide; `createRecord` returns the `{ uri, cid }` needed | bluesky-api §6 |
| Client-supplied deterministic record keys | `createRecord` accepts `rkey`; for `app.bsky.feed.post` it must be a TID matching `^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$`; the PDS validates format only. No server-side dedupe exists | bluesky-api §10 |
| Rate limits are not a concern for a CI bot | 1,666 creates/hour per account; login 30 per 5 min | bluesky-api §9 |
| `XRPCError` fields for error handling | `status`, `error` (e.g. `RateLimitExceeded`, `AuthenticationRequired`, `InvalidRequest`, `RecordNotFound`), `headers['retry-after']` | bluesky-api §11 |
| GitHub Action runtime `node24` | Node 20 removed from GitHub runners on 2026-09-23; docs list only `node20` and `node24` | github-action §1, §10 |
| `main: dist/action.js` as ESM with `"type": "module"` | The runner spawns `node <main>`; Node's normal module rules apply; the official template does exactly this | github-action §4 |
| Bundle with esbuild + `createRequire` banner | Verified in this session: without the banner the ESM bundle throws `Dynamic require of "..." is not supported` | github-action §4 |
| Commit `dist/action.js`, verify with `check-dist` | GitHub downloads the action repo and runs it as-is; no `npm install` at runtime | github-action §4 |
| Inputs arrive as `INPUT_<NAME>` with hyphens kept | Docs example: `INPUT_NUM-OCTOCATS`; `core.getInput` is `process.env['INPUT_' + name.replace(/ /g,'_').toUpperCase()]` | github-action §1, §2 |
| Commit-back on GitHub needs `contents: write`, bot identity, push events | Fork PRs get read-only tokens; PR checkouts are detached; `GITHUB_TOKEN` pushes do not retrigger workflows | github-action §8 |
| Spindle step = shell command; no `uses:` | Step fields are exactly `name`, `command`, `environment`; unknown keys are a hard error; blog: no marketplace by design | tangled-spindle §1, §5 |
| Spindle invocation is `npx --yes @cutenode/post-together@1` with `nodejs_24` from nixpkgs | Tangled's own workflows use `dependencies: nixpkgs: [nodejs]` + `npx --yes wrangler ...` | tangled-spindle §6, §8 |
| nixery `dependencies` is a map, microvm's is a list | Engine structs differ; provide both example workflows | tangled-spindle §1 |
| Spindle cannot commit the state file back | Clone is a detached HEAD via `git fetch origin <sha>` with no push credentials; secrets are ≤ 200 chars | tangled-spindle §2, §3 |
| Spindle secrets are plain env vars | Injected into every user step; masked as `***` in logs; key must match `^[a-zA-Z_][a-zA-Z0-9_]*$` | tangled-spindle §3 |
| Set `clone.submodules: false` and `tags: false` | Code compiles omitted values to `true` despite docs saying `false` | tangled-spindle §1 |
| `NO_COLOR=1` in Spindle examples | Tangled UI renders ANSI colour codes as raw text (Netlify example) | tangled-spindle §6 |
| Hosted Spindle workflow timeout is 15 min | Production config `workflowTimeout = "15m"` | tangled-spindle §7 |

## Environment variables each platform provides

| | GitHub Actions | Tangled Spindle |
|---|---|---|
| Always | `CI=true`, `GITHUB_ACTIONS=true` | `CI=true`, `TANGLED_PIPELINE_KIND` |
| Repo | `GITHUB_REPOSITORY` | `TANGLED_REPO_NAME`, `TANGLED_REPO_DID`, `TANGLED_REPO_URL` |
| Commit | `GITHUB_SHA` | `TANGLED_SHA` / `TANGLED_COMMIT_SHA` |
| Ref | `GITHUB_REF_NAME`, `GITHUB_REF_TYPE` | `TANGLED_REF_NAME`, `TANGLED_REF_TYPE` |
| Workspace | `GITHUB_WORKSPACE` | cwd is `/tangled/workspace` (nixery) or `/workspace/repo` (microvm) |
| Outputs | `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY` files | none |
| Push token | `GITHUB_TOKEN` (explicitly passed) | none |

## Verified in this session (not from web sources)

- `@atproto/api` 0.21.0 exports `Agent`, `CredentialSession`, `AtpAgent`, `RichText`, `XRPCError`, `AppBskyFeedPost`, `AppBskyEmbedImages`, `AppBskyEmbedExternal`, `AppBskyRichtextFacet`; `Agent.post()` returns `{ uri, cid }`; `agent.uploadBlob` and `agent.resolveHandle` exist; `uploadBlob` input is `string | Uint8Array | Blob` with `{ encoding }`.
- `@atproto/common-web` 0.5.12 exports `TID` with `nextStr()`, `fromTime(timestamp, clockid)`, `fromStr()`, `toString()`.
- `RichText.graphemeLength` counts a ZWJ family emoji as 1.
- Markdown → runs → facets prototype produced correct UTF-8 byte offsets for a link, a bare URL, a hashtag and a mention.
- Deterministic TIDs derived from sha256 of a key pass the TID regex.

## Open questions (UNVERIFIED in the reports)

- Whether the Bluesky app warns on link facets whose text differs from the URL.
- Whether the PDS rejects rkeys containing slurs (mentioned in one report without a source). Handle `InvalidRequest` on create by reporting the file and the PDS message.
- Whether Spindle withholds secrets from fork pull requests. The examples trigger only on `push` to the main branch.
- Exact shell in stock microvm images (docs say bash).
