/**
 * A minimal fake PDS for integration tests. See docs/SPEC.md §10 and
 * docs/research/bluesky-api.md §12.
 *
 * Serves the five XRPC endpoints post-together uses from one origin. The
 * createSession response carries no didDoc so the real `@atproto/api` client
 * keeps talking to this origin. Every request is recorded in `requests`.
 *
 * CIDs are structurally valid CIDv1 strings (the client parses them), derived
 * from a counter rather than from content.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeRequest {
  method: string
  nsid: string
  query: Record<string, string>
  headers: Record<string, string | string[] | undefined>
  /** Parsed JSON body when the request was application/json. */
  body: unknown
  rawBody: Buffer
}

export interface StoredRecord {
  uri: string
  cid: string
  value: Record<string, unknown>
}

export interface StoredBlob {
  cid: string
  mimeType: string
  size: number
}

export interface FakePdsOptions {
  did?: string
  handle?: string
  password?: string
  /** handle → DID for resolveHandle. */
  handles?: Record<string, string>
  /** 1-based index of the createRecord call that answers 429. */
  failCreateAt?: number
  retryAfter?: string
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** A structurally valid CIDv1 (sha2-256) for `raw` (0x55, blobs) or `dag-cbor` (0x71, records). */
export function makeCid(codec: 0x55 | 0x71, seed: string): string {
  const digest = createHash('sha256').update(seed).digest()
  return 'b' + base32(Uint8Array.from([0x01, codec, 0x12, 0x20, ...digest]))
}

export class FakePds {
  readonly did: string
  readonly handle: string
  readonly password: string
  readonly handles: Map<string, string>
  readonly accessJwt = `access-${randomBytes(8).toString('hex')}`
  readonly refreshJwt = `refresh-${randomBytes(8).toString('hex')}`
  readonly requests: FakeRequest[] = []
  readonly records = new Map<string, StoredRecord>()
  readonly blobs: StoredBlob[] = []
  createCalls = 0
  failCreateAt: number | undefined
  retryAfter: string
  url = ''
  private server: Server | undefined
  private counter = 0

  constructor(opts: FakePdsOptions = {}) {
    this.did = opts.did ?? 'did:plc:test'
    this.handle = opts.handle ?? 'bot.test'
    this.password = opts.password ?? 'app-pass-1234'
    this.handles = new Map(Object.entries(opts.handles ?? {}))
    this.failCreateAt = opts.failCreateAt
    this.retryAfter = opts.retryAfter ?? '30'
  }

  static async start(opts: FakePdsOptions = {}): Promise<FakePds> {
    const pds = new FakePds(opts)
    await pds.listen()
    return pds
  }

  async listen(): Promise<void> {
    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err: unknown) => {
        send(res, 500, { error: 'InternalServerError', message: String(err) })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    this.url = `http://127.0.0.1:${addr.port}`
    this.server = server
  }

  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }

  /** Requests for one XRPC method, in order. */
  calls(nsid: string): FakeRequest[] {
    return this.requests.filter((r) => r.nsid === nsid)
  }

  uriFor(rkey: string, collection = 'app.bsky.feed.post'): string {
    return `at://${this.did}/${collection}/${rkey}`
  }

  /** Pre-seed a record so getRecord finds it. */
  seed(rkey: string, value: Record<string, unknown>): StoredRecord {
    const record: StoredRecord = { uri: this.uriFor(rkey), cid: makeCid(0x71, `seed:${rkey}:${++this.counter}`), value }
    this.records.set(rkey, record)
    return record
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url)
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const rawBody = Buffer.concat(chunks)
    const contentType = String(req.headers['content-type'] ?? '')
    let body: unknown
    if (contentType.startsWith('application/json') && rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString('utf8'))
      } catch {
        send(res, 400, { error: 'InvalidRequest', message: 'malformed JSON body' })
        return
      }
    }
    const match = url.pathname.match(/^\/xrpc\/([\w.]+)$/)
    const nsid = match?.[1] ?? ''
    const query = Object.fromEntries(url.searchParams)
    this.requests.push({ method: req.method ?? 'GET', nsid, query, headers: req.headers, body, rawBody })

    if (!nsid) {
      send(res, 404, { error: 'XRPCNotSupported', message: `no such endpoint ${url.pathname}` })
      return
    }

    switch (nsid) {
      case 'com.atproto.server.createSession':
        return this.createSession(body, res)
      case 'com.atproto.identity.resolveHandle':
        return this.resolveHandle(query, res)
      case 'com.atproto.repo.uploadBlob':
        if (!this.authorized(req, res)) return
        return this.uploadBlob(contentType, rawBody, res)
      case 'com.atproto.repo.getRecord':
        if (!this.authorized(req, res)) return
        return this.getRecord(query, res)
      case 'com.atproto.repo.createRecord':
        if (!this.authorized(req, res)) return
        return this.createRecord(body, res)
      default:
        send(res, 404, { error: 'XRPCNotSupported', message: `unsupported method ${nsid}` })
    }
  }

  private authorized(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.headers.authorization === `Bearer ${this.accessJwt}`) return true
    send(res, 401, { error: 'AuthMissing', message: 'Authentication Required' })
    return false
  }

  private createSession(body: unknown, res: ServerResponse): void {
    const b = (body ?? {}) as { identifier?: unknown; password?: unknown }
    const identifierOk = b.identifier === this.handle || b.identifier === this.did
    if (!identifierOk || b.password !== this.password) {
      send(res, 401, { error: 'AuthenticationRequired', message: 'Invalid identifier or password' })
      return
    }
    send(res, 200, { accessJwt: this.accessJwt, refreshJwt: this.refreshJwt, did: this.did, handle: this.handle, active: true })
  }

  private resolveHandle(query: Record<string, string>, res: ServerResponse): void {
    const handle = (query['handle'] ?? '').toLowerCase()
    const did = this.handles.get(handle) ?? (handle === this.handle ? this.did : undefined)
    if (!did) {
      send(res, 400, { error: 'HandleNotFound', message: 'Unable to resolve handle' })
      return
    }
    send(res, 200, { did })
  }

  private uploadBlob(contentType: string, rawBody: Buffer, res: ServerResponse): void {
    const mimeType = contentType.split(';')[0]?.trim() || 'application/octet-stream'
    const blob: StoredBlob = { cid: makeCid(0x55, `blob:${++this.counter}`), mimeType, size: rawBody.length }
    this.blobs.push(blob)
    send(res, 200, { blob: { $type: 'blob', ref: { $link: blob.cid }, mimeType, size: blob.size } })
  }

  private getRecord(query: Record<string, string>, res: ServerResponse): void {
    const rkey = query['rkey'] ?? ''
    const record = this.records.get(rkey)
    if (!record || query['repo'] !== this.did) {
      send(res, 400, { error: 'RecordNotFound', message: `Could not locate record: ${this.uriFor(rkey)}` })
      return
    }
    send(res, 200, record)
  }

  private createRecord(body: unknown, res: ServerResponse): void {
    this.createCalls++
    if (this.failCreateAt !== undefined && this.createCalls === this.failCreateAt) {
      send(res, 429, { error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' }, { 'retry-after': this.retryAfter })
      return
    }
    const b = (body ?? {}) as { repo?: unknown; collection?: unknown; rkey?: unknown; record?: unknown }
    if (b.repo !== this.did) {
      send(res, 400, { error: 'InvalidRequest', message: `repo ${String(b.repo)} is not this account` })
      return
    }
    if (typeof b.collection !== 'string' || typeof b.record !== 'object' || b.record === null) {
      send(res, 400, { error: 'InvalidRequest', message: 'collection and record are required' })
      return
    }
    const record = b.record as Record<string, unknown>
    if (record['$type'] !== undefined && record['$type'] !== b.collection) {
      send(res, 400, { error: 'InvalidRequest', message: `Invalid $type: expected ${b.collection}, got ${String(record['$type'])}` })
      return
    }
    if (b.collection === 'app.bsky.feed.post') {
      const text = record['text']
      if (typeof text !== 'string' || typeof record['createdAt'] !== 'string') {
        send(res, 400, { error: 'InvalidRequest', message: 'Invalid app.bsky.feed.post record: text and createdAt are required' })
        return
      }
      if (Buffer.byteLength(text) > 3000) {
        send(res, 400, { error: 'InvalidRequest', message: 'Invalid app.bsky.feed.post record: text must not be longer than 3000 characters' })
        return
      }
    }
    const rkey = typeof b.rkey === 'string' && b.rkey !== '' ? b.rkey : `fake${this.counter++}`
    if (this.records.has(rkey)) {
      send(res, 400, { error: 'InvalidRequest', message: `record ${rkey} already exists` })
      return
    }
    const stored: StoredRecord = {
      uri: this.uriFor(rkey, b.collection),
      cid: makeCid(0x71, `record:${rkey}:${++this.counter}`),
      value: { ...record, $type: b.collection },
    }
    this.records.set(rkey, stored)
    send(res, 200, { uri: stored.uri, cid: stored.cid })
  }
}

function send(res: ServerResponse, status: number, json: unknown, headers: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(json))
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers })
  res.end(payload)
}
