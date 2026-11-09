# web/ TypeScript → JavaScript migration report

Branch `feature/js-migration`, rollback point `backup/pre-js-migration` (`abefa6db`,
career-ops v1.39.0, web v0.17.0). Nothing is committed. The migration is staged
(`git add -A web`); the Phase 2A edits are unstaged on top of it.

Baseline for every comparison: `D:/Career-Ops-baseline`, a detached worktree of
`backup/pre-js-migration`. It has its own `web/node_modules` (`npm ci`, same
Next 16.4.1 and playwright-core 1.62.0) and its own production build. Root
`node_modules` is a junction into the main checkout.

## Scope

| | Before | After |
|---|---|---|
| `.ts` in `web/src` | 108 (+1 `.d.ts`) | 0 |
| `.tsx` in `web/src` | 141 | 0 |
| `.js` / `.jsx` produced | — | 108 / 141 |
| `tsconfig.json` | yes | replaced by `jsconfig.json` (keeps the `@/*` alias) |

**Remaining TypeScript files: none.** `git ls-files` lists no `.ts`, `.tsx`
or `.d.ts`, and a filesystem scan (excluding `node_modules` and `.next`) finds none.

Intentional exceptions:
- `lib/pipeline-sankey.d.ts`: declaration-only, removed with no runtime counterpart.
- `lib/apply/issue.js`: JSDoc `@typedef`s only. Its TS original was type-only.
- Three `// eslint-disable-next-line no-var` comments inside the erased
  `declare global` block of `lib/apply/session.ts` have nothing left to annotate.

Framework contract basenames are kept: `page`, `layout`, `loading`, `error`,
`not-found`, `route` and `proxy.js`.

## Config, dependencies, CI, docs

- `web/package.json`:
  - `"type": "module"`.
  - `typecheck` script removed.
  - `--experimental-strip-types` dropped from the `test` script.
  - `typescript` and `@types/{js-yaml,node,react,react-dom}` removed; lockfile regenerated.
- `next.config.mjs` has no TypeScript options.
- `.github/workflows/web-ci.yml`: the `tsc --noEmit` step is removed; job names are unchanged.
- `web/README.md`, `web/AGENTS.md` and `docs/CUSTOMIZATION.md` are updated.
- Comment-only path updates in `followup-cadence.mjs`, `gemini-eval.mjs`,
  seven `web/src/lib/*.mjs` modules and `lib/apply/planner.js`.
- `web/tests/helpers/web-ts-alias-loader.mjs` resolves `.js`/`.jsx`/`.mjs`.
- Root suites whose filters only knew `.ts`/`.tsx` now include `.js`/`.jsx`:
  `web-core-argv-contract`, `web-profile-path-parity`, `headless-permission-flags`,
  `js-yaml-import-form`, `source-no-nul-bytes`.
- `test-all.mjs` contract freezes point at the `.js` paths.

## Phase 2A cleanup

### Standalone semicolons

All 41 lone `;` lines were classified with Next's bundled Babel parser
(`next/dist/compiled/babel/parser`; nothing was installed).
- 40 were `EmptyStatement`s in a statement list, and were deleted.
- 1 terminated a declaration (`hero-glow.jsx`: `const w = window` / `;`), and was
  moved onto the same line.
- All 20 edited files were re-parsed: the AST is identical to the pre-edit AST.

### Documentation tsc dropped

`tsc` deletes comments attached to erased type declarations. Comparing comments
against the originals found 90 missing in 24 files, plus 18 in `explore.js`.

Examples:
- the ACL headers of `core/states.js` and `core/portals.js`
- the CLI contract in `clis.js`
- field docs of `Job`, `ApplyField`, `DiscoveredOffer`, `ActionCtx` and `CliSpec`

How they were restored:
- 30 types got back JSDoc `@typedef`/`@property` blocks, placed before the code
  that followed them in the original.
- Inline prop-type comments (five components and `runPlanner`) became comments
  or `@param`s.

What is left: the three `eslint-disable` lines above.

### Semantic equivalence proof

Each original `.ts`/`.tsx` was stripped of types with Babel's TypeScript preset
(bundled in Next). Its AST was then compared with the migrated file, ignoring
locations, comments, parentheses, empty statements and the import extensions
the migration added.

**248 of 249 files are identical after all cleanup.** The remaining one is
`issue.js`, a type-only module: Babel's output there is only an `export {}` marker.

## Migration integrity

| Check | Result |
|---|---|
| Project-owned `.ts`/`.tsx` | 0 |
| Static imports/exports in `web/src` | 1494 resolved (relative + `@/`), 0 unresolved, 0 aimed at `.ts` |
| Bare-package imports | all declared or resolvable |
| Dynamic imports | 24 total. The 21 computed ones all load root core scripts (`pathToFileURL(rootScript(...))`, `webpackIgnore`). All 19 `rootScript()` targets and all `path.join(codeRoot, "*.mjs")` targets exist |
| Server/client boundaries | `"use client"`/`"use server"` presence matches the original in every file and is the first statement. No hook-using file lacks `"use client"` |
| Stale references to deleted TS files | 0 (one upstream comment cites `src/app/icon.tsx`, which never existed) |
| Generated CSS, current vs baseline build | identical apart from next/font class hashes (derived from `fonts.ts` → `fonts.js`) |
| `next build` | pass, `ƒ Proxy (Middleware)`, 75 routes, same 3 Turbopack warnings as the baseline |

## Browser test suites

Command: `cd web && node tests/browser-suites.mjs` (= `npm run test:browser`).
It runs all 36 `tests/lib/*.browser.test.mjs` suites, each against its own
production server and a fresh data root.
- The suites launch Google Chrome (`channel: "chrome"`, installed at
  `C:\Program Files\Google\Chrome`), not a Playwright download.
- The root's Playwright 1.64.1 needed `chromium_headless_shell-1248`, which was
  missing. It was installed into the configured D: cache
  (`PLAYWRIGHT_BROWSERS_PATH=D:\BrowserCache\Playwright`,
  `npx playwright install chromium-headless-shell`). No dependency changed.

| Tree | Result | Retries |
|---|---|---|
| Baseline | 36/36 suites, 91 tests passed, 0 skipped | `back-link-scroll` passed on retry |
| Migrated | 36/36 suites, 91 tests passed, 0 skipped | `cv-studio-preview` passed on retry. `apply-field-accessibility` passed on retry: on the first try its server exited before answering (0xC000013A) |

The suites cover:
- navigation (`mobile-nav-drawer`, `command-palette`, `back-link-scroll`, `skip-link`, `pipeline-return`)
- pipeline/tracker writes (`pipeline-inline-status`, `inbox-undo`, `tracker-keys`)
- CV Studio and CV upload
- accessibility
- the assistant console
- worker gates

All of them treat page errors as failures.

### `cv-studio-preview` (flaky in both trees)

It fails `assert.equal(fit.outerScroll, false)` at line 67.

Cause:
- The preview starts at `scale(0.7)`.
- It sometimes keeps the width the `ResizeObserver` reported before layout
  settled: 571 px vs a 485 px box.
- The iframe then overflows horizontally.

Measured pass rates for single-suite runs:

| Tree | Passed |
|---|---|
| Baseline | 1 of 4 |
| Migrated | 0 of 6, plus 1 of 2 direct runs |

Both full runs passed on retry. The component is AST-identical to the original,
and the CSS is identical. This is a pre-existing race in the component, not a
migration regression. It is unfixed (out of scope).

### Runner defect on Windows (pre-existing, unchanged)

- `stop()` sends `process.kill(-pid)`, a POSIX process-group signal, so each
  suite's server outlives the suite.
- After a fully green run, the runner never exits.
- The runs above used a wrapper that waits for the runner's summary line and
  then kills the leaked servers.
- CI runs these suites on Linux.

## Root suite: the 16 failures

Command: `node test-all.mjs`. Last full run: 21192 pass / 16 fail. The baseline
tree, same day: 21194 / 14.

Each failing suite was run alone in both trees (`node --test tests/<suite>.test.mjs`):

| # | Failure | Class | Evidence |
|---|---|---|---|
| 1 | `live archive: script exited non-zero` | environment | headless shell 1248 missing; now installed |
| 2–3 | `zh-minimal-template`, `zh-minimal-theme` | environment | same cause; now pass alone in both trees |
| 4 | inline gate "web pdf write-scope unit suites" | pre-existing + environment | it runs every web suite and inherits `server-launcher.test.mjs` "starts the PDF painter…", which fails identically in both trees (`rmSync` EPERM: Windows cannot delete a live child's cwd) |
| 5–7 | `batch-dealbreaker-skip` (3 cases) | pre-existing, platform | same 3 failures in both trees (`'failed'` vs `'skipped'`), via `batch/batch-runner.sh` under Git Bash |
| 8–12 | `batch-runner-dry-run-without-cli` + 4 sub-checks | pre-existing, environment | `spawnSync bash ENOENT` in both trees: no `bash` on the PATH that node children see |
| 13 | `docs-only-change` | pre-existing, environment | 13/5 in both trees: Git for Windows turns `file:///C:/…` into `/C:/…` and cannot clone it |
| 14 | `skill-standalone-install` | pre-existing, environment | 3/1 in both trees: a git symlink is checked out as a plain file (`core.symlinks=false`) |
| 15 | `reply-watch` | concurrency flake | 7/7 alone in both trees |
| 16 | `set-status-archives-jd` | concurrency + Windows | 14/14 alone in both trees; one isolated run reproduced 13/1 (`rmSync` EPERM while a detached archive child held the temp dir), same class as #4 |

**Migration regressions remaining: none.** The previous phase found and fixed
the ones the migration caused:
- the spawner scan
- the parity sweep
- the `score` column freeze
- the js-yaml sweep, which needed the git index

Upstream `test.yml` (ubuntu, macos and windows matrix) is green on recent `main`
(`gh run list --workflow test.yml`). That points at this host's environment.

## Final verification (this phase)

| Step | Command | Result |
|---|---|---|
| Root lint | `npm run lint` | pass |
| Web unit/integration | `cd web && npm test` | 2574 tests: 2491 pass, 1 fail, 82 skipped. Identical to the baseline; the failure is the Windows EPERM test (#4) |
| Browser suites | `node tests/browser-suites.mjs` | 36/36, see above |
| Production build | `npx next build` | pass |
| Production smoke, migrated build, `pipeline-status` fixture | temporary script, since removed | see below |
| Root suite | `node test-all.mjs` | **not rerun after the Phase 2A edits** (stopped at the user's request). The last run is classified above |

Production smoke results:
- **Pages:** all 17 return 200. No error boundary, no `pageerror`. The only
  console error is an expected 404 for the missing report #1 on
  `/pipeline/1/cv-studio`; aborted Link prefetches are ignored.
- **GET APIs (56):** 24×200, 27×405, 3×400, 2×404; no 5xx.
- **Malformed JSON** to the 16 JSON write routes: 15 return 400, `/api/explore`
  returns 200 (it streams an error); no 5xx.
- **Unknown API:** 404.
- **Guard:**
  - foreign `Host`: 403 on page and API
  - a rebinding host with a port: 403
  - `Sec-Fetch-Site: cross-site`: 403
  - foreign `Origin` on a write: 403
  - same-origin: 200
- **Headers on every page:** `cache-control: private, no-cache, no-store`,
  `x-powered-by: Next.js`.
  - No CSP, `X-Frame-Options` or `nosniff` header is set, the same as the baseline.
  - The app's security boundary is the origin/host guard in `proxy.js`.
  - Worth noting before a public deployment.
- **Command palette** (Ctrl+K) opens.

Smoke gaps:
- The baseline run of the same smoke script aborted on `ECONNRESET` and was not
  repeated. The page and API comparison with the baseline therefore rests on
  the previous phase's smoke and on the browser suites.
- The script's own nav-click check could not find a visible `nav a`, so it is
  inconclusive. Navigation is covered by the browser suites.

## Not done / limitations

- Not run, stopped at the user's request:
  - controlled parallel batches for the three flaky suites (5 sequential + 3×8
    concurrent per tree)
  - a full root `test-all.mjs` rerun after the Phase 2A edits
- No static type checking replaces `tsc`. JSDoc types are documentation (`checkJs: false`).
- Inner comments of long unions (`ScanEvent`, `Phase`) sit in the typedef
  description rather than next to their arm.
- Several root suites and the browser runner cannot run cleanly on this Windows
  host. Linux CI is authoritative for them.

## Scratch tooling (`C:\Users\ASUS\AppData\Local\hermes\cache\scratch`)

- `semi-clean.mjs`: semicolon classification and AST proof
- `restore-type-docs.mjs`: JSDoc restoration
- `lost-comments.mjs`: comment diff against the originals
- `equivalence.mjs`: TS-stripped AST comparison
- `integrity.mjs`: imports, dynamic imports, directives
- `run-failing.sh`: failing root suites in both trees
- `browser-run2.sh` + `kill-leaked.sh`: browser suites on Windows
