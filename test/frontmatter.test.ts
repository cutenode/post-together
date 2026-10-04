import { describe, expect, it } from 'vitest'
import { parseFrontmatter, splitFrontmatter, validateFrontmatter } from '../src/frontmatter.js'

const FILE = 'posts/x.md'

describe('splitFrontmatter', () => {
  it('returns an empty frontmatter and the unchanged body when there is none', () => {
    const r = splitFrontmatter('# Hello\n\nBody.\n', FILE)
    expect(r.frontmatter).toEqual({})
    expect(r.body).toBe('# Hello\n\nBody.\n')
    expect(r.lines).toBe(0)
  })

  it('handles an empty frontmatter block', () => {
    const r = splitFrontmatter('---\n---\nBody.\n', FILE)
    expect(r.frontmatter).toEqual({})
    expect(r.lines).toBe(2)
    expect(r.body).toBe('\n\nBody.\n')
  })

  it('replaces the frontmatter with blank lines so body line numbers match the file', () => {
    const r = splitFrontmatter('---\nlangs: [en]\n---\nBody.\n', FILE)
    expect(r.frontmatter).toEqual({ langs: ['en'] })
    expect(r.lines).toBe(3)
    expect(r.body).toBe('\n\n\nBody.\n')
    expect(r.body.split('\n')[3]).toBe('Body.')
  })

  it('accepts fences with trailing spaces', () => {
    const r = splitFrontmatter('---  \ndraft: true\n---   \nBody.\n', FILE)
    expect(r.frontmatter).toEqual({ draft: true })
  })

  it('does not treat a --- later in the file as frontmatter', () => {
    const r = splitFrontmatter('Intro.\n\n---\n\nMore.\n', FILE)
    expect(r.frontmatter).toEqual({})
    expect(r.lines).toBe(0)
  })

  it('throws on an unterminated frontmatter block, naming the file', () => {
    expect(() => splitFrontmatter('---\ndraft: true\nBody.\n', FILE)).toThrow(/posts\/x\.md.*never closed/)
  })
})

describe('parseFrontmatter', () => {
  it('parses every key', () => {
    const fm = parseFrontmatter(
      ['draft: true', 'langs: [en, fr, de]', 'createdAt: 2026-09-28T09:00:00Z', 'link: https://example.com', 'thread: manual'].join('\n'),
      FILE,
    )
    expect(fm).toEqual({
      draft: true,
      langs: ['en', 'fr', 'de'],
      createdAt: '2026-09-28T09:00:00.000Z',
      link: 'https://example.com',
      thread: 'manual',
    })
  })

  it('parses draft: false', () => {
    expect(parseFrontmatter('draft: false', FILE)).toEqual({ draft: false })
  })

  it('parses link: false, link: auto and a URL', () => {
    expect(parseFrontmatter('link: false', FILE)).toEqual({ link: false })
    expect(parseFrontmatter('link: auto', FILE)).toEqual({ link: 'auto' })
    expect(parseFrontmatter('link: "https://example.com/a?b=c"', FILE)).toEqual({ link: 'https://example.com/a?b=c' })
  })

  it('parses thread: auto | manual | off', () => {
    expect(parseFrontmatter('thread: auto', FILE)).toEqual({ thread: 'auto' })
    expect(parseFrontmatter('thread: manual', FILE)).toEqual({ thread: 'manual' })
    expect(parseFrontmatter('thread: off', FILE)).toEqual({ thread: 'off' })
  })

  it('re-serialises createdAt with toISOString and accepts a Date instance', () => {
    expect(parseFrontmatter('createdAt: "2026-09-28 09:00:00 +0200"', FILE)).toEqual({ createdAt: '2026-09-28T07:00:00.000Z' })
    expect(validateFrontmatter({ createdAt: new Date('2026-01-02T03:04:05.006Z') }, FILE)).toEqual({
      createdAt: '2026-01-02T03:04:05.006Z',
    })
  })

  it('treats an empty document and a null document as no frontmatter', () => {
    expect(parseFrontmatter('', FILE)).toEqual({})
    expect(parseFrontmatter('# just a comment\n', FILE)).toEqual({})
    expect(parseFrontmatter('~', FILE)).toEqual({})
  })

  it('drops an empty langs list', () => {
    expect(parseFrontmatter('langs: []', FILE)).toEqual({})
  })

  it('throws on bad YAML, naming the file', () => {
    expect(() => parseFrontmatter('langs: [en\ndraft: true', FILE)).toThrow(/posts\/x\.md: invalid frontmatter YAML/)
  })

  it('throws on an unknown key, naming the file and key', () => {
    expect(() => parseFrontmatter('title: Hello', FILE)).toThrow(/posts\/x\.md: unknown frontmatter key "title"/)
  })

  it('throws when the document is not a mapping', () => {
    expect(() => parseFrontmatter('just a string', FILE)).toThrow(/must be a YAML mapping/)
    expect(() => parseFrontmatter('- a\n- b', FILE)).toThrow(/must be a YAML mapping/)
  })

  it('throws on wrong types, naming the file and key', () => {
    expect(() => parseFrontmatter('draft: yes please', FILE)).toThrow(/posts\/x\.md: frontmatter key "draft" must be a boolean/)
    expect(() => parseFrontmatter('draft: 1', FILE)).toThrow(/"draft"/)
    expect(() => parseFrontmatter('langs: en', FILE)).toThrow(/"langs"/)
    expect(() => parseFrontmatter('langs: [en, 2]', FILE)).toThrow(/"langs"/)
    expect(() => parseFrontmatter('langs: [en, fr, de, it]', FILE)).toThrow(/"langs" has 4 entries \(max 3\)/)
    expect(() => parseFrontmatter('createdAt: not a date', FILE)).toThrow(/"createdAt"/)
    expect(() => parseFrontmatter('createdAt: 42', FILE)).toThrow(/"createdAt"/)
    expect(() => parseFrontmatter('link: true', FILE)).toThrow(/"link"/)
    expect(() => parseFrontmatter('link: ftp://example.com', FILE)).toThrow(/"link"/)
    expect(() => parseFrontmatter('link: not a url', FILE)).toThrow(/"link"/)
    expect(() => parseFrontmatter('thread: sometimes', FILE)).toThrow(/"thread" must be one of auto, manual, off/)
    expect(() => parseFrontmatter('thread: true', FILE)).toThrow(/"thread"/)
  })
})
