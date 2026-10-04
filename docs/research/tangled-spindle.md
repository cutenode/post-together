# Tangled / Spindle CI: technical reference for building a reusable step

Research report, verified 2026-09-28. `tangled.sh` redirects to `tangled.org`. Source of truth is the monorepo `tangled.org/core` (Go spindle + Rust knot2); raw files at `https://tangled.org/tangled.org/core/raw/master/<path>`. Rendered docs: https://docs.tangled.org/spindles (source: `docs/DOCS.md`). **VERIFIED** = read from the raw file at the cited URL; **UNVERIFIED** = not confirmed from a primary source.

Primary sources:
- DOCS = https://tangled.org/tangled.org/core/raw/master/docs/DOCS.md (Spindles section; rendered at https://docs.tangled.org/spindles)
- DEF = https://tangled.org/tangled.org/core/blob/master/workflow/def.go (YAML parser / trigger matcher)
- COMPILE = https://tangled.org/tangled.org/core/blob/master/workflow/compile.go
- NIXERY = https://tangled.org/tangled.org/core/blob/master/spindle/engines/nixery/engine.go (+ `setup_steps.go`, `envs.go`, `cache.go`)
- MICROVM = https://tangled.org/tangled.org/core/blob/master/spindle/engines/microvm/engine.go (+ `models.go`, `README.md`)
- ENVVARS = https://tangled.org/tangled.org/core/blob/master/spindle/models/pipeline_env.go
- CLONE = https://tangled.org/tangled.org/core/blob/master/spindle/models/clone.go
- MANIFEST = https://tangled.org/tangled.org/core/blob/master/spindle/engine/manifest.go (unknown-key validation)
- CONFIG = https://tangled.org/tangled.org/core/blob/master/spindle/config/config.go
- SERVER = https://tangled.org/tangled.org/core/blob/master/spindle/server.go
- SECRETS = https://tangled.org/tangled.org/core/blob/master/spindle/secrets/manager.go, `spindle/xrpc/add_secret.go`
- LEX-PIPELINE = https://tangled.org/tangled.org/core/blob/master/lexicons/pipeline/pipeline.json
- BLOG1 = https://blog.tangled.org/ci/ ("Introducing spindle", 2025-08-06)
- BLOG2 = https://blog.tangled.org/spindle-microvm/ ("Tangled CI runs on microVMs", 2026-06-16)
- INFRA = https://tangled.org/tangled.org/infra/blob/master/hosts/spindle-hel/services/spindle.nix (production config)

---

## 1. Workflow file location, naming, and YAML schema

### Location & naming (VERIFIED)
- `WorkflowDir = ".tangled/workflows"` (DEF). DOCS: "They're located in the `.tangled/workflows` directory at the root of your repository, and are defined using YAML."
- **Every regular file in that directory is loaded as a workflow; no extension filter** (SERVER `loadPipeline()`). `.yml` and `.yaml` both work: `tangled.org/core` uses `build.yml`, `tangled.org/site` uses `deploy.yaml`.
- The workflow's **name is the filename**, shown in the UI and used as the `workflows[]` selector in manual triggers.
- All workflow files in a pipeline run **in parallel**; steps inside a workflow run **serially**.
- Push options: `git push -o skip-ci` skips CI; `git push -o verbose-ci` prints parse errors and "workflow skipped" warnings.

### Generic top-level keys (VERIFIED from DEF Go struct)
```go
Workflow struct {
    Engine    string       `yaml:"engine"`
    RunsOn    []string     `yaml:"runs_on"`
    When      []Constraint `yaml:"when"`
    CloneOpts CloneOpts    `yaml:"clone"`
}
Constraint struct {
    Event    StringList `yaml:"event"`
    Types    StringList `yaml:"types"`    // pull_request only; default opened, reopened, synchronize
    Branch   StringList `yaml:"branch"`   // required for pull_request; for push, branch or tag
    Tag      StringList `yaml:"tag"`      // push only
    Paths    StringList `yaml:"paths"`    // only run if any changed file matches a glob
    Schedule []Schedule `yaml:"schedule"`
}
Schedule struct { Cron string `yaml:"cron"`; Timezone string `yaml:"timezone"` }
CloneOpts struct { Skip bool `yaml:"skip"`; Depth int `yaml:"depth"`; IncludeSubmodules *bool `yaml:"submodules"`; Tags *bool `yaml:"tags"` }
```
- `StringList` accepts a scalar or a list.
- Trigger kinds: `push`, `pull_request`, `manual`, `schedule`.
- A workflow with no `when` runs on every event (code), though DOCS call `when` required. `engine` **is** enforced (`MissingEngine` in COMPILE).
- Push: ref matched against `branch` or `tag` with doublestar globs. PR: `branch` is the **target** branch. `paths`: at least one changed file must match.
- Schedule: 5-field cron, optional IANA `timezone` (default UTC), Jenkins-style `H`; min interval 5m.

DOCS trigger examples (verbatim):
```yaml
when:
  - event: ["push", "manual"]
    branch: ["main", "develop"]
  - event: ["pull_request"]
    branch: ["main"]
```
```yaml
when:
  - event: schedule
    schedule:
      - cron: "H 2 * * *"
        timezone: America/New_York
```

### Clone options (VERIFIED, with a docs/code discrepancy)
DOCS say defaults are `skip: false, depth: 1, submodules: false`, but DEF `AsRecord()` compiles omitted `submodules`/`tags` to `true`. Effective default fetch: `git fetch --depth=1 --recurse-submodules=yes --tags origin <sha>`. Set `submodules: false` / `tags: false` explicitly to avoid that.

### Engine-specific keys (VERIFIED)
Each engine re-parses the raw YAML with its own struct; **unknown keys are a hard error** (MANIFEST: `unknown field <path> (line N)`).

nixery:
```go
Steps []struct { Command string `yaml:"command"`; Name string `yaml:"name"`; Environment map[string]string `yaml:"environment"` } `yaml:"steps"`
Dependencies map[string][]string `yaml:"dependencies"`   // registry -> packages
Environment  map[string]string   `yaml:"environment"`
Cache        []models.CacheEntry `yaml:"cache"`
```
microvm:
```go
Image string `yaml:"image"`; Services, Virtualisation, Registry map[string]any
Dependencies []string `yaml:"dependencies"`   // flat list
Environment map[string]string; Substituters map[string]string; Cache []CacheEntry
Steps []struct { Name, Command string; Environment map[string]string } `yaml:"steps"`
```
- **Step fields are exactly `name`, `command`, `environment`.** No `run`, `uses`, `shell`, `if`, `working-directory`, `with`, `id`, or `timeout`.
- nixery `dependencies` is a **map** (registry → packages) and microvm `dependencies` is a **flat list**, so the two are not interchangeable.

### Complete documented example (DOCS "Complete nixery workflow", verbatim)
```yaml
# .tangled/workflows/build.yml

when:
  - event: ["push", "manual"]
    branch: ["main", "develop"]
  - event: ["pull_request"]
    branch: ["main"]

engine: "nixery"

clone:
  skip: false
  depth: 1
  submodules: false

dependencies:
  nixpkgs:
    - nodejs
    - go
  git+https://tangled.org/@example.com/my_pkg:
    - my_pkg

environment:
  GOOS: "linux"
  GOARCH: "arm64"
  NODE_ENV: "production"

steps:
  - name: "Build backend"
    command: "go build"
    environment:
      GOOS: "darwin"
      GOARCH: "arm64"
  - name: "Build frontend"
    command: "npm run build"
    environment:
      NODE_ENV: "production"
```

---

## 2. Execution environment

### Engines (VERIFIED)
`engine` must be `nixery` or `microvm`. The hosted spindle (`spindle.tangled.sh`) offers both; images `nixos`, `alpine`, `almalinux10` (INFRA).

### nixery engine (VERIFIED)
- Image built on the fly from Nixery: `<nixery>/<nixpkgs deps>/bash/git/coreutils/gnutar/zstd/nix`. **Only the `nixpkgs` registry key contributes to the image**; other registry keys become an injected "Install custom dependencies" step running `nix profile add '<registry>#<pkg>'`.
- Always-present tools: `bash`, `git`, `coreutils`, `gnutar`, `zstd`, `nix`. Nothing else (no `sed`/`grep`/`findutils` unless listed).
- **One Docker container per workflow**; each step is `docker exec ... bash -c "<command>"`. `WorkingDir: /tangled/workspace`. Steps run as **root**. Memory limit default 6144 MiB. Filesystem state persists across steps.
- Base env: `HOME=/tangled/home`, `PATH=/tangled/home/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`. Env order: workflow `environment` → secrets → step `environment` → base env.
- Network: outbound internet works (real workflows run `npx --yes wrangler`, `curl`). No inbound.

### microvm engine (VERIFIED)
- One QEMU microVM per workflow. `image:` selects `nixos` (default), `alpine`, `almalinux10`.
- NixOS images understand `dependencies` (flat list; bare name = nixpkgs attr, or `flakeref#attr`), `registry`, `substituters`, `services.*`, `virtualisation.*`. Non-NixOS images: install with the image's package manager (`apk add nodejs npm`, **UNVERIFIED** names).
- Steps: `Cwd: /workspace/repo`, `User: spindle-workflow` (unprivileged). `dependencies` become a devshell sourced by every step.
- Base env: `HOME=/workspace`, `USER=spindle-workflow`, `PATH=/run/current-system/sw/bin:/nix/var/nix/profiles/default/bin:...`.
- Network: outbound only via `slirp4netns`; private ranges blackholed.

### Clone step for both engines (VERIFIED from CLONE)
```
git init
git remote add origin https://<knot>/<repoDid>
git fetch --depth=<depth|1> [--recurse-submodules=yes] [--tags] origin <sha>
git checkout FETCH_HEAD
```
Result: **detached HEAD at the trigger SHA**, remote `origin`, no local branch. **No push credentials are configured**; nothing in the environment authenticates to the knot.

---

## 3. Secrets

### Defining (VERIFIED)
- UI: repository **Settings → Pipelines** tab, "Secrets" section (visible once a spindle is selected), "Add secret" modal with `key` and `value`. UI copy: "Secrets are accessible in workflow runs via environment variables. Anyone with collaborator access to this repository can add and use secrets in workflow runs."
- XRPC: `sh.tangled.repo.addSecret` (input `repo` at-uri, `key` 1 to 50 chars, `value` 1 to 200 chars), `removeSecret`, `listSecrets` (never returns values). Scoped per repository DID.
- Key rule (SECRETS): `^[a-zA-Z_][a-zA-Z0-9_]*$` ("bash identifier syntax").
- **No first-party `tangled` CLI.** Third-party Rust CLI `tangled-cli` (https://github.com/overby-me/tangled-cli): `tangled spindle secret add --repo myrepo --key API_KEY --value "secret-value"`, `secret list`, `secret remove`.

### Exposure to steps (VERIFIED)
- Injected as plain `KEY=value` env vars into **every user step** on both engines. Not available to injected system steps.
- Log masking: values (and base64 encodings) replaced with `***` in stored logs.
- Whether secrets are withheld from fork PR pipelines: **UNVERIFIED**.
- DOCS warn: "**Do not put secrets here [environment], these environment variables are visible to anyone viewing the repository.**"

---

## 4. Environment variables provided automatically (VERIFIED from ENVVARS)

Always: `CI=true`, `TANGLED_PIPELINE_ID` (`at://did:web:<knot>/sh.tangled.pipeline/<rkey>`), `TANGLED_PIPELINE_KIND` (`push` | `pull_request` | `manual` | `schedule`), `TANGLED_PIPELINE_SOURCE`, `TANGLED_REPO_KNOT`, `TANGLED_REPO_DID` (owner DID), `TANGLED_REPO_NAME`, `TANGLED_REPO_REPO_DID`, `TANGLED_REPO_DEFAULT_BRANCH`, `TANGLED_REPO_URL`.

Push: `TANGLED_REF` (full ref), `TANGLED_REF_NAME` (short), `TANGLED_REF_TYPE` (`branch`|`tag`), `TANGLED_SHA`, `TANGLED_COMMIT_SHA` (alias).
Pull request: `TANGLED_REF=refs/heads/<sourceBranch>`, `TANGLED_REF_NAME`, `TANGLED_SHA`, `TANGLED_PR_SOURCE_BRANCH`, `TANGLED_PR_TARGET_BRANCH`, `TANGLED_PR_SOURCE_SHA`.
Manual: `TANGLED_SHA`; each manual input → `TANGLED_INPUT_<UPPERCASED KEY>`.
Schedule: ref/SHA vars, `TANGLED_SCHEDULED_AT`.

No `TANGLED_WORKFLOW_NAME`, no run number, no token for the PDS or knot.

---

## 5. Reusable / shared steps, `uses:`, plugins (VERIFIED: none exist)

- Step struct has only `name`/`command`/`environment`; any other key is rejected with `unknown field`.
- BLOG1: "Workflow manifests are intentionally simple. We do not want to include a 'marketplace' of workflows or complex job orchestration. The bulk of the work should be offloaded to a build system, and CI should be used simply for finishing touches."
- No include/import of other workflow files; no cross-repo templates.
- Distribution mechanisms for a "reusable step":
  1. **Nix**: nixery `dependencies: { <flakeref>: [pkg] }`; microvm `dependencies: [github:you/repo#tool]`; `nix run <flakeref>#<attr>` inside a `command`.
  2. **npm**: `npx --yes <pkg>@<ver> ...` after adding `nodejs` (used by tangled's own `deploy-blog.yml` and `site/deploy.yaml`).
  3. **curl | sh / download a binary**.
  Users copy the YAML snippet into their `.tangled/workflows/*.yml`.

---

## 6. Installing and running an npm package in a step

nixery + nodejs (https://tangled.org/tangled.org/site/blob/master/.tangled/workflows/deploy.yaml):
```yaml
dependencies:
  nixpkgs:
    - nodejs
steps:
  - name: deploy
    command: |
      npx --yes wrangler pages deploy --branch master  --project-name tangled-blog ./build/
```
microvm nixos + nodejs (`tangled.org/core` `deploy-blog.yml`): `dependencies: [nodejs]` then `npx --yes wrangler ...`.

Minimal reusable step template:
```yaml
# nixery variant
engine: nixery
dependencies:
  nixpkgs:
    - nodejs_24
steps:
  - name: "Run my tool"
    command: |
      set -euo pipefail
      npx --yes my-package@1.2.3 --arg "$TANGLED_SHA"
    environment:
      NO_COLOR: "1"
```
```yaml
# microvm variant
engine: microvm
image: nixos
dependencies:
  - nodejs_24
steps:
  - name: "Run my tool"
    command: npx --yes my-package@1.2.3 --arg "$TANGLED_SHA"
```
Notes: HOME is writable on both engines so the npx cache works; nixery steps are root, microvm steps are unprivileged; the Netlify example sets `NO_COLOR: "true"` because "Tangled UI renders ANSI colour codes as raw text". Pin the package version; nothing is cached between runs unless `cache:` is configured.

---

## 7. Limits

- Workflow timeout: config default `5m`; **hosted `spindle.tangled.sh` sets 15m** (INFRA). Applies per workflow (all steps + setup).
- Memory (nixery): default 6144 MiB per container.
- Concurrency (hosted): `maxJobCount = 8`, `nixery.maxConcurrentWorkflows = 10`, `queueSize = 100`.
- Pipeline shape: ≤50 workflows per pipeline, workflow name 1 to 40 graphemes.
- Secrets: key ≤50 chars, value ≤200 chars.
- Schedules: min interval 5 min.
- Log size: no cap found (**UNVERIFIED** whether the appview truncates).

---

## 8. Real-world workflow files (verbatim)

### A. `tangled.org/core` `.tangled/workflows/build.yml`
```yaml
when:
  - event: ["push", "pull_request"]
    branch: master

engine: microvm
image: nixos

dependencies:
  - go
  - gcc

environment:
  CGO_ENABLED: 1

steps:
  - name: patch static dir
    command: |
      mkdir -p appview/pages/static; touch appview/pages/static/x

  - name: build appview
    command: |
      go build -o appview.out ./cmd/appview
```

### B. `tangled.org/core` `.tangled/workflows/commit-lint.yml` (shows `clone.depth`, `TANGLED_*` vars)
```yaml
when:
  - event: ["push", "pull_request"]
    branch: master

engine: microvm
image: nixos

dependencies:
  - git
  - bash

clone:
  depth: 100

steps:
  - name: lint commit messages
    command: |
      set -eu
      lint=.tangled/hooks/commit-msg-lint.sh
      chmod +x "$lint"

      kind="${TANGLED_PIPELINE_KIND:-push}"
      head="${TANGLED_COMMIT_SHA:-HEAD}"

      if [ "$kind" = "pull_request" ]; then
        base_branch="${TANGLED_PR_TARGET_BRANCH:-${TANGLED_REPO_DEFAULT_BRANCH:-master}}"
        git fetch --depth=100 origin "$base_branch"
        base="$(git merge-base FETCH_HEAD "$head" || true)"
        if [ -n "$base" ]; then
          exec "$lint" --range "$base" "$head"
        fi
      fi

      exec "$lint" --rev "$head"
```

### C. `tangled.org/core` `.tangled/workflows/deploy-blog.yml` (microvm + nodejs + npx, `paths` filter)
```yaml
when:
  - event: push
    branch: master
    paths:
      - blog/**
      - cmd/blog/**

engine: microvm
image: nixos

dependencies:
  - nodejs

steps:
  - name: build blog
    command: |
      nix build .#blog --impure

  - name: deploy
    command: |
      npx --yes wrangler pages deploy --branch master --project-name tangled-blog ./result
```

### D. `tangled.org/site` `.tangled/workflows/deploy.yaml` (nixery + nodejs + npx)
```yaml
engine: nixery
when:
  - event: ["push", "pull_request"]
    branch: ["master"]

dependencies:
  nixpkgs:
    - nodejs

steps:
  - name: build site
    command: |
      nix develop --command bash -c 'vite build'
  - name: deploy
    command: |
      npx --yes wrangler pages deploy --branch master  --project-name tangled-blog ./build/
```

### E. `philippeserhal.com/example-deploy-to-netlify` `.tangled/workflows/deploy.yml` (nixery, pinned node, secret via env)
```yaml
when:
  - event: ["push"]
    branch: ["main"]
  - event: ["pull_request"]
    branch: ["main"]

engine: "nixery"

dependencies:
  nixpkgs:
    - nodejs_24
    - pnpm
    # pnpm uses `sed` for some reason
    - gnused

steps:
  - name: "Install dependencies"
    command: pnpm install --frozen-lockfile
  - name: "Deploy to Netlify"
    command: |
      commit_msg=$(git show "$TANGLED_SHA" --pretty=%B -s)
      maybe_prod_flag=$( [ "$TANGLED_REF_NAME" = "main" ] && echo "--prod" )
      pnpm exec netlify deploy \
        --site $SITE_ID \
        --message="${commit_msg:-Deploy from Tangled CI}" \
        $maybe_prod_flag
    environment:
      NODE_ENV: "production"
      SITE_ID: "09943d9b-fd90-4057-9372-0adc5a1ddf52"
      # Tangled UI renders ANSI colour codes as raw text
      NO_COLOR: "true"
```
The PR instructs to "generate a Netlify access token and set it as a pipeline secret named 'NETLIFY_AUTH_TOKEN'".

### F. `aly.codes/tg` `.tangled/workflows/website.yml` (tag + manual triggers, secret `WISP_APP_PASSWORD`)
```yaml
when:
  - event: ["push"]
    tag: ["v*"]
  - event: ["manual"]

engine: "nixery"

environment:
  CGO_ENABLED: "0"
  SITE_PATH: "website/dist"

dependencies:
  nixpkgs:
    - nodejs
    - coreutils
    - curl
    - glibc
  nixpkgs/nixpkgs-unstable:
    - go
    - bun

steps:
  - name: "Build site"
    command: |
      cd website
      bun install --frozen-lockfile
      bun run build
  - name: "Deploy to wisp"
    command: |
      curl https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux -o wisp-cli
      chmod +x wisp-cli
      ./wisp-cli "$WISP_HANDLE" --path "$SITE_PATH" --site "$SITE_NAME" --password "$WISP_APP_PASSWORD"
```

---

## 9. Lexicons and self-hosting (summary)

- `sh.tangled.pipeline` (record; deprecated in favour of `sh.tangled.ci.pipeline` but still what the spindle compiles): `workflow{name, engine, runsOn[], clone{skip,depth,submodules,tags}, raw}`. The raw YAML text is embedded, and engines re-parse it.
- `sh.tangled.ci.triggerPipeline` (procedure; `repo` DID, `trigger` manual|pullRequest, optional `workflows[]` names) is the manual-run API.
- `sh.tangled.repo.addSecret` / `removeSecret` / `listSecrets`.
- Self-hosting: `SPINDLE_SERVER_HOSTNAME`, `SPINDLE_SERVER_OWNER`; nixery needs a Docker socket; microvm needs KVM. NixOS module `services.tangled.spindle`.

### Docs-vs-code discrepancies
1. BLOG1 "each step is run in a separate container" → now one container per workflow.
2. BLOG2 `caches:` → renamed `substituters:`.
3. DOCS `clone.submodules` default `false` → code compiles omitted value to `true`.
4. DOCS "`when` is required" → code runs a `when`-less workflow on every event.
5. DOCS "change `nixery` to `microvm` and it works" → `dependencies` shape differs (map vs list).

### Not found / could not verify
- Any first-party `tangled` CLI; any `uses:`/marketplace; any log-size cap; whether secrets are withheld on fork PRs; the exact shell in stock microvm images; `runs_on` matching semantics.
