import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeEntities, fetchLinkCard, HTML_MAX_BYTES, parseOpenGraph, readCapped, USER_AGENT } from '../src/linkcard.js'

let server: Server
let base = ''
const seen: { url: string; ua: string | undefined }[] = []
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    seen.push({ url: url.pathname, ua: req.headers['user-agent'] })
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    }
    switch (url.pathname) {
      case '/full':
        return html(`<!doctype html><html><head>
          <meta content="Full &amp; proper title" property="og:title">
          <meta property='og:description' content='A description with &quot;quotes&quot; &#8212; and a dash'>
          <meta name="og:image" content="/img/thumb.jpg">
          <title>Fallback title</title></head><body></body></html>`)
      case '/title-only':
        return html('<html><head><title>\n  Only   the\n  title </title></head></html>')
      case '/no-meta':
        return html('<html><body>nothing here</body></html>')
      case '/deep/page':
        return html('<html><head><meta property="og:title" content="Deep"><meta property="og:image" content="img/t.jpg"></head></html>')
      case '/deep/img/t.jpg':
      case '/img/thumb.jpg':
        res.writeHead(200, { 'content-type': 'image/jpeg' })
        return res.end(JPEG)
      case '/big':
        return html('<html><head><meta property="og:title" content="Big"><meta property="og:image" content="/img/big.jpg"></head></html>')
      case '/img/big.jpg': {
        const big = Buffer.alloc(1_000_001, 1)
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(big.length) })
        return res.end(big)
      }
      case '/huge-page': {
        // Tags first, then far more than HTML_MAX_BYTES of body, streamed without a length.
        res.writeHead(200, { 'content-type': 'text/html' })
        res.write('<html><head><meta property="og:title" content="Huge"></head><body>')
        const filler = 'x'.repeat(64 * 1024)
        for (let i = 0; i < 64; i++) res.write(filler)
        return res.end('</body></html>')
      }
      case '/chunked-big':
        return html('<html><head><meta property="og:title" content="CB"><meta property="og:image" content="/img/chunked-big.jpg"></head></html>')
      case '/img/chunked-big.jpg': {
        // No content-length: the size is only known by reading the body.
        res.writeHead(200, { 'content-type': 'image/jpeg' })
        const chunk = Buffer.alloc(100_000, 1)
        for (let i = 0; i < 11; i++) res.write(chunk)
        return res.end()
      }
      case '/not-image':
        return html('<html><head><meta property="og:title" content="NI"><meta property="og:image" content="/full"></head></html>')
      case '/missing-image':
        return html('<html><head><meta property="og:title" content="MI"><meta property="og:image" content="/img/nope.jpg"></head></html>')
      case '/redirect':
        res.writeHead(302, { location: '/deep/page' })
        return res.end()
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{"og:title":"nope"}')
      case '/slow':
        return // never answers; the socket is closed with the server
      default:
        res.writeHead(404, { 'content-type': 'text/html' })
        return res.end('<title>404</title>')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities and leaves unknown ones alone', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41; &#8212; &unknown;')).toBe('a & b <c> "d" \'e\' A — &unknown;')
  })
})

describe('parseOpenGraph', () => {
  it('reads og tags regardless of attribute order and quoting', () => {
    const og = parseOpenGraph(`<meta content="T" property="og:title"><meta property='og:description' content='D'><meta property=og:image content=/i.png>`)
    expect(og).toEqual({ title: 'T', description: 'D', image: '/i.png' })
  })

  it('keeps the first occurrence and falls back to <title>', () => {
    expect(parseOpenGraph('<meta property="og:title" content="A"><meta property="og:title" content="B">').title).toBe('A')
    expect(parseOpenGraph('<title>Plain</title>')).toEqual({ title: 'Plain' })
    expect(parseOpenGraph('<p>nothing</p>')).toEqual({})
  })

  it('accepts og:image:url and og:image:secure_url as image sources', () => {
    expect(parseOpenGraph('<meta property="og:image:secure_url" content="https://x/i.png">').image).toBe('https://x/i.png')
  })
})

describe('fetchLinkCard', () => {
  it('returns title, description and a thumbnail resolved against the page URL', async () => {
    const card = await fetchLinkCard(`${base}/full`)
    expect(card.uri).toBe(`${base}/full`)
    expect(card.title).toBe('Full & proper title')
    expect(card.description).toBe('A description with "quotes" — and a dash')
    expect(card.thumb?.mime).toBe('image/jpeg')
    expect(Buffer.from(card.thumb?.bytes ?? [])).toEqual(JPEG)
    const ua = seen.find((s) => s.url === '/full')?.ua
    expect(ua).toBe(USER_AGENT)
    expect(seen.find((s) => s.url === '/img/thumb.jpg')?.ua).toBe(USER_AGENT)
  })

  it('falls back to <title> and empty description without a thumbnail', async () => {
    const card = await fetchLinkCard(`${base}/title-only`)
    expect(card).toEqual({ uri: `${base}/title-only`, title: 'Only the title', description: '' })
  })

  it('yields empty strings when the page has no metadata at all', async () => {
    expect(await fetchLinkCard(`${base}/no-meta`)).toEqual({ uri: `${base}/no-meta`, title: '', description: '' })
  })

  it('resolves a relative og:image against the final URL after a redirect', async () => {
    const card = await fetchLinkCard(`${base}/redirect`)
    expect(card.title).toBe('Deep')
    expect(card.thumb?.mime).toBe('image/jpeg')
    expect(seen.some((s) => s.url === '/deep/img/t.jpg')).toBe(true)
  })

  it('drops a thumbnail larger than 1,000,000 bytes', async () => {
    const card = await fetchLinkCard(`${base}/big`)
    expect(card.title).toBe('Big')
    expect(card.thumb).toBeUndefined()
  })

  it('drops a thumbnail over the limit even without a content-length header', async () => {
    const card = await fetchLinkCard(`${base}/chunked-big`)
    expect(card.title).toBe('CB')
    expect(card.thumb).toBeUndefined()
  })

  it('reads only the head of a huge page', async () => {
    const card = await fetchLinkCard(`${base}/huge-page`)
    expect(card.title).toBe('Huge')
  })

  it('drops a thumbnail whose content-type is not image/*', async () => {
    const card = await fetchLinkCard(`${base}/not-image`)
    expect(card.title).toBe('NI')
    expect(card.thumb).toBeUndefined()
  })

  it('drops a thumbnail that cannot be fetched', async () => {
    const card = await fetchLinkCard(`${base}/missing-image`)
    expect(card.title).toBe('MI')
    expect(card.thumb).toBeUndefined()
  })

  it('throws on non-2xx responses and non-HTML content', async () => {
    await expect(fetchLinkCard(`${base}/nope`)).rejects.toThrow(/404/)
    await expect(fetchLinkCard(`${base}/json`)).rejects.toThrow(/not HTML/)
  })

  it('times out', async () => {
    await expect(fetchLinkCard(`${base}/slow`, { timeoutMs: 200 })).rejects.toThrow()
  })

  it('rejects non-http schemes', async () => {
    await expect(fetchLinkCard('ftp://example.com/x')).rejects.toThrow(/scheme/)
  })
})

describe('readCapped', () => {
  it('returns the whole body when it fits and stops at the cap otherwise', async () => {
    expect(await readCapped(new Response('hello'), 10)).toEqual({ bytes: new TextEncoder().encode('hello'), truncated: false })
    const capped = await readCapped(new Response('x'.repeat(HTML_MAX_BYTES + 5)), HTML_MAX_BYTES)
    expect(capped.truncated).toBe(true)
    expect(capped.bytes.byteLength).toBe(HTML_MAX_BYTES)
    expect(await readCapped(new Response(null), 10)).toEqual({ bytes: new Uint8Array(0), truncated: false })
  })
})
