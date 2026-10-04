import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_COMMIT_MESSAGE,
  DEFAULT_SERVICE,
  describeOptions,
  parseBoolean,
  parseLimit,
  resolveOptions,
  toRunOptions,
  UsageError,
  withDefaults,
} from '../src/config.js'

describe('parseBoolean', () => {
  it('accepts true/false/1/0/yes/no case-insensitively', () => {
    for (const v of ['true', 'TRUE', 'True', '1', 'yes', 'YES', ' yes ']) expect(parseBoolean(v, 'x')).toBe(true)
    for (const v of ['false', 'FALSE', '0', 'no', 'No']) expect(parseBoolean(v, 'x')).toBe(false)
    expect(parseBoolean(true, 'x')).toBe(true)
    expect(parseBoolean(false, 'x')).toBe(false)
  })

  it('treats undefined and empty as unset', () => {
    expect(parseBoolean(undefined, 'x')).toBeUndefined()
    expect(parseBoolean('', 'x')).toBeUndefined()
    expect(parseBoolean('   ', 'x')).toBeUndefined()
  })

  it('rejects anything else as a usage error naming the option', () => {
    expect(() => parseBoolean('maybe', 'POST_TOGETHER_DRY_RUN')).toThrow(UsageError)
    expect(() => parseBoolean('maybe', 'POST_TOGETHER_DRY_RUN')).toThrow(/POST_TOGETHER_DRY_RUN/)
    expect(() => parseBoolean('on', 'x')).toThrow(UsageError)
    expect(() => parseBoolean('2', 'x')).toThrow(UsageError)
  })
})

describe('parseLimit', () => {
  it('accepts non-negative integers', () => {
    expect(parseLimit('0', 'x')).toBe(0)
    expect(parseLimit('12', 'x')).toBe(12)
    expect(parseLimit(3, 'x')).toBe(3)
    expect(parseLimit(undefined, 'x')).toBeUndefined()
    expect(parseLimit('', 'x')).toBeUndefined()
  })

  it('rejects negative, fractional and non-numeric values', () => {
    expect(() => parseLimit('-1', '--limit')).toThrow(UsageError)
    expect(() => parseLimit('1.5', '--limit')).toThrow(UsageError)
    expect(() => parseLimit('abc', '--limit')).toThrow(/--limit/)
    expect(() => parseLimit(-2, '--limit')).toThrow(UsageError)
    expect(() => parseLimit(1.5, '--limit')).toThrow(UsageError)
  })
})

describe('resolveOptions', () => {
  const cwd = '/tmp/work'

  it('applies defaults when nothing is set', () => {
    const o = resolveOptions({ cwd }, {})
    expect(o).toEqual({
      dir: 'posts',
      stateFile: path.join('posts', '.post-together.json'),
      identifier: undefined,
      password: undefined,
      service: DEFAULT_SERVICE,
      dryRun: false,
      limit: 0,
      linkCards: true,
      threadCounter: false,
      commit: false,
      commitMessage: DEFAULT_COMMIT_MESSAGE,
      cwd: path.resolve(cwd),
      mode: 'post',
    })
  })

  it('derives the default state file from the resolved dir', () => {
    expect(resolveOptions({ dir: 'content/posts', cwd }, {}).stateFile).toBe(path.join('content/posts', '.post-together.json'))
    expect(resolveOptions({ cwd }, { POST_TOGETHER_DIR: 'blog' }).stateFile).toBe(path.join('blog', '.post-together.json'))
    expect(resolveOptions({ cwd }, { 'INPUT_DIR': 'notes' }).stateFile).toBe(path.join('notes', '.post-together.json'))
  })

  it('reads GitHub Action INPUT_* variables, hyphens kept', () => {
    const o = resolveOptions(
      { cwd },
      {
        'INPUT_DIR': 'in-dir',
        'INPUT_STATE-FILE': 'in-state.json',
        'INPUT_IDENTIFIER': 'in.bsky.social',
        'INPUT_APP-PASSWORD': 'in-pass',
        'INPUT_SERVICE': 'https://in.example',
        'INPUT_DRY-RUN': 'true',
        'INPUT_LIMIT': '4',
        'INPUT_LINK-CARDS': 'false',
        'INPUT_THREAD-COUNTER': 'yes',
        'INPUT_COMMIT': '1',
        'INPUT_COMMIT-MESSAGE': 'in msg',
        'INPUT_MODE': 'init',
      },
    )
    expect(o).toMatchObject({
      dir: 'in-dir',
      stateFile: 'in-state.json',
      identifier: 'in.bsky.social',
      password: 'in-pass',
      service: 'https://in.example',
      dryRun: true,
      limit: 4,
      linkCards: false,
      threadCounter: true,
      commit: true,
      commitMessage: 'in msg',
      mode: 'init',
    })
  })

  it('lets environment variables override INPUT_* values', () => {
    const o = resolveOptions(
      { cwd },
      {
        'INPUT_DIR': 'in-dir',
        'INPUT_APP-PASSWORD': 'in-pass',
        'INPUT_DRY-RUN': 'true',
        'INPUT_LINK-CARDS': 'true',
        POST_TOGETHER_DIR: 'env-dir',
        POST_TOGETHER_STATE_FILE: 'env-state.json',
        BSKY_IDENTIFIER: 'env.bsky.social',
        BSKY_APP_PASSWORD: 'env-pass',
        BSKY_SERVICE: 'https://env.example',
        POST_TOGETHER_DRY_RUN: 'false',
        POST_TOGETHER_LIMIT: '2',
        POST_TOGETHER_LINK_CARDS: 'no',
        POST_TOGETHER_THREAD_COUNTER: 'true',
        POST_TOGETHER_COMMIT: 'true',
        POST_TOGETHER_COMMIT_MESSAGE: 'env msg',
      },
    )
    expect(o).toMatchObject({
      dir: 'env-dir',
      stateFile: 'env-state.json',
      identifier: 'env.bsky.social',
      password: 'env-pass',
      service: 'https://env.example',
      dryRun: false,
      limit: 2,
      linkCards: false,
      threadCounter: true,
      commit: true,
      commitMessage: 'env msg',
    })
  })

  it('lets CLI flags override everything', () => {
    const o = resolveOptions(
      {
        dir: 'flag-dir',
        stateFile: 'none',
        identifier: 'flag.bsky.social',
        password: 'flag-pass',
        service: 'https://flag.example',
        dryRun: true,
        limit: '7',
        linkCards: false,
        threadCounter: true,
        commit: true,
        commitMessage: 'flag msg',
        cwd,
        mode: 'init',
      },
      {
        POST_TOGETHER_DIR: 'env-dir',
        POST_TOGETHER_STATE_FILE: 'env-state.json',
        BSKY_IDENTIFIER: 'env.bsky.social',
        BSKY_APP_PASSWORD: 'env-pass',
        BSKY_SERVICE: 'https://env.example',
        POST_TOGETHER_DRY_RUN: 'false',
        POST_TOGETHER_LIMIT: '2',
        POST_TOGETHER_LINK_CARDS: 'true',
        POST_TOGETHER_THREAD_COUNTER: 'false',
        POST_TOGETHER_COMMIT: 'false',
        POST_TOGETHER_COMMIT_MESSAGE: 'env msg',
        'INPUT_DIR': 'in-dir',
      },
    )
    expect(o).toEqual({
      dir: 'flag-dir',
      stateFile: 'none',
      identifier: 'flag.bsky.social',
      password: 'flag-pass',
      service: 'https://flag.example',
      dryRun: true,
      limit: 7,
      linkCards: false,
      threadCounter: true,
      commit: true,
      commitMessage: 'flag msg',
      cwd: path.resolve(cwd),
      mode: 'init',
    })
  })

  it('treats empty strings as unset at every layer', () => {
    const o = resolveOptions({ dir: '', identifier: '', cwd }, { POST_TOGETHER_DIR: '', BSKY_IDENTIFIER: '  ', 'INPUT_DIR': 'in-dir' })
    expect(o.dir).toBe('in-dir')
    expect(o.identifier).toBeUndefined()
  })

  it('rejects bad booleans, limits and modes with a usage error', () => {
    expect(() => resolveOptions({ cwd }, { POST_TOGETHER_DRY_RUN: 'maybe' })).toThrow(UsageError)
    expect(() => resolveOptions({ cwd }, { POST_TOGETHER_DRY_RUN: 'maybe' })).toThrow(/POST_TOGETHER_DRY_RUN/)
    expect(() => resolveOptions({ cwd }, { 'INPUT_DRY-RUN': 'nope' })).toThrow(/dry-run/)
    expect(() => resolveOptions({ cwd }, { POST_TOGETHER_LIMIT: '-3' })).toThrow(UsageError)
    expect(() => resolveOptions({ limit: 'many', cwd }, {})).toThrow(/--limit/)
    expect(() => resolveOptions({ mode: 'publish', cwd }, {})).toThrow(/mode/)
    expect(() => resolveOptions({ cwd }, { 'INPUT_MODE': 'delete' })).toThrow(UsageError)
  })

  it('resolves cwd against the process cwd when relative', () => {
    expect(resolveOptions({ cwd: 'sub/dir' }, {}).cwd).toBe(path.resolve('sub/dir'))
    expect(resolveOptions({}, {}).cwd).toBe(process.cwd())
  })

  describe('with vi.stubEnv', () => {
    afterEach(() => vi.unstubAllEnvs())

    it('works against process.env', () => {
      vi.stubEnv('INPUT_APP-PASSWORD', 'stubbed-pass')
      vi.stubEnv('INPUT_DRY-RUN', 'YES')
      vi.stubEnv('INPUT_STATE-FILE', 'stubbed.json')
      vi.stubEnv('BSKY_IDENTIFIER', 'stub.bsky.social')
      const o = resolveOptions({ cwd }, process.env)
      expect(o.password).toBe('stubbed-pass')
      expect(o.dryRun).toBe(true)
      expect(o.stateFile).toBe('stubbed.json')
      expect(o.identifier).toBe('stub.bsky.social')
    })
  })
})

describe('withDefaults and toRunOptions', () => {
  it('fills defaults for programmatic options', () => {
    const o = withDefaults({ dir: 'p', cwd: '/x' })
    expect(o.stateFile).toBe(path.join('p', '.post-together.json'))
    expect(o.service).toBe(DEFAULT_SERVICE)
    expect(o.linkCards).toBe(true)
    expect(o.limit).toBe(0)
    expect(o.mode).toBe('post')
  })

  it('validates limit and mode', () => {
    expect(() => withDefaults({ limit: -1 })).toThrow(UsageError)
    expect(() => withDefaults({ limit: 1.5 })).toThrow(UsageError)
    expect(() => withDefaults({ mode: 'oops' as 'post' })).toThrow(UsageError)
  })

  it('omits undefined credentials when converting back to RunOptions', () => {
    const o = toRunOptions(withDefaults({ cwd: '/x' }))
    expect('identifier' in o).toBe(false)
    expect('password' in o).toBe(false)
    const withCreds = toRunOptions(withDefaults({ cwd: '/x', identifier: 'a', password: 'b' }))
    expect(withCreds.identifier).toBe('a')
    expect(withCreds.password).toBe('b')
  })
})

describe('describeOptions', () => {
  it('masks the password and never prints it', () => {
    const text = describeOptions(withDefaults({ identifier: 'me.bsky.social', password: 'hunter2-secret', cwd: '/x' }))
    expect(text).not.toContain('hunter2-secret')
    expect(text).toContain('password="***"')
    expect(text).toContain('identifier="me.bsky.social"')
  })

  it('omits an unset password entirely', () => {
    expect(describeOptions(withDefaults({ cwd: '/x' }))).not.toContain('password')
  })
})
