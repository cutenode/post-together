# Posting to Bluesky from Node.js with `@atproto/api`

Research report, verified 2026-09-28. `docs.bsky.app/docs/*` pages now redirect to `bsky.network/docs/*` and API reference pages to `https://endpoints.bsky.app/`. Guide text was taken from the docs' Markdown source in `github.com/bluesky-social/bsky-docs` and library behaviour from `github.com/bluesky-social/atproto` at `main` plus the published `0.21.0` tarball. Items not confirmed are marked **UNVERIFIED**.

---

## 1. Package: version, Node, module format

| Fact | Value | Source |
|---|---|---|
| Latest `@atproto/api` | **0.21.0**, published 2026-09-25 | `npm view @atproto/api`; https://www.npmjs.com/package/@atproto/api |
| `engines.node` | **`>=22`** | https://github.com/bluesky-social/atproto/blob/main/packages/api/package.json |
| Module format | **Pure ESM**: `"type": "module"`, `exports: { ".": { types, default: ./dist/index.js } }`. No CJS build. | https://unpkg.com/@atproto/api@0.21.0/package.json |
| When that changed | 0.20.0: "**BREAKING:** Drop support for Node.js 18 and 20. Node.js 22 is now the minimum" and "**BREAKING:** Convert to pure ESM… Node.js 22's `require()` compatibility layer can still load these packages in CommonJS code." | https://github.com/bluesky-social/atproto/blob/main/packages/api/CHANGELOG.md |
| 0.21.0 changes | Only deprecations (legacy notification priority fields). Nothing affecting posting. | same CHANGELOG |
| README guidance | "We recommend using [lex]… our type-safe SDK with Lexicon code generation, for all new projects." (`@atproto/lex` 0.3.12, `@atproto/lex-password-session` 0.2.3 *preview*) | https://github.com/bluesky-social/atproto/blob/main/packages/api/README.md |

In practice: use `"type": "module"` and TypeScript `moduleResolution: "node16"`/`"nodenext"`/`"bundler"`.

---

## 2. Authentication for a bot / CI (app passwords)

**Current class names** (https://github.com/bluesky-social/atproto/blob/main/packages/api/src/index.ts):
- `Agent`: the base agent (takes a `SessionManager`).
- `CredentialSession`: username/app-password session manager (`login`, `resumeSession`, `refreshSession`, `logout`).
- `AtpAgent`: `Agent` + `CredentialSession` wrapper. Its JSDoc says "**This class will be deprecated in the near future.** Use `Agent` directly with a `CredentialSession` instead" (not yet tagged `@deprecated`). https://github.com/bluesky-social/atproto/blob/main/packages/api/src/atp-agent.ts
- `BskyAgent`: deprecated (`@deprecated use AtpAgent instead`). https://github.com/bluesky-social/atproto/blob/main/packages/api/src/bsky-agent.ts ; https://docs.bsky.app/blog/ts-api-refactor
- The package default export is `@deprecated`; use named imports.

The README marks the app-password path as "deprecated in favor of OAuth based session management" (a CAUTION note), but it is fully supported and is the only headless option.

**`login()` options** (`AtpAgentLoginOpts`, https://github.com/bluesky-social/atproto/blob/main/packages/api/src/types.ts):
```ts
interface AtpAgentLoginOpts { identifier: string; password: string; authFactorToken?: string; allowTakendown?: boolean }
```
`identifier` = handle, email, or DID.

**Which `service` URL.** `https://bsky.social` is Bluesky's "entryway"; Bluesky-hosted accounts live on PDS hosts like `https://<name>.<region>.host.bsky.network` (https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/api-directory.mdx). You do not need to resolve that yourself: `CredentialSession.login()` reads the `didDoc` returned by `createSession`, calls `getPdsEndpoint()` and sets `pdsUrl`; later requests dispatch to `pdsUrl || serviceUrl`. For a self-hosted account, pass that PDS's URL as `service`.

```ts
// auth.ts — Node 22+, ESM, @atproto/api@0.21.0
import { Agent, CredentialSession, type AtpSessionData } from '@atproto/api'

export async function makeAgent(): Promise<Agent> {
  const service = new URL(process.env.BSKY_SERVICE ?? 'https://bsky.social')
  const session = new CredentialSession(service, globalThis.fetch, (evt, data?: AtpSessionData) => {
    // evt: 'create' | 'create-failed' | 'update' | 'expired' | 'network-error'
  })
  await session.login({
    identifier: process.env.BSKY_IDENTIFIER!,     // handle / email / DID
    password: process.env.BSKY_APP_PASSWORD!,     // app password, xxxx-xxxx-xxxx-xxxx
  })
  const agent = new Agent(session)
  console.log('logged in as', agent.assertDid, 'pds =', session.pdsUrl?.href ?? service.href)
  return agent
}

// Equivalent short form (still supported in 0.21.0):
// import { AtpAgent } from '@atproto/api'
// const agent = new AtpAgent({ service: 'https://bsky.social' }); await agent.login({ identifier, password })
```
`CredentialSession.fetchHandler` auto-refreshes on HTTP 401 or a 400 `ExpiredToken` body using `refreshJwt`, then retries once.

**Resolving a handle → DID** (needed for mentions):
- `GET /xrpc/com.atproto.identity.resolveHandle?handle=…` → `{ did }`, error `HandleNotFound` (https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/identity/resolveHandle.json). In the SDK: `agent.resolveHandle({ handle })`.

**OAuth in headless CI: not viable.** The atproto OAuth profile has no client-credentials / machine flow: every grant is `authorization_code` with an interactive browser step, mandatory PKCE, PAR, DPoP, and a publicly hosted `client_id` metadata URL (https://atproto.com/specs/oauth). The docs say verbatim: "OAuth is not currently recommended as an auth solution for for "headless" clients, such as command-line tools or bots." The `@atproto/lex-password-session` README: app passwords "are designed for programmatic access (bots, scripts, CLI tools)".

---

## 3. Creating a post

**High-level** (https://unpkg.com/@atproto/api@0.21.0/dist/agent.d.ts):
```ts
post(record: Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'>): Promise<{ uri: string; cid: string }>
```
Implementation: `record.createdAt ||= new Date().toISOString(); return this.app.bsky.feed.post.create({ repo: this.accountDid }, record)`. That is exactly a `com.atproto.repo.createRecord` with `collection: 'app.bsky.feed.post'`.

```ts
const res = await agent.post({ text: 'Hello from CI', langs: ['en'] })
// res = { uri: 'at://did:plc:…/app.bsky.feed.post/3k4duaz5vfs2b', cid: 'bafyrei…' }
```

**Underlying call** (https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/createRecord.json):
```ts
const { data } = await agent.com.atproto.repo.createRecord({
  repo: agent.assertDid,
  collection: 'app.bsky.feed.post',
  record: { $type: 'app.bsky.feed.post', text: 'Hello', createdAt: new Date().toISOString() },
  // rkey?: string        (record-key, maxLength 512; see §10)
  // validate?: boolean
  // swapCommit?: string  (CAS on repo head CID; error 'InvalidSwap')
})
// data: { uri: string; cid: string; commit?: { cid: string; rev: string }; validationStatus?: 'valid' | 'unknown' }
```
Server behaviour: if `record.$type` is missing it is set to `collection`; a mismatching `$type`, an invalid rkey, or a schema violation throws 400 `InvalidRequest` with messages like `Invalid app.bsky.feed.post record: …`.

**Record schema** (`app.bsky.feed.post`, key type `tid`, https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json): required `text` (maxLength 3000 bytes, maxGraphemes 300; "May be an empty string, if there are embeds") and `createdAt` (format `datetime`). Optional `facets`, `reply`, `embed` (union of `app.bsky.embed.images | video | gallery | external | record | recordWithMedia`), `langs` (max 3, format `language`), `labels`, `tags` (max 8; each maxLength 640 / maxGraphemes 64).

---

## 4. Rich text (`RichText`, facets)

Sources: https://github.com/bluesky-social/atproto/blob/main/packages/api/src/rich-text/rich-text.ts, …/detection.ts; guide https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/post-richtext.md; lexicon https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/richtext/facet.json.

**API**
- `new RichText({ text, facets? }, { cleanNewlines?: boolean })`
- `rt.text` → the JS string; `rt.length` → UTF-8 byte length; `rt.graphemeLength` → grapheme clusters; `rt.facets`.
- `await rt.detectFacets(agent)` overwrites `rt.facets` with auto-detected mentions, links, `#tags`, `$CASHTAGS`; resolves each mention via `com.atproto.identity.resolveHandle`; an unresolvable handle gets `did: ''` (drop those). `rt.detectFacetsWithoutResolution()` skips resolution ("Will produce invalid facets").
- Detection details: bare domains with a valid TLD become `https://…` links; trailing `.,;:!?` and unmatched `)` are stripped from URLs; tags drop trailing punctuation and must be ≤ 64 graphemes.

```ts
import { RichText } from '@atproto/api'
const rt = new RichText({ text: 'Release 1.2 is out! Notes: https://example.com/notes  cc @alice.bsky.social #release' })
await rt.detectFacets(agent)
rt.facets = rt.facets?.filter(f => !f.features.some(x => x.$type === 'app.bsky.richtext.facet#mention' && !x.did))
await agent.post({ text: rt.text, facets: rt.facets })
```

**Facet shape** (byte offsets are zero-indexed UTF-8 bytes, start inclusive, end exclusive; facets must not overlap):
```ts
{
  index: { byteStart: 6, byteEnd: 15 },
  features: [
    { $type: 'app.bsky.richtext.facet#link',    uri: 'https://example.com' },
    // { $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:…' },
    // { $type: 'app.bsky.richtext.facet#tag',     tag: 'release' }   // no leading '#'
  ],
}
```

**Display text ≠ URL.** The lexicon: "The text URL may have been simplified or truncated, but the facet reference should be a complete URL." The guide's own example is `text: 'Go to this site'` with a `#link` facet over "this site". Build facets manually with byte offsets:
```ts
import type { AppBskyRichtextFacet } from '@atproto/api'
type Seg = string | { text: string; link: string } | { text: string; mention: string } | { text: string; tag: string }

export function buildRichText(segs: Seg[]) {
  let text = ''
  const facets: AppBskyRichtextFacet.Main[] = []
  for (const s of segs) {
    if (typeof s === 'string') { text += s; continue }
    const byteStart = Buffer.byteLength(text, 'utf8')
    text += s.text
    const byteEnd = Buffer.byteLength(text, 'utf8')
    const feature =
      'link' in s    ? { $type: 'app.bsky.richtext.facet#link' as const,    uri: s.link } :
      'mention' in s ? { $type: 'app.bsky.richtext.facet#mention' as const, did: s.mention } :
                       { $type: 'app.bsky.richtext.facet#tag' as const,     tag: s.tag }
    facets.push({ index: { byteStart, byteEnd }, features: [feature] })
  }
  return { text, facets }
}
```
**UNVERIFIED:** whether the Bluesky app shows a warning for link facets whose text differs from the destination.

---

## 5. Length limits

- `text` is limited to 300 graphemes and 3000 UTF-8 bytes. The PDS enforces this at `createRecord` → 400 `InvalidRequest`.
- `rt.graphemeLength` uses `Intl.Segmenter` when available (Node 22 has it). README example: `'👨‍👩‍👧‍👧'` → `length 25`, `graphemeLength 1`.
- URLs count in full, because the limits apply to the raw `text` string. The only way to "save" characters is the §4 pattern (short display text + full URL in the facet).
- Hashtag facet `tag`: maxLength 640 / maxGraphemes 64; `tags[]` ≤ 8.

---

## 6. Threads (replies from one account)

`reply: { root: strongRef, parent: strongRef }` where `strongRef = { uri, cid }`. "Reply posts need to reference both the immediate parent post and the original root post of the thread"; for the first reply, root == parent (https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/posts.md). `createRecord` returns exactly the `{uri, cid}` you need.

```ts
type Ref = { uri: string; cid: string }
export async function postThread(agent: Agent, parts: string[]): Promise<Ref[]> {
  let root: Ref | undefined, parent: Ref | undefined
  const out: Ref[] = []
  for (const text of parts) {
    const rt = new RichText({ text }); await rt.detectFacets(agent)
    const res = await agent.post({
      text: rt.text, facets: rt.facets, langs: ['en'],
      ...(root && parent ? { reply: { root, parent } } : {}),
    })
    root ??= res; parent = res; out.push(res)
  }
  return out
}
```

---

## 7. Embeds

Lexicons: external https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/external.json ; images https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/images.json ; uploadBlob https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/uploadBlob.json.

**`uploadBlob` first.** Call `agent.uploadBlob(data, { encoding: '<mime>' })` (input encoding `*/*`; output `{ blob }`). The blob "will be deleted if it is not referenced within a time window (eg, minutes). Blob restrictions (mimetype, size, etc) are enforced when the reference is created", i.e. at `createRecord`. Hard PDS cap: 52,428,800 bytes on Bluesky-hosted PDSs.

**Images** `app.bsky.embed.images`: up to 4 images; each `{ image: blob, alt: string (required), aspectRatio?: { width ≥1, height ≥1 } }`; blob `accept: ["image/*"]`, `maxSize: 2000000` ("May be up to 2 MB, formerly limited to 1 MB"). The lexicon is authoritative over the guide's stale 1 MB prose. Leave `aspectRatio` undefined rather than guessing.
```ts
import { readFile } from 'node:fs/promises'
const bytes = await readFile('./screenshot.png')
if (bytes.byteLength > 2_000_000) throw new Error('image > 2,000,000 bytes')
const { data: up } = await agent.uploadBlob(bytes, { encoding: 'image/png' })
// up.blob = { $type:'blob', ref:{ $link:'bafkrei…' }, mimeType:'image/png', size: 123456 }
await agent.post({
  text: 'Screenshot',
  embed: { $type: 'app.bsky.embed.images',
           images: [{ image: up.blob, alt: 'Terminal showing the build passing' }] },
})
```

**External link card** `app.bsky.embed.external`: `{ external: { uri, title, description, thumb?: blob } }`. `title`/`description` are required (may be empty strings); `thumb` has `accept: ["image/*"]`, `maxSize: 1000000`. The client bakes the card into the record: "each client fetches and embeds this card metadata, including blob upload if needed". A bare URL in `text` produces no card.
```ts
async function externalCard(agent: Agent, url: string, meta: { title?: string; description?: string; image?: string }) {
  let thumb: unknown
  if (meta.image) {
    const r = await fetch(meta.image)
    const buf = new Uint8Array(await r.arrayBuffer())
    if (r.ok && buf.byteLength <= 1_000_000)
      thumb = (await agent.uploadBlob(buf, { encoding: r.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg' })).data.blob
  }
  return { $type: 'app.bsky.embed.external' as const,
           external: { uri: url, title: meta.title ?? '', description: meta.description ?? '', ...(thumb ? { thumb } : {}) } }
}
```

**Link card + images together: not possible.** `embed` is a single union member. `recordWithMedia` combines a quote post with one media embed. There is no union member for images + external.

**OpenGraph metadata.** No endpoint in the atproto/Bluesky lexicons. Options: (1) parse it yourself, as the official guide does with BeautifulSoup reading `og:title`, `og:description`, `og:image`; (2) the official app calls `https://cardyb.bsky.app/v1/extract?url=…` (https://github.com/bluesky-social/social-app/blob/main/src/lib/constants.ts), which is undocumented and unofficial for third parties.
```ts
export async function fetchOg(url: string) {
  const html = await (await fetch(url, { headers: { 'user-agent': 'my-ci-bot/1.0' } })).text()
  const meta = (p: string) =>
    html.match(new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']*)["']`, 'i'))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:${p}["']`, 'i'))?.[1]
  const image = meta('image'); return { title: meta('title'), description: meta('description'),
    image: image ? new URL(image, url).href : undefined }
}
```

---

## 8. `langs` and `createdAt`

- `langs`: array of ≤ 3 BCP-47 tags (`format: language`, e.g. `["th", "en-US"]`).
- `createdAt`: Lexicon `datetime` (RFC 3339 / ISO 8601); uppercase `T`; timezone required, `Z` preferred; whole seconds required (https://atproto.com/specs/lexicon). `new Date().toISOString()` is valid. It is "client-declared": far-future values float to the top of feeds and are sorted with `sortAt = min(createdAt, indexedAt)` (https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/timestamps.md).

---

## 9. Rate limits (Bluesky-hosted PDS / entryway)

Doc: https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/rate-limits.md. Code: https://github.com/bluesky-social/atproto/blob/main/packages/pds/src/rate-limits.ts.

| Limit | Value | Key |
|---|---|---|
| Repo writes | **5,000 points/hour, 35,000 points/day**; CREATE = 3, UPDATE = 2, DELETE = 1 → **1,666 creates/hour, 11,666/day** | per account DID |
| All endpoints | **3,000 requests / 5 min** | per IP |
| `createSession` (login) | **30 per 5 min, 300 per day** | `${identifier}-${req.ip}` |
| `uploadBlob` | 1,000 points/day (source only) | **UNVERIFIED** key |
| Blob upload size | 52,428,800 bytes | — |

Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (unix seconds), `RateLimit-Policy`; on 429 also `Retry-After` (seconds) and body `{ "error": "RateLimitExceeded", "message": … }`. A CI bot posting a few items per run is far below all of these; logging in once per run is fine.

---

## 10. Idempotency, `rkey`, TIDs

- The server does not dedupe. Re-sending the same post creates a second record, so the client must track state.
- Default `rkey` is generated server-side: `TID.next()`.
- You may supply `rkey` (`createRecord.rkey`). For `app.bsky.feed.post` the lexicon declares `"key": "tid"`, and the PDS validates the rkey against the key type, so it must be a valid TID: 13 chars of `234567abcdefghijklmnopqrstuvwxyz`, regex `^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$` (https://atproto.com/specs/tid ; https://atproto.com/specs/record-key).
- Pattern: generate the TID *before* posting, persist it, and on retry check `getRecord` first:
```ts
import { TID } from '@atproto/common-web'
const rkey = state.rkey ??= TID.nextStr()                     // persist `state` before the network call
const repo = agent.assertDid, collection = 'app.bsky.feed.post'
const existing = await agent.com.atproto.repo.getRecord({ repo, collection, rkey }).catch(() => null)
if (!existing) await agent.com.atproto.repo.createRecord({ repo, collection, rkey, record })
```
- The post's AT-URI is deterministic: `at://<did>/app.bsky.feed.post/<rkey>`. The `cid` comes from the createRecord response or from `getRecord`.
- **UNVERIFIED:** what the PDS returns when `createRecord` is called with an rkey that already exists; do not rely on a collision error; use the read-before-write above.

---

## 11. Error shapes

Client (`@atproto/xrpc`, re-exported as `XRPCError` from `@atproto/api`): https://github.com/bluesky-social/atproto/blob/main/packages/xrpc/src/types.ts
```ts
class XRPCError extends Error {
  success = false
  status: ResponseType      // numeric: 400 InvalidRequest, 401 AuthenticationRequired, 403 Forbidden, 404 XRPCNotSupported,
                            // 413 PayloadTooLarge, 415 UnsupportedMediaType, 429 RateLimitExceeded, 500 InternalServerError,
                            // 502 UpstreamFailure, 503 NotEnoughResources, 504 UpstreamTimeout,
                            // 1 Unknown (network failure), 2 InvalidResponse
  error: string             // body.error if present, else the ResponseType name (e.g. 'InvalidRequest')
  message: string
  headers?: Record<string, string | undefined>   // lower-cased; includes 'retry-after', 'ratelimit-*'
}
```
Wire format: `{ "error": "<Name>", "message": "…" }`. Names from the PDS:
- 400 `InvalidRequest` (schema/rkey/`$type` problems), `ExpiredToken`, `InvalidToken`, `InvalidSwap`, `AccountTakedown`, `AuthFactorTokenRequired` (createSession), `HandleNotFound` (resolveHandle)
- 401 `AuthMissing`, `AuthenticationRequired` (bad credentials, e.g. wrong app password)
- 429 `RateLimitExceeded` (+ `Retry-After`)
- `agent.assertDid` throws a plain `Error('Not logged in')`.
```ts
import { XRPCError } from '@atproto/api'
try { await agent.post({ text }) }
catch (err) {
  if (err instanceof XRPCError) {
    if (err.status === 429) { const wait = Number(err.headers?.['retry-after'] ?? 60) }
    else if (err.status === 401 || err.error === 'ExpiredToken') { /* re-login */ }
    else if (err.error === 'InvalidRequest') { /* bad record: fix input, do not retry */ }
    else if (err.status >= 500 || err.status === 1) { /* transient */ }
  }
  throw err
}
```

---

## 12. Raw XRPC endpoints (for a fake PDS in tests)

- `POST {host}/xrpc/com.atproto.server.createSession`: JSON `{identifier, password}` → `{accessJwt, refreshJwt, did, handle, didDoc?, active?, status?}`
- `POST {host}/xrpc/com.atproto.server.refreshSession`: `Authorization: Bearer <refreshJwt>` → new tokens
- `POST {pds}/xrpc/com.atproto.repo.createRecord`: `Authorization: Bearer <accessJwt>`, JSON `{repo, collection, record, rkey?, validate?, swapCommit?}` → `{uri, cid, commit?, validationStatus?}`
- `GET {pds}/xrpc/com.atproto.repo.getRecord?repo=&collection=&rkey=` → `{uri, cid, value}` or 400 `RecordNotFound`
- `POST {pds}/xrpc/com.atproto.repo.uploadBlob`: Bearer, `Content-Type: <mime>`, raw bytes → `{blob}`
- `GET {host}/xrpc/com.atproto.identity.resolveHandle?handle=…` → `{did}`

When `createSession` returns no `didDoc`, the client keeps using `service` for all calls, so a fake PDS on localhost can serve everything from one origin.

---

## UNVERIFIED summary
1. Whether the Bluesky app warns on link facets whose text differs from the destination (§4).
2. The key used by the default `uploadBlob` route limiter (§9).
3. PDS response when `createRecord` is given an already-existing `rkey` (§10).
