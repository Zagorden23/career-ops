# Career Ops on Render: Deployment Audit

Scope: `career-ops-hq/career-ops` at upstream `main` (`abefa6db`, v1.39.0, web v0.17.0).
Branch: `render-private-deployment` (cut from upstream `main`; upstream tracking removed). No application code has been changed at the time of writing.

Evidence labels used below:

- **[code]**: read directly in this repository.
- **[render]**: a Render platform behaviour I am stating from knowledge and have **not** verified against this account. Each one is re-checked in `RENDER_DEPLOYMENT.md` or on the first deploy.

Every count, path and route list in this document was re-verified against the working tree on this branch.

## 1. Architecture

Two layers, per `AGENTS.md` and `DATA_CONTRACT.md`:

1. **Core**: 174 root-level `.mjs` scripts (scan, evaluate, tracker merge, PDF, liveness, and so on) plus `modes/`, `templates/`, `batch/`. Plain Node, no server.
2. **Web UI**: `web/`, a Next.js 16.4.1 / React 19.2 app. It is "a view over the user's own files" (`web/AGENTS.md`). It reads markdown, TSV and YAML from a data root and shells out to the core scripts and to AI CLIs.

There is no database. State is plain files: `cv.md`, `config/profile.yml`, `portals.yml`, `data/applications.md`, `data/pipeline.md`, `reports/*.md`, `output/*.pdf`, `jds/`, `interview-prep/`, and `.career-ops-web/` (chat history, run logs, logo cache, CV-studio drafts, PDF scratch).

Process model today (`web/server.mjs`) **[code]**:

- Resolves `next` and runs `next start -H <bind>` through `spawnSync`. The bind is `127.0.0.1` unless `CAREER_OPS_WEB_ALLOWED_HOSTS` names a non-loopback host.
- Pins the Next child's cwd to `web/` itself (`cwd: webDir`, `server.mjs:118`), so the code root resolves to `resolve(cwd, "..")` = the checkout regardless of where the launcher was started from. The launcher need not be started from `web/`, but the Next process must still run with cwd = `web/`.
- Spawns a **detached, unref'd** `generate-pdf.mjs --pdf-server` painter (a Chromium-backed Unix-socket server, 30-minute idle exit, `lib/pdf-server.mjs:14`) before starting Next.
- Does not forward SIGTERM. It relies on the terminal delivering SIGINT to the whole foreground group. Under a process manager that sends SIGTERM to PID 1 only, `spawnSync` blocks, Next is not told to stop, and the detached painter is never reaped.
- Hardcodes `process.cwd()`-relative resolution of the code root (`resolve(cwd, "..")`), so the Next process must run with cwd = `web/`.

## 2. Security model today and why it does not fit a public host

The only access control is network position **[code: `origin-guard.mjs` header, `bind-host.mjs`]**:

- `web/src/proxy.js` (Next 16's middleware replacement) applies `checkRequest()` to every request except `_next/static`, `_next/image` and `favicon.ico` (matcher at `proxy.ts:45`). It checks the `Host` header against loopback plus an opt-in allow-list, and checks `Sec-Fetch-Site` / `Origin` for cross-origin requests. This defends against drive-by CSRF and DNS rebinding. It is **not authentication**.
- The bind address is the real control. The code states this: "Host is chosen by the client".
- Setting `CAREER_OPS_WEB_ALLOWED_HOSTS=career-ops.onrender.com` would make Host-filtering pass for the public name and bind `0.0.0.0`. After that **any visitor on the internet** gets the full API: spawn AI CLIs, write `cv.md`, read the tracker. Therefore the stock app must not be exposed on Render as is, with or without that variable.
- `readJsonObject()` (`web/src/lib/json-body.js`) has no body-size limit. No rate limiting exists. No security headers (CSP, HSTS, X-Frame-Options, nosniff) are set anywhere in `web/next.config.mjs` or `web/src/proxy.js`.
- `proxy.ts` is the sole choke point. Vercel's own guidance is that middleware must not be the only protection for a route: the `x-middleware-subrequest` authorization bypass (CVE-2025-29927, GHSA-f82v-jwr5-mffw) is the precedent, and the vendor postmortem states plainly that middleware should not be the sole method of protecting routes. **[note]** That specific CVE is patched in 12.3.5 / 13.5.9 / 14.2.25 / 15.2.3, and this checkout runs 16.4.1, so the CVE itself does not apply here. The architectural conclusion still stands: authorization should not live only inside the same Next process it protects. See the design in section 8.

## 3. Route inventory

56 API route files (`web/src/app/api/**/route.ts`) and 17 pages **[code]**. All are covered by the same single `proxy.ts` matcher. Grouped by what they actually do:

| Group | Routes | What they do |
|---|---|---|
| Spawn an AI CLI (8) | `run`, `assistant`, `explore/ai`, `cv-studio/[n]/rewrite`, `cv/ingest`, `apply/session`, `apply/drive`, `apply/prefill`, `apply/fill` | Run `claude`, `codex`, `gemini`, ... through `spawnHeadlessCli`. Write-capable workers (`pdf`, `cover`, `evaluate`) get Write/Edit/MultiEdit/NotebookEdit/Bash. |
| Spawn a core script (17) | `scheduler`, `status`, `tracker/delete`, `linkedin-import`, `pdf-ready`, `cv-reveal`, `scheduled-jobs/[id]/run`, `doctor`, `stats`, `patterns`, `upskill`, `company-history`, `quiet-companies`, `keyword-match`, `followups`, `followups/cadence`, `portals/verify` | `spawn(process.execPath, [<root script>, ...])`. Script names are assembled server-side from fixed names, not from request input. |
| Write user files (13) | `cv`, `profile`, `personalization`, `portals`, `memory`, `status`, `inbox/skip`, `explore/add`, `runs/save`, `followups/log`, `followups/cadence`, `followups/override`, `templates/default` | Atomic writes into the data root. `memory` and `personalization` write `modes/_profile.md` under the **data** root; `cv` writes `cv.md`; `explore/add` appends to `data/pipeline.md` + `data/scan-history.tsv` through the core's canonical writers. |
| Read / serve user files | `pipeline` (GET only), `usage`, `version`, `cv-pdf`, `cover-pdf`, `documents`, `report/shape`, `logo` | Serve generated PDFs, reports or cached files from the data root, with containment checks (`isRegularContainedFile`, `pdf-index`). `usage` reads `~/.claude/projects`. |
| Outbound fetch | `logo` (Google favicons), `apply/*` (via `web/src/lib/apply/greenhouse.js` → `boards-api.greenhouse.io`), `explore` + `portals/verify` (core scanners → public ATS hosts) | Public ATS and logo hosts only. |

Routes not named in the first draft of this table, for completeness: `apply/close`, `assistant/chats`, `clis`, `cv-studio/[n]`, `explore/add`, `followups/seed`, `scheduled-jobs`, `scheduled-jobs/[id]`, `templates`, `templates/preview`, `whats-new`.

Because the protection must cover all of these, authentication is applied at a layer in front of the whole app, not per route.

## 4. Feature-by-feature cloud feasibility

| Feature | Needs | On Render |
|---|---|---|
| Dashboard, pipeline, tracker, analytics, config, CV editor, reports viewer | Files only | **Works**, given persistent storage and auth. |
| Portal scan (`scan.mjs`, Greenhouse/Ashby/Lever APIs) | Outbound HTTPS, child process | **Works**. Zero LLM cost. CPU is modest. |
| Tracker merge, status, follow-ups, stats, patterns, upskill, keyword-match | Node scripts | **Works**. |
| Job evaluation, CV tailoring, cover letter, assistant, interview prep, Explore AI, CV rewrite, CV ingest | **An installed AI CLI** (`claude`, `codex`, `gemini`, ...). `clis.ts` only knows CLIs found on disk. No HTTP-API provider path exists in `web/`. | **Does not work as shipped.** No CLI on Render. Details and options in section 6. |
| PDF generation (CV, cover letter) | Chromium via `playwright` plus the PDF painter | **Unverified.** Needs a browser binary and its system libraries. The build flag `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` suppresses the browser install (see section 9). See section 7. |
| Liveness check browser fallback, `browser-extract`, `scan-interamt`, `scan-dayforce` | Chromium | Same as PDF. API-only liveness paths work without it. |
| **Apply assistant** (`apply/*`) | **Headed-but-off-screen Chrome plus a human handoff window** (`apply/session/route.ts:11`) | **Cannot work.** No display, and the handoff is a window on the user's own desktop. Must be marked unsupported. |
| Scheduled scans | `scheduler` route and `web/scripts/scheduled-jobs-runner.mjs`; `web/scripts/install-scan-schedule.sh` installs a **launchd agent (macOS) or a crontab line (Linux), every 15 minutes** | **Cannot work as designed.** No user crontab or launchd on a Render web service; a detached runner dies with the instance. Replaceable by a Render Cron Job, which is separate infrastructure (see section 9). |
| Claude usage panel (`/api/usage`) | Reads `~/.claude/projects` | Shows nothing. Harmless. |
| LaTeX CV (`generate-latex.mjs`) | `tectonic`/`latexmk` binary | Unavailable. The upstream Dockerfile installs TeX Live. Out of scope. |
| Go TUI `dashboard/` | Go toolchain, a terminal | Not part of the web service. |
| Auto-updater (`update-system.mjs`) | `git` and a writable checkout | Must be a no-op. Render redeploys from Git. |

## 5. Local filesystem and data-root semantics

Verified resolution order **[code: `path-resolver.mjs`, `web/src/lib/core/data-root.mjs`, `code-root.mjs`]**:

- **Data root**: `CAREER_OPS_ROOT` → `CAREER_OPS_DATA_DIR` → `.career-ops-data` marker file → checkout itself. A relative value resolves against the **code root**, not cwd. The web copy mirrors the core rule in `data-root.mjs` and resolves against `resolveCodeRoot(process.cwd(), process.env)`.
- **Code root** (scripts, `modes/`, `templates/`): `CAREER_OPS_CODE_ROOT`, else the parent of `web/` (cwd = `web/`).
- **Profile**: `CAREER_OPS_PROFILE` overrides only `config/profile.yml`. It is optional.
- **Tracker**: `CAREER_OPS_TRACKER` overrides; otherwise `{data root}/data/applications.md` (reads fall back to `{data root}/applications.md`).

Consequences for Render:

- Setting `CAREER_OPS_ROOT=/var/data/career-ops` keeps personal files off the checkout. `CAREER_OPS_CODE_ROOT` is not needed on Render, because the app runs from the checkout (`.../src/web`). It is safe to set explicitly.
- The web app writes **only** under the data root, **except** these paths outside it **[code]**: `os.tmpdir()` scratch for CV ingest (`career-ops-cv-*`), Codex runs (`career-ops-codex-*`), template previews (`template-preview-*`), explore YAML (`career-ops-explore-*.yml`), Claude usage scans (`career-ops-usage-*`), and the PDF painter socket in `tmpdir()/co-pdf-<uid>` (all ephemeral by design; fine).
- `.career-ops-web/` is under the data root, so chats, run logs and drafts persist once the data root is on the disk.
- **There is no mounted-and-writable check.** If `/var/data` were missing, the app would create `/var/data/career-ops` as an ordinary directory on the **ephemeral** filesystem (when permitted) and silently lose everything on redeploy. The launcher must therefore verify the mount before starting.
- The upstream repo's `.gitignore` already excludes every personal path (`cv.md`, `data/*`, `reports/*`, `output/*`, `jds/*`, `portals.yml`, `config/profile.yml`, `.env`, `*.bak*`, `*.tmp*`, `*.db`). Verified by reading it (lines 2, 24, 35, 47, 91, 118, 132, 147, 172, 181, 194).
- **Local checkout has no user data present** (`cv.md`, `config/profile.yml`, `portals.yml` are absent; `data/` holds only `.gitkeep` files), so there is no risk of staging personal data from this working tree.

## 6. AI integration audit

How AI runs today **[code: `clis.ts`, `spawn-cli.mjs`, `cli-fencing.mjs`, `claude-invocation.mjs`, `run/route.ts`]**:

- The client sends `cliId`. The server resolves it **only against the fixed `KNOWN` table** (claude, codex, gemini, opencode, pi, copilot, qwen, antigravity, grok, hermes, omp). It never executes a client-supplied binary name or argument vector. This is good: no command injection via `cliId`.
- Prompts are passed as a single argv element to `spawn` (no shell). `fix-portal` input is additionally checked with `isShellSafeCompanyName` because the agent itself runs a shell command containing it.
- Permissions are fenced per CLI (`WRITE_CAPABLE_TOOLS` deny lists for Claude, sandbox modes for Codex). CLIs not in the fencer table run unfenced; `hermes` is refused for write-capable workers.
- Credentials are whatever the CLI itself uses (its own login or its own API-key environment variable). The web app never sees or forwards an API key: there is no API-key env var read anywhere under `web/src`, and `config-form.tsx` mentions the key only as text it deliberately does not persist.

Consequences:

1. **No CLI is present on Render and no HTTP-provider abstraction exists in `web/`.** The root has standalone API scripts (`gemini-eval.mjs`, `openai-eval.mjs`, `openrouter-runner.mjs`, `ollama-eval.mjs`, `openai-tailor.mjs`) that read `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`. They are **not wired into the web routes** — the only reference to them anywhere under `web/src` is a comment. Reusing them from `/api/run` would be new web feature code, not configuration.
2. Hermes Agent on the user's laptop is irrelevant to Render. Not used.
3. **Lowest-risk option that reuses the existing abstraction:** install one supported CLI as an npm dependency at build time (for example `@anthropic-ai/claude-code`, `@openai/codex` or `@google/gemini-cli`), put its `node_modules/.bin` on `PATH`, and supply its API key through a Render env var. `findBin()` scans `PATH` (`clis.ts:126`), so detection works unchanged, and the existing fencing and permission code keeps applying. Costs and risks: it adds a large dependency; the CLI's config/HOME must point at a writable location; headless behaviour of each CLI on Linux with an API key is **untested here**; and the CLI runs with the app's filesystem rights (it can read the whole data root and, depending on fencing, write it).
4. **Alternative:** a new HTTP-API execution path for the read-only/JSON-envelope workers. Larger change to upstream code, harder to keep merge-compatible, and a violation of `web/AGENTS.md` rule 1 ("orchestrate the core; never reimplement it") unless done very narrowly.
5. Resource limits: `maxDuration` is declared on **11** routes (120 s to 800 s; `run` is 800 s) but Next's `maxDuration` is a platform hint, not enforced by `next start`. `run/route.ts` does carry its own kill timers (`killMsForKind`). A global concurrency cap on spawned AI processes does not exist and would be added in the launcher or gateway.

No AI action will be claimed to work until it has actually been executed on the deployed instance.

## 7. Browser automation and PDF

- `playwright` 1.64.1 (root dependency) and `playwright-core` ^1.61.0 (web). `generate-pdf.mjs` launches Chromium through `lib/browser-launch.mjs` (`resolveBrowserExecutable`, line 149) and calls `chromium.launch()` at `generate-pdf.mjs:2421`.
- `server.mjs` starts the painter eagerly, but the painter launches Chromium **lazily per render**, so no browser is held at startup. The painter process itself is cheap, but it is a second long-lived process that the Render launcher must own and reap.
- **The root `package.json` has a `postinstall` that installs Chromium**: unless `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` is set to `1` (or any value other than empty/`0`/`false`), it runs `npx playwright install chromium`; the `playwright` package's own install script also downloads browsers unless that variable is set. The flag is therefore **not** a no-op — it is the switch that decides whether Chromium exists on the instance.
- **[render]** The native Node runtime image is not guaranteed to include Chromium's shared libraries, and the download itself is a build-time step whose result must reach the runtime image. Whether `npx playwright install chromium` with `PLAYWRIGHT_BROWSERS_PATH` pointing **inside the project directory** (so the files are part of the build output that becomes the runtime image) produces a working browser **has to be tested on a real Render build**. I cannot test it locally (this machine is Windows). If the OS libraries are missing, `npx playwright install --with-deps chromium` needs system-package privileges during the build — **[render]** unverified whether the Render build user has them.
- A Chromium render needs several hundred MB of RAM. **[render]** The 512 MB Starter instance is likely too small for a PDF render alongside Next; the 2 GB tier is the realistic floor if PDFs matter. I will not claim otherwise without measurement.
- The Docker route (Playwright base image) is how upstream solved this. It is excluded by your constraints.

## 8. Required modifications (planned, not yet done)

All new code is JavaScript (`.mjs` / `.js`, JSX if any). No `.ts` / `.tsx` is added.

**A. Deployment launcher** (`deploy/render-start.mjs`), replacing `web/server.mjs` as the Render start command (the upstream file stays untouched):

1. Validate environment: refuse to start in production without auth credentials, a session secret, and a data directory.
2. Storage check: `CAREER_OPS_ROOT` must exist, be a **mount point or at least a distinct filesystem from the build directory**, and pass a write-and-read probe; otherwise exit non-zero. Never create it.
3. Start Next (`next start`) bound to `127.0.0.1` on an internal port, with cwd pinned to `web/` exactly as `server.mjs` does today.
4. Start the auth gateway on `0.0.0.0:$PORT`.
5. Start the PDF painter only if browser support is enabled, as a non-detached child that the launcher owns.
6. Forward SIGTERM / SIGINT, drain, then kill the children; exit with a distinct code if any child dies.

**B. Auth gateway** (`deploy/gateway.mjs`): a small Node `http` reverse proxy using only built-ins. A standalone gateway has an advantage over `proxy.ts`-only auth: it sits in front of Next, so a Next routing or middleware bypass cannot reach an unauthenticated route.

- Credentials from `CAREER_OPS_AUTH_USER` and `CAREER_OPS_AUTH_PASSWORD_HASH` (scrypt hash generated by a helper script; a plaintext password is never stored, in the repo or in an env var). A random-token-based second factor is out of scope unless you want it.
- Sessions: 256-bit random IDs from `crypto.randomBytes`, server-side store in a JSON file on the persistent disk (outside the data root, so it is never served by any app route and never part of a data backup by accident), absolute and idle expiry, rotation on login, deleted on logout. Cookie: `HttpOnly; Secure; SameSite=Lax; Path=/` with the `__Host-` prefix.
- CSRF: `SameSite` plus a per-session token that the login page and gateway-injected header require for state-changing methods. The existing `origin-guard` keeps running inside Next as a second layer: the gateway forwards the real `Host` / `Origin` / `Sec-Fetch-Site`, and `CAREER_OPS_WEB_ALLOWED_HOSTS` is set to the public hostname. Nothing in `origin-guard.mjs` is weakened or modified.
- Host validation: the gateway answers only for the configured public hostname (`RENDER_EXTERNAL_HOSTNAME`, which Render sets, or an explicit override) and rejects other `Host` values. `X-Forwarded-*` are trusted only for `X-Forwarded-Proto`, read to decide the `Secure` cookie and HTTPS redirects, and only because the sole network path in is Render's proxy.
- Login rate limiting (per IP and global, exponential back-off), constant-time comparison, generic error messages.
- Security headers on every response: HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, a restrictive `Permissions-Policy`, and a CSP compatible with the Next output (needs testing; Next uses inline scripts).
- Request size limit on bodies; header-size limit; upstream timeouts; no stack traces; streaming responses (`/api/run` is NDJSON) are piped without buffering.
- Public, unauthenticated paths: `/login`, `/logout` (POST), `/healthz`. Everything else, including `_next/static`, requires a session. This costs a little because the login page cannot use Next's own assets, so the login page is a self-contained HTML page served by the gateway.
- `/healthz` returns only `{"status":"ok"}`. It reveals nothing else.

**C. Capability switches** so unsupported features are marked rather than silently failing. This is the part that touches existing UI/route code and is therefore the riskiest for upstream mergeability. The minimal approach is for the gateway to answer `501` with a clear JSON message for `apply/*` and `scheduler` POST when `CAREER_OPS_CLOUD=1`, so no upstream file needs editing. UI hiding is optional and can be a separate, reviewable change.

**D. Build/start configuration** (`render.yaml`, docs). See section 9.

## 9. Deployment requirements

- **Service type**: Web Service, native Node runtime, no Docker.
- **Persistent disk [render]**: only available on **paid** instance types; it ties the service to a single instance and disables zero-downtime deploys. A free web service has no disk and spins down when idle. So a paid plan is a hard requirement for "data survives redeploys". The Starter plan and a small disk are the minimum; the Standard (2 GB RAM) tier is what I would need for PDF generation. I will not state prices; check the Render pricing page.
- **Build command: the command in the brief will fail as written, in three places.**
  - `npm ci` at the repo root needs `package-lock.json`, but root `.gitignore` ignores it (line 258 `package-lock.json`, line 259 `!web/package-lock.json`). **[code: `git ls-files` shows only `web/package-lock.json`.]** The upstream `Dockerfile` uses `npm install` for this reason (line 44). Options: use `npm install` at the root (non-reproducible), or commit a root lockfile and un-ignore it (small `.gitignore` change). I prefer committing a lockfile; decision below.
  - **[render]** Render's Node environment defaults `NODE_ENV=production`, under which `npm ci` omits `devDependencies`. `web` needs `typescript`, `tailwindcss`, `@tailwindcss/postcss` and `postcss` to build. The web install must use `--include=dev` (or `NPM_CONFIG_PRODUCTION=false`).
  - `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` does **not** just signal "no browser" — it is what makes the root `postinstall` skip `npx playwright install chromium` (and makes the `playwright` package skip its own download). With it set, the instance has no Chromium and PDF generation is gone. To attempt PDFs, leave the flag unset and point `PLAYWRIGHT_BROWSERS_PATH` at a directory inside the project so the browser survives from build to runtime; that path must be verified on a real Render build.
- **Node version**: both `package.json` files require `^22.13.0 || >=23.4.0`. Pin `NODE_VERSION` explicitly on Render.
- **Start command**: `node deploy/render-start.mjs` (section 8A), **not** `web/server.mjs` and not `npm start` (the root package has no `start` script; `web`'s `npm start` is `node server.mjs start`, the local-first launcher this task replaces).
- **Health check path**: `/healthz`.
- **Environment variables** (names only; values live in the Render dashboard): `NODE_VERSION`, `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`, `CAREER_OPS_ROOT=/var/data/career-ops`, `CAREER_OPS_CODE_ROOT` (optional), `CAREER_OPS_WEB_ALLOWED_HOSTS=<public hostname>`, `CAREER_OPS_AUTH_USER`, `CAREER_OPS_AUTH_PASSWORD_HASH`, `CAREER_OPS_SESSION_SECRET`, `CAREER_OPS_SESSION_DIR`, `CAREER_OPS_CLOUD=1`, plus the AI CLI's own API-key variable if section 6 option 3 is chosen.
- **Scheduled scanning** needs a Render Cron Job, which is separate paid infrastructure **and** cannot share the web service's disk **[render]** (disks attach to one service). It is therefore not a drop-in replacement. Recommended to leave it unsupported at first, or run the scan on demand from the dashboard.
- **Hostname**: `career-ops.onrender.com` is only available if nobody else holds that service name. Render appends a suffix otherwise. The launcher reads the actual hostname from `RENDER_EXTERNAL_HOSTNAME` rather than hardcoding it.

## 10. Risks (ranked)

1. **Exposing the stock app = unauthenticated remote code execution surface** (AI CLI spawn with Bash, file writes). Mitigated only by the gateway plus the Next-internal bind. **Critical.**
2. **Silent data loss on ephemeral disk** if the mount is absent. Mitigated by a fail-closed storage check. **High.**
3. **A single shared secret protects everything**: it holds your CV, salary targets and application history. Strong password, rate limiting, and rotation procedure are mandatory. **High.**
4. **AI features unavailable** unless a CLI plus key is installed; with one installed, the CLI can read the entire data root. **High (functional), Medium (security).**
5. **PDF generation unproven** on Render's native image; memory-heavy; the browser must survive the build→runtime handoff. **Medium.**
6. **Upstream drift**: this repo moves fast. The branch is currently exactly at upstream `main` (`abefa6db`, verified against `origin/main` and the GitHub API), so there is no lag today, but upstream moves weekly. Keeping all additions under `deploy/` plus docs, and touching no upstream source file, keeps `git merge upstream/main` conflict-free. **Medium.**
7. **Single instance, no HA**; disk snapshots are the only backup unless you add exports. **Medium.**
8. **CSP vs. Next inline scripts** could break the UI if the policy is too strict. **Low** (testable).

## 11. Features that will remain unavailable without additional infrastructure

- AI evaluation / tailoring / assistant / interview prep: until a CLI + API key is installed and verified.
- PDF generation: until a Chromium build is verified on Render.
- Apply assistant (headed browser plus human handoff): not possible on a headless server.
- Scheduled recurring scans: not possible in-service; needs a separate Cron Job without disk access.
- LaTeX CV path, Go TUI, self-updater: not applicable.

## 12. Decisions needed before implementation

1. **Plan**: confirm you accept a paid Render plan (persistent disk is required for your own success criteria).
2. **AI**: option 3 (install one CLI via npm + API key env var) or ship the dashboard with AI actions clearly marked unavailable for now? If option 3, which CLI/provider and key?
3. **PDF**: attempt Chromium install at build (needs a bigger instance and a real test), or leave PDF unsupported initially?
4. **Root lockfile**: commit `package-lock.json` (small `.gitignore` edit) or use `npm install`?
5. **Fork**: `Zagorden23/career-ops` does not exist yet (GitHub API returns 404, re-verified). `gh` is authenticated as `Zagorden23` with `repo` scope, so I can create the fork with `gh repo fork career-ops-hq/career-ops --clone=false` and add it as a remote, if you approve.

## 13. Phase 2 addendum — TypeScript → JavaScript migration (scope and impact)

Added after the audit review. The brief now requires the whole web application to be converted to `.js` / `.jsx` before any Render work.

**Scope measured on this branch [code]:**

- 251 project-owned TypeScript files: 110 `.ts` + 141 `.tsx`, 31,618 lines total.
- 250 of them live under `web/src/`. The one outside is `web/next-env.d.ts`, which Next.js regenerates on every build and which is auto-generated, not project-authored.
- There are **no** `.ts`/`.tsx` files at the repo root; the 174 core `.mjs` scripts, `modes/`, `templates/` and `batch/` are already plain JavaScript and are untouched by this migration.
- `web/tests/` is already `.mjs` (the test runner uses `node --experimental-strip-types --test "tests/**/*.test.mjs"`), so the test suite needs no file conversion — but it may import `.ts` modules, which must be checked.

**What the migration changes about the deployment plan:**

1. `tsconfig.json` becomes `jsconfig.json` (path alias `@/*` must be preserved) and `typescript` / `@types/*` leave `devDependencies` once nothing imports them. `web/next.config.mjs` needs no change beyond that.
2. `npm run typecheck` (`tsc --noEmit`) disappears. That is a **loss of compile-time checking**, and the replacement is runtime validation at the boundaries: API request bodies, query strings, YAML/JSON parsed from disk, and every external payload. The existing `readJsonObject()` returns `null` for non-objects, which is the right pattern to extend rather than replace.
3. `next build` no longer type-checks, so a broken import or a bad JSX transform surfaces at runtime, not at build time. The production build plus the full test suite becomes the only safety net — which makes running them mandatory, not optional.
4. Next.js 16 supports `.jsx` in the App Router, so `page.tsx` → `page.jsx`, `layout.tsx` → `layout.jsx` and `route.ts` → `route.js` are supported conversions. **`proxy.ts` → `proxy.js` is the sensitive one**: Next's middleware/proxy contract is filename-driven, and the file must keep its exact name (`proxy.js` in `src/`) or the guard silently stops running — which would remove the only access control the stock app has.
5. `next-env.d.ts` is regenerated by Next on build and is not project-authored; it is retained (and gitignored or kept) rather than "converted".

**Risks this adds (ranked alongside section 10):**

1. **A silent proxy/middleware rename disables the request guard.** If `proxy.ts` does not become exactly `proxy.js`, Next stops applying it and the app answers on loopback as if unguarded. Mitigation: assert the guard runs — a test that hits a non-loopback `Host` and expects a refusal, plus a build-output check that the proxy is registered. **Critical.**
2. **Loss of compile-time type checking.** Generic and type-only constructs must be rewritten by hand, not mechanically stripped. Mitigation: migrate shared utilities and API routes first, run `tsc --noEmit` on the *original* tree as a baseline, and keep the type-check step available during the migration even if it is dropped afterwards. **High.**
3. **JSX transform drift** (`react-jsx` automatic runtime, `use client` boundaries, server vs client component split). A moved or dropped `"use client"` changes behaviour, not just types. Mitigation: compare the built route manifest and page list before and after. **High.**
4. **Runtime-only failures in code paths no test covers.** Mitigation: runtime validation at every external boundary, and the browser QA pass the brief already requires. **Medium.**
5. **Upstream mergeability drops sharply.** A repository-wide rename cannot be merged with upstream cleanly. Mitigation: the migration lives on its own branch, isolated from the deployment branch, and the deployment branch is cut from upstream `main` after the migration is proven — or the deployment work is kept on a branch that does not depend on the migration if the two must ship independently. **Medium.**

**Execution order (per the addendum):** audit review → migration branch + rollback point → inventory → shared utilities and libraries → API routes and components → config and dependencies → verification per group → full production build + regression test → `JS_MIGRATION_REPORT.md` → only then the Render deployment.

## 14. Phase 3: Production Render Deployment Implementation

Implemented on branch `feature/render-private-deployment`:

### Architecture Landed
- **Auth & Security Gateway** (`deploy/gateway.mjs`): Independent reverse proxy binding to `0.0.0.0:$PORT`.
  - Next.js binds strictly to `127.0.0.1:<internal_port>`. No direct unauthenticated access to Next.js is possible.
  - Public `/healthz` endpoint returning `{ "status": "ok" }`.
  - Auth pages (`deploy/auth-pages.mjs`), self-contained with dark-mode styling matching Career Ops (sign in, sign up, email/phone OTP verification, password reset, and account management).
  - Password hashing via `crypto.scrypt` with 16-byte random salt and constant-time verification (`deploy/hash-password.mjs`).
  - Login rate limiter with sliding window, progressive delays, and 15-minute lockout (`deploy/rate-limiter.mjs`).
  - Durable session and user storage in `/var/data/career-ops/.sessions/` with atomic writes (`deploy/auth-store.mjs`, `deploy/user-store.mjs`).
  - Strict security headers on every response: CSP, HSTS, X-Frame-Options: DENY, nosniff, Referrer-Policy, Permissions-Policy (`deploy/security-headers.mjs`).
  - CSRF protection: SameSite cookies, Sec-Fetch-Site checking, Origin matching, one-time form tokens.
  - Cloud-mode capability gate: `apply/*` routes intercepted and return HTTP 501 in cloud mode.
- **Production Supervisor** (`deploy/render-start.mjs`):
  - Validates environment variables and credentials before boot.
  - Persistent storage check (`deploy/storage-check.mjs`): verifies mount at `/var/data/career-ops`, runs write-read probe, seeds standard directories (`data/`, `config/`, `modes/`, `reports/`, `output/`, `.sessions/`), and fails closed if storage is unavailable.
  - Spawns and supervises Next.js on internal loopback port (with per-account workspace isolation via `deploy/workspace-manager.mjs`).
  - Traps `SIGTERM` and `SIGINT`, closes gateway, terminates child processes, and reaps all processes within 8 seconds.
- **Deployment Configuration & Documentation**:
  - `render.yaml`: Blueprint with Web service, 10 GB persistent disk, build & start commands, health check.
  - `.env.render.example`: Complete environment variable template.
  - `RENDER_DEPLOYMENT.md`: Step-by-step production deployment manual.
  - `SECURITY_AUDIT.md`: Complete security specification and audit report.

### Automated Test Verification
- `tests/deploy/accounts.test.mjs`: Multi-user accounts, email/password sign-up & sign-in, email OTP, phone SMS OTP, Google OAuth with PKCE, password reset, account deletion, and per-user workspace isolation (PASS).
- `tests/deploy/deployment-security.test.mjs`: 6 test suites covering password hashing, session lifecycle, rate limiting, security headers, gateway perimeter, CSRF, and storage probing (PASS).
- `tests/deploy/r2-storage.test.mjs`: Cloudflare R2 storage client, hydration, background sync, and workspace prefix deletion (PASS).
- `tests/deploy/render-start.test.mjs`: Full supervisor lifecycle, healthcheck polling, and graceful shutdown on SIGTERM (PASS).

