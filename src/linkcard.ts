/**
 * OpenGraph link-card metadata. See docs/SPEC.md §7.6.
 *
 * GET the page with a 10 s timeout, parse `og:title`, `og:description`,
 * `og:image` and `<title>` with attribute-order-tolerant regexes, resolve the
 * image against the page URL and fetch it only if it is an image of at most
 * 1,000,000 bytes. Any failure throws; the publisher posts without a card.
 */
import { THUMB_MAX_BYTES } from './types.js'

export const LINK_CARD_TIMEOUT_MS = 10_000
export const USER_AGENT = 'post-together'

export interface LinkCardThumb {
  bytes: Uint8Array
  mime: string
}

export interface LinkCardMeta {
  uri: string
  title: string
  description: string
  thumb?: LinkCardThumb
}

export interface LinkCardOptions {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'))
  if (!m) return undefined
  return m[1] ?? m[2] ?? m[3]
}

/** Extract `og:*` properties (attribute order does not matter) and `<title>`. */
export function parseOpenGraph(html: string): { title?: string; description?: string; image?: string } {
  const out: { title?: string; description?: string; image?: string } = {}
  const head = html.length > 512_000 ? html.slice(0, 512_000) : html
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name'))?.trim().toLowerCase()
    if (!key || !key.startsWith('og:')) continue
    const content = attr(tag, 'content')
    if (content === undefined) continue
    const value = decodeEntities(content).trim()
    if (key === 'og:title' && out.title === undefined) out.title = value
    else if (key === 'og:description' && out.description === undefined) out.description = value
    else if (key === 'og:image' && out.image === undefined && value !== '') out.image = value
    else if ((key === 'og:image:url' || key === 'og:image:secure_url') && out.image === undefined && value !== '') out.image = value
  }
  if (out.title === undefined) {
    const t = head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)
    if (t?.[1] !== undefined) out.title = decodeEntities(t[1]).replace(/\s+/g, ' ').trim()
  }
  return out
}

/**
 * Fetch link-card metadata for `url`. Throws when the page cannot be fetched or
 * is not HTML; a missing or oversized thumbnail simply yields no `thumb`.
 */
export async function fetchLinkCard(url: string, opts: LinkCardOptions = {}): Promise<LinkCardMeta> {
  const doFetch = opts.fetch ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? LINK_CARD_TIMEOUT_MS
  const page = new URL(url)
  if (page.protocol !== 'http:' && page.protocol !== 'https:') throw new Error(`unsupported URL scheme for link card: ${url}`)

  const res = await doFetch(page, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`)
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType && !/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
    throw new Error(`GET ${url} returned ${contentType}, not HTML`)
  }
  const html = await res.text()
  const og = parseOpenGraph(html)
  const meta: LinkCardMeta = { uri: url, title: og.title ?? '', description: og.description ?? '' }

  if (og.image !== undefined) {
    const thumb = await fetchThumb(og.image, res.url || url, doFetch, timeoutMs)
    if (thumb) meta.thumb = thumb
  }
  return meta
}

async function fetchThumb(
  image: string,
  base: string,
  doFetch: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<LinkCardThumb | undefined> {
  let imageUrl: URL
  try {
    imageUrl = new URL(image, base)
  } catch {
    return undefined
  }
  if (imageUrl.protocol !== 'http:' && imageUrl.protocol !== 'https:') return undefined
  const res = await doFetch(imageUrl, {
    headers: { 'user-agent': USER_AGENT, accept: 'image/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) return undefined
  const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!mime.startsWith('image/')) {
    await res.body?.cancel().catch(() => {})
    return undefined
  }
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > THUMB_MAX_BYTES) {
    await res.body?.cancel().catch(() => {})
    return undefined
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > THUMB_MAX_BYTES) return undefined
  return { bytes, mime }
}
