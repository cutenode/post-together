import type { Logger } from './types.js'

/** Plain console logger used by the CLI and as the default. Never prints ANSI colour codes. */
export const consoleLogger: Logger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.error(`warning: ${msg}`),
  error: (msg) => console.error(`error: ${msg}`),
  debug: (msg) => {
    if (process.env['POST_TOGETHER_DEBUG'] === 'true' || process.env['RUNNER_DEBUG'] === '1') console.error(`debug: ${msg}`)
  },
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} }
