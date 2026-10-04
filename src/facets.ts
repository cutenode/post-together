import { RichText } from '@atproto/api'
import type { Facet, FacetFeature, Run } from './types.js'

const encoder = new TextEncoder()

/** UTF-8 byte length of a string (facet offsets are UTF-8 bytes). */
export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** Grapheme-cluster count as Bluesky counts it (`RichText.graphemeLength`, Intl.Segmenter). */
export function graphemeLength(text: string): number {
  if (text.length === 0) return 0
  return new RichText({ text }).graphemeLength
}

/**
 * Trim a run list: leading whitespace off the first run(s) and trailing whitespace off the
 * last run(s); runs left empty are dropped. Never touches inner whitespace, so link runs
 * keep their exact text. Returns new run objects.
 */
export function trimRuns(runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r }))
  while (out.length > 0) {
    const first = out[0]!
    first.text = first.text.replace(/^\s+/, '')
    if (first.text) break
    out.shift()
  }
  while (out.length > 0) {
    const last = out[out.length - 1]!
    last.text = last.text.replace(/\s+$/, '')
    if (last.text) break
    out.pop()
  }
  return out
}

export function runsText(runs: Run[]): string {
  let text = ''
  for (const r of runs) text += r.text
  return text
}

/** The post text for a list of pieces: each piece trimmed, empty pieces skipped, joined by a blank line. */
export function piecesText(pieces: Run[][]): string {
  const parts: string[] = []
  for (const piece of pieces) {
    const text = runsText(trimRuns(piece))
    if (text) parts.push(text)
  }
  return parts.join('\n\n')
}

export interface FlatText {
  text: string
  /** Manual `#link` facets for the link runs, in text order, with UTF-8 byte offsets. */
  facets: Facet[]
}

/**
 * Build the post text from pieces exactly like `piecesText` and record every link run as a
 * manual link facet. A link whose text equals its URL still gets a facet (SPEC §5).
 */
export function flatten(pieces: Run[][]): FlatText {
  let text = ''
  let bytes = 0
  const facets: Facet[] = []
  let first = true
  for (const piece of pieces) {
    const runs = trimRuns(piece)
    if (runs.length === 0) continue
    if (!first) {
      text += '\n\n'
      bytes += 2
    }
    first = false
    for (const run of runs) {
      const len = byteLength(run.text)
      if (run.link !== undefined && len > 0) {
        facets.push({
          index: { byteStart: bytes, byteEnd: bytes + len },
          features: [{ $type: 'app.bsky.richtext.facet#link', uri: run.link }],
        })
      }
      text += run.text
      bytes += len
    }
  }
  return { text, facets }
}

/**
 * Facets detected by `RichText` (bare links, `#tags`, `@mentions`), normalised to our shape.
 * Mentions keep the bare handle in `did`; publish resolves them.
 */
export function detectFacets(text: string): Facet[] {
  if (!text) return []
  const rt = new RichText({ text })
  rt.detectFacetsWithoutResolution()
  const out: Facet[] = []
  for (const facet of rt.facets ?? []) {
    const features: FacetFeature[] = []
    for (const feature of facet.features) {
      const normalised = toFeature(feature as unknown as Record<string, unknown>)
      if (normalised) features.push(normalised)
    }
    if (features.length > 0) {
      out.push({ index: { byteStart: facet.index.byteStart, byteEnd: facet.index.byteEnd }, features })
    }
  }
  return out
}

function toFeature(feature: Record<string, unknown>): FacetFeature | undefined {
  const type = feature['$type']
  switch (type) {
    case 'app.bsky.richtext.facet#link': {
      const uri = feature['uri']
      return typeof uri === 'string' ? { $type: type, uri } : undefined
    }
    case 'app.bsky.richtext.facet#mention': {
      const did = feature['did']
      return typeof did === 'string' ? { $type: type, did } : undefined
    }
    case 'app.bsky.richtext.facet#tag': {
      const tag = feature['tag']
      return typeof tag === 'string' ? { $type: type, tag } : undefined
    }
    default:
      return undefined
  }
}

function overlaps(a: Facet, b: Facet): boolean {
  return a.index.byteStart < b.index.byteEnd && b.index.byteStart < a.index.byteEnd
}

/** Manual facets win: any detected facet overlapping a manual one is dropped. Result sorted by byteStart. */
export function mergeFacets(manual: Facet[], detected: Facet[]): Facet[] {
  const kept = detected.filter((d) => !manual.some((m) => overlaps(m, d)))
  return [...manual, ...kept].sort(
    (a, b) => a.index.byteStart - b.index.byteStart || a.index.byteEnd - b.index.byteEnd,
  )
}

/** Text plus the merged facet list (manual link runs, then RichText detection). */
export function buildFacets(pieces: Run[][]): FlatText {
  const { text, facets: manual } = flatten(pieces)
  return { text, facets: mergeFacets(manual, detectFacets(text)) }
}

/** URI of the first `#link` facet in text order, if any. */
export function firstLinkUri(facets: Facet[]): string | undefined {
  for (const facet of facets) {
    for (const feature of facet.features) {
      if (feature.$type === 'app.bsky.richtext.facet#link') return feature.uri
    }
  }
  return undefined
}
