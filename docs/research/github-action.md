# Packaging & publishing a JS/TS GitHub Action that is also an `npx` CLI

Research report, verified 2026-09-28. "Verbatim" blocks are copied from the cited source. Anything not confirmed from a primary source is marked **UNVERIFIED**. Old `docs.github.com/en/actions/creating-actions/...` URLs all 301 to the new paths cited below.

---

## 1. `action.yml` metadata syntax

Source: https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax

### `runs` for JavaScript actions (verbatim)

```
## `runs` for JavaScript actions
**Required** Configures the path to the action's code and the runtime used to execute the code.

### `runs.using` for JavaScript actions
**Required** The runtime used to execute the code specified in `main`.
* Use `node20` for Node.js v20.
* Use `node24` for Node.js v24.

### `runs.main`
**Required** The file that contains your action code. The runtime specified in `using` executes this file.

### `runs.pre`
**Optional** Allows you to run a script at the start of a job, before the `main:` action begins. ... The `pre:` action always runs by default but you can override this using `runs.pre-if`.
> [!NOTE] `runs.pre` is not supported for local actions.

### `runs.post`
**Optional** Allows you to run a script at the end of a job, once the `main:` action has completed. ...
```

```yaml
runs:
  using: 'node24'
  pre: 'setup.js'
  main: 'index.js'
  post: 'cleanup.js'
```

`node16` is no longer documented (only `node20` and `node24` are listed). The runner's parser still accepts the string (`ActionManifestManager.cs` on `main`: `'using: X' is not supported, use 'docker', 'node12', 'node16', 'node20' or 'node24' instead.`, https://raw.githubusercontent.com/actions/runner/main/src/Runner.Worker/ActionManifestManager.cs) but the Node 16/20 binaries are no longer shipped on GitHub-hosted runners (see §10), so **`node24` is the only value that works on github.com today.**

### `inputs` (verbatim)

- `inputs.<input_id>`: "**Required** ... The `<input_id>` must start with a letter or `_` and contain only alphanumeric characters, `-`, or `_`."
- `inputs.<input_id>.description`: Required string.
- `inputs.<input_id>.required`: Optional boolean.
- `inputs.<input_id>.default`: Optional string.
- `inputs.<input_id>.deprecationMessage`: Optional string, logged as a warning when the input is used.

> "When you specify an input, GitHub creates an environment variable for the input with the name `INPUT_<VARIABLE_NAME>`. The environment variable created converts input names to uppercase letters and replaces spaces with `_` characters."
> "For example, if a workflow defined the `num-octocats` and `octocat-eye-color` inputs, the action code could read the values of the inputs using the `INPUT_NUM-OCTOCATS` and `INPUT_OCTOCAT-EYE-COLOR` environment variables."

The hyphen is **kept** (only spaces become `_`). The typescript-action template's `.env.example` repeats this: `# GitHub Actions inputs should follow INPUT_<name> format (case-sensitive). Hyphens should not be converted to underscores!` (https://raw.githubusercontent.com/actions/typescript-action/main/.env.example). Composite actions do **not** get `INPUT_*`; they use the `inputs` context.

### `outputs`
- `outputs.<output_id>.description`: Required.
- `outputs.<output_id>.value`: Required **for composite actions only**.

### `branding` (verbatim)
- `branding.color`: "Can be one of: `white`, `black`, `yellow`, `blue`, `green`, `orange`, `red`, `purple`, or `gray-dark`."
- `branding.icon`: "The name of the v4.28.0 Feather icon to use." Omitted: brand icons plus `coffee, columns, divide-circle, divide-square, divide, frown, hexagon, key, meh, mouse-pointer, smile, tool, x-octagon`.

### The template's `action.yml` (verbatim, https://raw.githubusercontent.com/actions/typescript-action/main/action.yml)

```yaml
name: The name of your action here
description: Provide a description here
author: Your name or organization here

branding:
  icon: heart
  color: red

inputs:
  milliseconds:
    description: Your input description here
    required: true
    default: '1000'

outputs:
  time:
    description: Your output description here

runs:
  using: node24
  main: dist/index.js
```

---

## 2. How inputs/outputs/failure/secrets flow

### Inputs: `@actions/core` source (verbatim, https://raw.githubusercontent.com/actions/toolkit/main/packages/core/src/core.ts)

```ts
export function getInput(name: string, options?: InputOptions): string {
  const val: string =
    process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || ''
  if (options && options.required && !val) {
    throw new Error(`Input required and not supplied: ${name}`)
  }

  if (options && options.trimWhitespace === false) {
    return val
  }

  return val.trim()
}

export function getMultilineInput(name: string, options?: InputOptions): string[] {
  const inputs: string[] = getInput(name, options)
    .split('\n')
    .filter(x => x !== '')

  if (options && options.trimWhitespace === false) {
    return inputs
  }

  return inputs.map(input => input.trim())
}
```

`getBooleanInput` doc comment: "Gets the input value of the boolean type in the YAML 1.2 "core schema" specification. Support boolean input list: `true | True | TRUE | false | False | FALSE`. The return value is also in boolean type." (throws a `TypeError` otherwise, per README, https://github.com/actions/toolkit/blob/main/packages/core/README.md).

Because `getInput` is just an env lookup, a zero-dependency fallback for a CLI is literally `process.env['INPUT_' + name.replace(/ /g,'_').toUpperCase()]`.

### Outputs, env, state, secrets, failure
- `setOutput(name, value)` → `issueFileCommand('OUTPUT', ...)` when `GITHUB_OUTPUT` is set (falls back to the deprecated `::set-output` command otherwise).
- `exportVariable` → `GITHUB_ENV` file; `saveState/getState` → `GITHUB_STATE`.
- `setSecret(secret)` → `issueCommand('add-mask', {}, secret)`; the README says it "registers the secret with the runner to ensure it is masked in logs".
- ```ts
  export enum ExitCode { Success = 0, Failure = 1 }
  export function setFailed(message: string | Error): void {
    process.exitCode = ExitCode.Failure
    error(message)
  }
  ```
  Any non-zero process exit code fails the step; `setFailed` sets `exitCode=1` and prints an `::error::` annotation.
- Job summary: `core.summary.addHeading('My Heading','2').addTable([...]).write({overwrite: true})` → writes to `GITHUB_STEP_SUMMARY` (README).

### Shell/file equivalents: workflow commands
Source: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
- Output: `echo "{name}={value}" >> "$GITHUB_OUTPUT"`; multiline via `{name}<<DELIM` ... `DELIM`.
- Mask: `::add-mask::{value}`. "Each masked word separated by whitespace is replaced with the `*` character."
- Env: `echo "{name}={value}" >> "$GITHUB_ENV"`
- Summary: `echo "{markdown content}" >> $GITHUB_STEP_SUMMARY`; limit 1 MiB per step, max 20 step summaries shown per job.
- Annotations: `::error file=app.js,line=1::Message` (also `warning`, `notice`; params `title,col,endColumn,endLine`); grouping `::group::{title}` / `::endgroup::`.
- `::set-output` / `::save-state` are deprecated in favour of the env files.

---

## 3. Default environment variables

Source: https://docs.github.com/en/actions/reference/workflows-and-actions/variables

| Var | Description |
|---|---|
| `CI` | "Always set to `true`. You can use this variable to differentiate when tests are being run locally or by GitHub Actions." |
| `GITHUB_ACTIONS` | "Always set to `true` when GitHub Actions is running the workflow" |
| `GITHUB_ACTION` | id of the current action/step |
| `GITHUB_ACTOR` | "The name of the person or app that initiated the workflow" |
| `GITHUB_EVENT_NAME` | "The name of the event that triggered the workflow" |
| `GITHUB_EVENT_PATH` | "The path to the file on the runner that contains the full event webhook payload" |
| `GITHUB_REF` | "The fully-formed ref of the branch or tag that triggered the workflow run" |
| `GITHUB_REF_NAME` | "The short ref name of the branch or tag that triggered the workflow run" |
| `GITHUB_REF_TYPE` | "Valid values are `branch` or `tag`" |
| `GITHUB_HEAD_REF` / `GITHUB_BASE_REF` | PR source / target branch (PR events only) |
| `GITHUB_REPOSITORY` | "The owner and repository name. For example, `octocat/Hello-World`" |
| `GITHUB_SHA` | "The commit SHA that triggered the workflow" |
| `GITHUB_WORKSPACE` | "The default working directory on the runner for steps" |
| `GITHUB_RUN_ID` | "A unique number for each workflow run within a repository" |
| `GITHUB_SERVER_URL` | "The URL of the GitHub server. For example: `https://github.com`" |
| `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_STEP_SUMMARY`, `GITHUB_STATE`, `GITHUB_PATH` | env-file paths for workflow commands |
| `RUNNER_OS` | "Possible values are `Linux`, `Windows`, or `macOS`" |

`GITHUB_TOKEN` is **not** an env var by default; pass it explicitly (`env: GITHUB_TOKEN: ${{ github.token }}` or an input).

---

## 4. Bundling and `dist/`

### Why `dist/` must be committed
Source: https://docs.github.com/en/actions/tutorials/create-actions/create-a-javascript-action, verbatim:
> "GitHub downloads each action run in a workflow during runtime and executes it as a complete package of code before you can use workflow commands like `run` to interact with the runner machine. This means you must include any package dependencies required to run the JavaScript code."
> "Checking in your `node_modules` directory can cause problems. As an alternative, you can use tools such as `rollup.js` or `@vercel/ncc` to combine your code and dependencies into one file for distribution."
> "You should not commit the `node_modules` directory to your repository."

The tutorial (Prerequisite: "Download and install Node.js 24.x") now installs `rollup @rollup/plugin-commonjs @rollup/plugin-node-resolve`, runs `rollup --config rollup.config.js`, and commits `dist/index.js`.

### Which bundler the official templates use (2026): **Rollup**, ESM output
- `actions/typescript-action` `rollup.config.ts` (verbatim):
  ```ts
  import commonjs from '@rollup/plugin-commonjs'
  import nodeResolve from '@rollup/plugin-node-resolve'
  import typescript from '@rollup/plugin-typescript'

  const config = {
    input: 'src/index.ts',
    output: { esModule: true, file: 'dist/index.js', format: 'es', sourcemap: true },
    plugins: [typescript(), nodeResolve({ preferBuiltins: true }), commonjs()]
  }
  export default config
  ```
- `package.json`: `"type": "module"`, `"engines": {"node": ">=24.0.0"}`, `"package": "npx rimraf ./dist && npx rollup --config rollup.config.ts --configPlugin @rollup/plugin-typescript"`, `"dependencies": {"@actions/core": "^3.0.0"}`, rollup `^4.57.1`, typescript `^5.9.3`, jest `^30.2.0`.
- `tsconfig.json`: `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"target": "ES2022"`.
- `.node-version` = `24.4.0`.
- `@vercel/ncc` is still maintained (0.45.0, 2026-08-13) but no longer what the official templates use.
- esbuild (0.28.2): `esbuild app.js --bundle --platform=node --outfile=out.js`; with `--platform=node` "the default output format is set to cjs" and "All built-in node modules such as fs are automatically marked as external"; use `--format=esm --target=node24` for an ESM bundle (https://esbuild.github.io/api/). A test build confirmed that bundling `@atproto/api` + `@actions/core` to ESM with esbuild requires the banner `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);` or the bundle throws `Dynamic require of "..." is not supported` at load. Output is 2.1 MB, 1.2 MB minified.

### ESM vs CJS gotchas for node20/node24 actions
- `main` can point at an ESM file. The runner spawns the bundled Node binary with the script path as its only argument (`NodeScriptActionHandler.cs`, https://raw.githubusercontent.com/actions/runner/main/src/Runner.Worker/Handlers/NodeScriptActionHandler.cs), so Node's normal rules decide the module type: `.mjs` → ESM, `.js` → ESM if nearest `package.json` has `"type": "module"`. The template relies on this; `cloudflare/wrangler-action` uses `using: "node24"` + `main: "dist/index.mjs"`. Since the whole repo is downloaded at the ref, `package.json` is present next to `dist/`.
- Top-level `await` is fine in ESM. Default `--unhandled-rejections=throw` → exit code 1 = failed step; exit code 13 = "Unsettled Top-Level Await". Prefer an explicit `run().catch(...)` for a readable `::error::` annotation.
- No `require`, `__dirname`, `__filename` in ESM; use `import.meta.dirname` / `createRequire(import.meta.url)`.
- `@actions/core` **3.0.0 is ESM-only** ("Package is now ESM-only", https://github.com/actions/toolkit/blob/main/packages/core/RELEASES.md). Current: `@actions/core` 3.0.1 and `@actions/github` 9.1.1.

### "Check dist" CI pattern (verbatim, https://raw.githubusercontent.com/actions/typescript-action/main/.github/workflows/check-dist.yml)

```yaml
name: Check Transpiled JavaScript

on:
  pull_request:
    branches:
      - main
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  check-dist:
    name: Check dist/
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        id: checkout
        uses: actions/checkout@v6

      - name: Setup Node.js
        id: setup-node
        uses: actions/setup-node@v6
        with:
          node-version-file: .node-version
          cache: npm

      - name: Remove dist/ Directory
        id: remove-dist
        run: npx rimraf ./dist

      - name: Install Dependencies
        id: install
        run: npm ci

      - name: Build dist/ Directory
        id: build
        run: npm run bundle

      - name: Compare Directories
        id: diff
        run: |
          if [ ! -d dist/ ]; then
            echo "Expected dist/ directory does not exist.  See status below:"
            ls -la ./
            exit 1
          fi
          if [ "$(git diff --ignore-space-at-eol --text dist/ | wc -l)" -gt "0" ]; then
            echo "Detected uncommitted changes after build. See status below:"
            git diff --ignore-space-at-eol --text dist/
            exit 1
          fi

      - if: ${{ failure() && steps.diff.outcome == 'failure' }}
        name: Upload Artifact
        id: upload
        uses: actions/upload-artifact@v7
        with:
          name: dist
          path: dist/
```

Keep bundler settings deterministic and pin the bundler in `package-lock.json`, otherwise the diff check flaps.

---

## 5. Versioning and release

- https://docs.github.com/en/actions/how-tos/create-and-publish-actions/managing-custom-actions: "We recommend using tags for actions release management." Create `v1.0.1`, move `v1` to the current release, introduce `v2` for breaking changes. SHAs must be the **full** 40-char SHA.
- https://docs.github.com/en/actions/how-tos/create-and-publish-actions/release-and-maintain-actions: keep major (`v1`) and minor (`v1.1`) tags current.
- Toolkit `docs/action-versioning.md`: "Binding to a major version is the latest of that major version (e.g. v1 == '1.*')"; commands:
  ```
  git tag -fa v1 -m "Update v1 tag"
  git push origin v1 --force
  ```
- `actions/typescript-action` `script/release` tags `vX.Y.Z` annotated, force-moves `vX`, `git push --follow-tags`, `git push origin vX --force`, and on a new major creates `releases/vN` branch.
- Marketplace (https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace): "The action must be in a public repository." / "Each repository must contain a single action metadata file (`action.yml` or `action.yaml`) at the root." / "The `name` in the action's metadata file must be unique". An action living in a subdirectory of a monorepo cannot be listed on the Marketplace.

---

## 6. Referencing the action

Source: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax (`jobs.<job_id>.steps[*].uses`):

- `{owner}/{repo}@{ref}`: "You can specify a branch, ref, or SHA in a public GitHub repository."
- `{owner}/{repo}/{path}@{ref}`: "A subdirectory in a public GitHub repository at a specific branch, ref, or SHA."
- `./path/to/dir`: "You must check out your repository before using the action, and the `./` path resolves against the runner's workspace ... For most cases, use the `$/` syntax shown above instead."
- `$/path/to/action`: self-repository reference, added 2026-07-30 (https://github.blog/changelog/2026-07-30-reference-same-repository-actions-with-self-repository-syntax/): "A `uses:` value that starts with `$/` resolves to your workflow's own repository at the exact commit that is running, with no checkout required." Requires runner ≥ 2.336.0. Not available in GitHub Enterprise Server. Must not include `@{ref}`.
  ```yaml
  steps:
    - uses: $/.github/actions/hello-world-action
  ```
- Pinning guidance: "Using the commit SHA of a released action version is the safest for stability and security."

Template self-test job (verbatim):
```yaml
  test-action:
    name: GitHub Actions Test
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        id: checkout
        uses: actions/checkout@v6
      - name: Test Local Action
        id: test-action
        uses: ./
        with:
          milliseconds: 2000
      - name: Print Output
        id: output
        run: echo "${{ steps.test-action.outputs.time }}"
```

---

## 7. Dual package: one TypeScript core, `bin` for `npx` + `action.yml` entrypoint

### Facts
- Inputs are only `INPUT_*` env vars, so `getInput('foo')` ≡ `process.env.INPUT_FOO`. The runner exports an `INPUT_*` variable for every input that carries a default in `action.yml`, whether or not the workflow named it under `with:`.
- Runtime detection: `GITHUB_ACTIONS=true` and `CI=true` are always set on GitHub.
- Outputs/summary/annotations are files/env (`GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`) and `::error::` lines on stdout. Outside GitHub, `core.setOutput` falls back to printing `::set-output::`, so guard those calls behind the detection.

### Prior art (verified)
1. `chromaui/chromatic-cli`: `bin-src/` (CLI), `action-src/` (action), `node-src/` (shared core). `action-src/main.ts` imports from `@actions/core`, reads inputs, calls the shared `run`, loops `setOutput`, `setFailed` on non-zero. Built output is pushed to a separate distribution repo `chromaui/action` whose `action.yml` is `runs: { main: action/register.cjs, using: node24 }`.
2. `bitflight-devops/github-action-readme-generator` uses the same file as both the bin and the action main: `"bin": { "github-action-readme-generator": "dist/bin/index.js" }` and `runs: { using: 'node24', main: './dist/bin/index.js' }`. Config precedence: CLI args → config file → action inputs (`INPUT_*`) → `action.yml` defaults.
3. Wrapper pattern: ship the CLI to npm and make `action.yml` a `runs.using: composite` action whose step is `run: npx package@<pinned>`. **UNVERIFIED** canonical example.

### Recommended layout
```
src/core/run.ts        # pure: run(opts: Options): Promise<Result>; no @actions/* imports
src/cli.ts             # #!/usr/bin/env node; argv/env → Options; print; process.exitCode
src/action.ts          # getInput/getBooleanInput → Options; run(); setOutput; summary; setFailed
action.yml             # runs: { using: node24, main: dist/action.js }
package.json           # "type":"module", "bin": {...:"./dist/cli.js"}, "files":["dist"]
```
- In the CLI, read config as `flag ?? process.env.MYTOOL_X ?? process.env['INPUT_X']`.
- Because `@actions/core` 3.x is ESM-only, use `"type": "module"` everywhere.

---

## 8. Committing state back to the repo from the action

### Token permissions
- `permissions` key: "if you specify the access for any of these permissions, all of those that are not specified are set to `none`." Use `permissions: contents: write`.
- Defaults: "By default, when you create a new repository in your personal account, `GITHUB_TOKEN` only has read access for the `contents` and `packages` scopes."
- Forks: PRs from forks get read-only tokens, so run the state-writing job on `push` to the default branch.

### The push recipe (actions/checkout README, verbatim)
```yaml
      - uses: actions/checkout@v6
      - run: |
          date > generated.txt
          # Note: the following account information will not work on GHES
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add .
          git commit -m "generated"
          git push
```

- `persist-credentials`: default `true`; leave it on for the job that pushes.
- `fetch-depth`: default `1`. Pushing from a shallow clone is allowed; `fetch-depth: 0` only if you rebase/merge/`git describe`.
- Detached HEAD on `pull_request`: the default PR checkout is `refs/pull/N/merge`, so `git push` has nowhere to go. Do the state commit on `push:` events to `main`.
- `GITHUB_TOKEN` pushes do not trigger workflows, which acts as a built-in recursion guard. https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow: "events triggered by the `GITHUB_TOKEN` will not create a new workflow run" (except `workflow_dispatch`/`repository_dispatch`).
- `[skip ci]` (https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs): `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`, or `skip-checks: true` trailer. Only for `push` and `pull_request` events. Needed only with a PAT/App token.
- Recommended extras: `concurrency:` group, `git pull --rebase` before push, commit only when `git diff --quiet -- state.json` is false.

---

## 9. Testing

- Official template: Jest 30 ESM with `jest.unstable_mockModule('@actions/core', () => core)` and dynamic import of the module under test; `src/index.ts` is `import { run } from './main.js'; run()` so tests import `main`, never the entrypoint.
- Vitest equivalent (https://vitest.dev/api/vi.html): `vi.mock(path, factory?)` is hoisted; `vi.stubEnv('INPUT_FOO', 'bar')` / `vi.unstubAllEnvs()` for env-based config tests. Vitest runs ESM natively.
- Local run: `@github/local-action` (7.0.1): `npx @github/local-action . src/action.ts .env` with `INPUT_*` in `.env`. Plain Node also works: `INPUT_X=... GITHUB_OUTPUT=$(mktemp) GITHUB_STEP_SUMMARY=$(mktemp) node dist/action.js` because the runner does nothing more than `node <main>`.
- `nektos/act` accepts `node24` since v0.2.81 (2025-09-01) but runs JS actions with the container's PATH node; use an image that has Node 24 (`catthehacker/ubuntu:full-latest`).

---

## 10. Node on `ubuntu-latest` and what `node24` requires

- `ubuntu-latest` → `ubuntu-24.04`. Image `20260920.314.1`: default Node.js 22.23.2; tool-cache 22.23.2 and 24.21.0. This is the Node for `run:` steps. JavaScript *actions* use the runner's bundled Node from `externals/<nodeXX>/bin/node`.
- Timeline: runner v2.327.1 added Node 24 support. Node 20 EOL April 2026; from 2026-06-16 runners used Node 24 by default. **2026-09-23** (https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/): "Node 20 is no longer available on GitHub Actions runners. Runners now use Node 24 for JavaScript actions." Maintainers must "update its `runs.using` value to `node24`". Actions still declaring `node20` are executed under Node 24 (runner `NodeUtil.DetermineActionsNodeVersion` "Phase 3: Always use Node 24").
- Node 24 requirements: self-hosted runner ≥ v2.327.1; incompatible with macOS 13.4 and earlier; no ARM32.
- Template pins: `.node-version` 24.4.0, `engines.node >=24.0.0`, `@actions/core ^3.0.0`, `actions/checkout@v6`, `actions/setup-node@v6`, `actions/upload-artifact@v7`.

---

## Decision summary for post-together
1. `action.yml` at repo root, `runs: { using: node24, main: dist/action.js }`; `branding` from the allowed lists.
2. `"type": "module"`, TS `NodeNext`, esbuild ESM bundle with the `createRequire` banner → committed `dist/action.js` + the `check-dist` workflow; `@actions/core@3`.
3. Core `run(options)` with zero `@actions/*` imports; thin `cli.ts` (`bin`) and `action.ts`.
4. State commit: job on `push` to `main`, `permissions: contents: write`, checkout with default `persist-credentials: true`, `github-actions[bot]` identity, `git push`; no re-trigger with `GITHUB_TOKEN`.
5. Same-repo use via `$/` (runner ≥ 2.336.0) or `./` after checkout; externally `owner/repo@v1` with `v1` force-moved on release.
6. Tests: vitest `vi.mock`/`vi.stubEnv`; local runs via plain `INPUT_*=... node dist/action.js`.

### Sources
- https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax
- https://docs.github.com/en/actions/tutorials/create-actions/create-a-javascript-action
- https://docs.github.com/en/actions/reference/workflows-and-actions/variables
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- https://docs.github.com/en/actions/how-tos/create-and-publish-actions/managing-custom-actions
- https://docs.github.com/en/actions/how-tos/create-and-publish-actions/release-and-maintain-actions
- https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs
- https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
- https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/
- https://github.blog/changelog/2026-07-30-reference-same-repository-actions-with-self-repository-syntax/
- https://github.com/actions/typescript-action · https://github.com/actions/javascript-action · https://github.com/actions/toolkit · https://github.com/actions/runner · https://github.com/actions/checkout · https://github.com/actions/runner-images · https://github.com/github/local-action
- https://github.com/vercel/ncc · https://esbuild.github.io/api/ · https://vitest.dev/api/vi.html · https://nodejs.org/api/esm.html
- https://github.com/nektos/act · https://github.com/chromaui/chromatic-cli · https://github.com/chromaui/action · https://github.com/bitflight-devops/github-action-readme-generator · https://raw.githubusercontent.com/cloudflare/wrangler-action/main/action.yml
