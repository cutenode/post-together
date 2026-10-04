/**
 * Thin wrapper around `@atproto/api`. See docs/SPEC.md §3 and §7.6.
 *
 * One `CredentialSession` login per run; the resulting `Agent` is wrapped so the
 * rest of the pipeline never touches XRPC details. Errors from the PDS are
 * classified into `BlueskyError`s with actionable messages. The password never
 * appears in any message.
 */
import { Agent, CredentialSession, XRPCError } from '@atproto/api'
import type { BlobRef } from '@atproto/api'
import { POST_COLLECTION } from './types.js'

export interface StrongRef {
  uri: string
  cid: string
}

/** A record read back from the PDS: its strong ref plus the record value. */
export interface ExistingRecord extends StrongRef {
  value: Record<string, unknown>
}

export type BlueskyErrorKind = 'rate-limited' | 'auth' | 'invalid-request' | 'network'

export class BlueskyError extends Error {
  override name = 'BlueskyError'
  readonly kind: BlueskyErrorKind
  /** Seconds (or an HTTP date) from the `retry-after` header of a 429. */
  readonly retryAfter: string | undefined

  constructor(message: string, kind: BlueskyErrorKind, options: { retryAfter?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.kind = kind
    this.retryAfter = options.retryAfter
  }
}

export interface LoginOptions {
  service: string
  identifier: string
  password: string
  /** Override the WHATWG fetch used by the session (tests). */
  fetch?: typeof globalThis.fetch
}

export interface Bluesky {
  readonly did: string
  readonly identifier: string
  readonly service: string
  readonly agent: Agent
  /** Resolve a handle to a DID, cached per run. `undefined` when it cannot be resolved. */
  resolveHandle(handle: string): Promise<string | undefined>
  uploadBlob(bytes: Uint8Array, mime: string): Promise<BlobRef>
  /** `undefined` when the PDS answers `RecordNotFound`. */
  getRecord(rkey: string): Promise<ExistingRecord | undefined>
  createRecord(rkey: string, record: Record<string, unknown>): Promise<StrongRef>
}

export function postUri(did: string, rkey: string): string {
  return `at://${did}/${POST_COLLECTION}/${rkey}`
}

export function bskyAppUrl(did: string, rkey: string): string {
  return `https://bsky.app/profile/${did}/post/${rkey}`
}

export function isXRPCError(err: unknown): err is XRPCError {
  return err instanceof XRPCError
}

/** Detail for classification: which account and which file the failing call was for. */
export interface ErrorContext {
  identifier?: string
  file?: string
  service?: string
}

/**
 * Turn an `XRPCError` into a `BlueskyError` per SPEC §7.6. Anything that is not
 * one of the recognised cases is returned unchanged so callers rethrow it.
 */
export function classifyError(err: unknown, ctx: ErrorContext = {}): unknown {
  if (!isXRPCError(err)) return err
  const where = ctx.file ? ` while posting ${ctx.file}` : ''
  if (err.status === 429 || err.error === 'RateLimitExceeded') {
    const retryAfter = err.headers?.['retry-after']
    const wait = retryAfter ? ` Retry after ${retryAfter} seconds.` : ''
    return new BlueskyError(
      `rate limited by ${ctx.service ?? 'the PDS'}${where}.${wait} State was saved; re-run later to resume.`,
      'rate-limited',
      retryAfter === undefined ? { cause: err } : { retryAfter, cause: err },
    )
  }
  if (err.status === 401 || err.error === 'AuthenticationRequired') {
    const who = ctx.identifier ? ` for ${ctx.identifier}` : ''
    return new BlueskyError(
      `authentication failed${who}: ${err.message || err.error}. Check the identifier (handle, email or DID) and use an app password from Settings > Privacy and security > App passwords, not the account password.`,
      'auth',
      { cause: err },
    )
  }
  if (err.error === 'InvalidRequest') {
    const file = ctx.file ? ` for ${ctx.file}` : ''
    return new BlueskyError(`the PDS rejected the request${file}: ${err.message || 'InvalidRequest'}`, 'invalid-request', {
      cause: err,
    })
  }
  if (err.status === 1) {
    return new BlueskyError(`could not reach ${ctx.service ?? 'the PDS'}: ${err.message}`, 'network', { cause: err })
  }
  return err
}

/** Log in with an app password and return a wrapped client. */
export async function login(opts: LoginOptions): Promise<Bluesky> {
  let url: URL
  try {
    url = new URL(opts.service)
  } catch {
    throw new Error(`service must be a URL (got ${JSON.stringify(opts.service)})`)
  }
  const session = opts.fetch ? new CredentialSession(url, opts.fetch) : new CredentialSession(url)
  try {
    await session.login({ identifier: opts.identifier, password: opts.password })
  } catch (err) {
    throw classifyError(err, { identifier: opts.identifier, service: opts.service })
  }
  // `SessionManager.did` is optional; under exactOptionalPropertyTypes the getter's `string | undefined` needs a cast.
  const agent = new Agent(session as ConstructorParameters<typeof Agent>[0])
  const did = agent.assertDid
  const handleCache = new Map<string, Promise<string | undefined>>()

  return {
    did,
    identifier: opts.identifier,
    service: opts.service,
    agent,
    resolveHandle(handle) {
      const key = handle.toLowerCase()
      let pending = handleCache.get(key)
      if (!pending) {
        pending = agent
          .resolveHandle({ handle: key })
          .then((res) => res.data.did)
          .catch((err: unknown) => {
            if (isXRPCError(err) && (err.status === 400 || err.status === 404)) return undefined
            throw classifyError(err, { identifier: opts.identifier, service: opts.service })
          })
        handleCache.set(key, pending)
      }
      return pending
    },
    async uploadBlob(bytes, mime) {
      const res = await agent.uploadBlob(bytes, { encoding: mime })
      return res.data.blob
    },
    async getRecord(rkey) {
      try {
        const res = await agent.com.atproto.repo.getRecord({ repo: did, collection: POST_COLLECTION, rkey })
        if (!res.data.cid) throw new Error(`getRecord for ${rkey} returned no cid`)
        return { uri: res.data.uri, cid: res.data.cid, value: res.data.value as Record<string, unknown> }
      } catch (err) {
        if (isXRPCError(err) && err.error === 'RecordNotFound') return undefined
        throw err
      }
    },
    async createRecord(rkey, record) {
      const res = await agent.com.atproto.repo.createRecord({ repo: did, collection: POST_COLLECTION, rkey, record })
      return { uri: res.data.uri, cid: res.data.cid }
    },
  }
}
