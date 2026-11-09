/**
 * web-ts-alias-loader.test.mjs — the resolver hook that teaches `node --test` to
 * follow the `@/…` import alias.
 *
 * web/jsconfig.json maps `"@/*" -> "./src/*"`, which webpack and SWC understand
 * natively and Node does not. The modules under web/src are plain JavaScript, so
 * the only thing standing between `node --test` and one of them is
 * SPECIFIER RESOLUTION — and without it the import fails as
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`, which reads in CI exactly
 * like a test that ran and passed nothing.
 *
 * Every assertion here runs in a CHILD process. The hook installs itself
 * globally and cannot be uninstalled, so an in-process "without the loader"
 * control would be contaminated by any earlier test that registered it — the
 * control would pass for the wrong reason and prove nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "..");
const REPO_ROOT = path.join(WEB, "..");
// A file:// URL, not the path: an absolute path is only a usable ESM specifier
// where it starts with "/". On Windows it starts with a drive letter, which
// Node reads as a URL scheme ("d:") and refuses. See the file:// URL test below.
const LOADER = pathToFileURL(path.join(HERE, "..", "helpers", "web-ts-alias-loader.mjs")).href;

const stripAnsi = (str) => (str || "").replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");

/** Run one ESM snippet in a fresh Node process. Never throws; reports the failure. */
function run(src, flags = [], cwd = WEB) {
  const childEnv = { ...process.env, NODE_DISABLE_COLORS: "1", NO_COLOR: "1" };
  delete childEnv.FORCE_COLOR;
  const argv = [
    ...flags,
    "--input-type=module",
    "-e",
    src,
  ];
  try {
    return { ok: true, out: stripAnsi(execFileSync(process.execPath, argv, {
      cwd, encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"], env: childEnv,
    })).trim() };
  } catch (e) {
    return { ok: false, out: stripAnsi((e.stdout || "").toString()).trim(), err: (e.stderr || "").toString() };
  }
}

const IMPORT_LOADER = `await import(${JSON.stringify(LOADER)});`;

test("CONTROL: without the loader, an @/ specifier fails to resolve", () => {
  // If this ever passes, every other assertion in this file is vacuous — the
  // alias would already be resolving and the hook would be doing nothing.
  const r = run(`await import("./src/lib/apply/cv.js"); console.log("LOADED");`);
  assert.equal(r.ok, false, "an @/-importing module must NOT load without the hook");
  assert.match(r.err, /ERR_MODULE_NOT_FOUND/, "expected the alias to be the reason it failed");
  assert.match(r.err, /@\/lib/, "expected the unresolved specifier to be the @/ alias");
});

test("with the loader, a module reached through @/ loads", () => {
  const r = run(`${IMPORT_LOADER}
    const m = await import("./src/lib/apply/cv.js");
    console.log(typeof m.resolveTailoredCv);`);
  assert.equal(r.ok, true, `expected the aliased import to succeed:\n${r.err}`);
  assert.equal(r.out, "function");
});

test("an extensionless @/ specifier resolves .js", () => {
  const r = run(`${IMPORT_LOADER}
    const m = await import("@/lib/career-ops");
    console.log(typeof m.careerOpsRoot);`);
  assert.equal(r.ok, true, `expected @/lib/career-ops to resolve to the .js file:\n${r.err}`);
  assert.equal(r.out, "function");
});

test("the @/ alias resolves from a cwd outside web/", () => {
  // The hook anchors web/src to its own file URL, and the comment there says why:
  // `npm test` runs from web/, a root-level `node --test web/tests/…` runs from the
  // repo root. Every other case here runs the child from web/, where a cwd anchor
  // and a file anchor are indistinguishable. From the repo root they are not:
  // there is no src/ beside this repo's package.json at all.
  const r = run(`${IMPORT_LOADER}
    const m = await import("@/lib/career-ops");
    console.log(process.cwd() !== ${JSON.stringify(WEB)}, typeof m.careerOpsRoot);`, [], REPO_ROOT);
  assert.equal(r.ok, true, `@/ must resolve from the repo root too:\n${r.err}`);
  // The first flag proves the child really ran somewhere else, so a silently
  // ignored cwd cannot make this case pass for web/'s reasons.
  assert.equal(r.out, "true function");
});

test("a @/ specifier that already names an extension is used as-is", () => {
  const r = run(`${IMPORT_LOADER}
    const m = await import("@/lib/company-slug.mjs");
    console.log(typeof m.companySlug);`);
  assert.equal(r.ok, true, `expected an explicit .mjs extension to pass through:\n${r.err}`);
  assert.equal(r.out, "function");
});

test("a non-@/ specifier is left to Node", () => {
  // The hook must be a no-op for everything else, or it becomes a resolution
  // bug that only shows up in tests.
  const r = run(`${IMPORT_LOADER}
    const p = await import("node:path");
    const rel = await import("./src/lib/company-slug.mjs");
    console.log(typeof p.join, typeof rel.companySlug);`);
  assert.equal(r.ok, true, `bare and relative specifiers must still resolve:\n${r.err}`);
  assert.equal(r.out, "function function");
});

test("importing the loader twice still resolves, and leaves its flag set", () => {
  // Named for what it measures. It is NOT evidence that the hook registered
  // once: ESM caches this module, so the second import never re-runs its body,
  // and the flag it reads is set in this realm whether or not the loader realm
  // registered again on its own.
  const r = run(`${IMPORT_LOADER}${IMPORT_LOADER}
    const m = await import("@/lib/career-ops");
    console.log(globalThis.__careerOpsWebAliasRegistered === true, typeof m.careerOpsRoot);`);
  assert.equal(r.ok, true, `a second import must not break resolution:\n${r.err}`);
  assert.equal(r.out, "true function");
});

test("the hook is injected as a file:// URL, not a bare absolute path", () => {
  // POSITIVE CONTROL, so this is not a vacuous string check: an absolute path
  // is only importable where it starts with "/". A Windows one does not — Node
  // parses "D:\…" as protocol "d:" and refuses it, on every platform.
  const control = run(`await import(${JSON.stringify("D:\\tmp\\hook.mjs")});`);
  assert.equal(control.ok, false, "a drive-letter path must not be importable");
  assert.match(control.err, /ERR_UNSUPPORTED_ESM_URL_SCHEME/);

  // So every case above, which installs the hook by handing its path to a child
  // as a specifier, fails on Windows and only on Windows — POSIX resolves the
  // same construction because its absolute paths happen to be valid URL paths.
  assert.match(
    IMPORT_LOADER,
    /^await import\("file:\/\//,
    `the hook must reach the child as a file:// URL; got: ${IMPORT_LOADER}`,
  );
});

test("an aliased module loads with type stripping turned off", () => {
  // POSITIVE CONTROL for the migration to plain JavaScript. Every module the
  // cases above reach used to be TypeScript and needed Node's type stripping on
  // top of this hook. Nothing under web/src needs it now, so an aliased import
  // must load on a Node that cannot strip types at all. Where this Node can,
  // --no-experimental-strip-types turns it off so the condition is measured
  // rather than assumed; where it cannot, the live runtime already is that case.
  const OFF = process.features?.typescript ? ["--no-experimental-strip-types"] : [];
  const r = run(`${IMPORT_LOADER}
    const m = await import("@/lib/career-ops");
    console.log(typeof m.careerOpsRoot);`, OFF);
  assert.equal(r.ok, true, `an aliased module must load without type stripping:\n${r.err}`);
  assert.equal(r.out, "function");
});

test("an unresolvable @/ specifier still reports the alias it could not find", () => {
  // Falling back to the first candidate keeps Node's own error message useful:
  // a silent nextResolve() on the raw specifier would blame '@/lib' instead of
  // naming the file that is actually missing.
  const r = run(`${IMPORT_LOADER}
    await import("@/lib/definitely-not-a-real-module");`);
  assert.equal(r.ok, false, "a missing aliased module must still fail");
  assert.match(r.err, /definitely-not-a-real-module/, "the error must name the missing module");
});
