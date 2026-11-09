// Client-safe types + codec for the Explorer (job discovery). NO node imports —
// both client components and server routes import this for the shared shapes, so
// the filter contract, the discovered-offer shape, and the stream-event grammar
// can never drift between the two halves. Server-only logic (spawning the scanner,
// writing temp files) lives in lib/core/{scan,portals,pipeline}.ts.

export const ATS_SOURCES = ["greenhouse", "lever", "ashby", "workday"];
export const ATS_LABEL = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workday: "Workday",
};

/**
 * The full UI filter state. The keyword/location lists mirror scan.mjs's
 *  buildTitleFilter / buildLocationFilter semantics; sinceDays/ats/limitPerAts map
 *  to scan-ats-full.mjs's --since / --ats / --limit.
 *
 * @typedef {object} ExploreFilters
 * @property {"china-employers"} [preset]
 * @property {EmployerSource[]} [employers]
 * @property {string[]} positive
 * @property {string[]} negative
 * @property {string[]} allow
 * @property {string[]} block
 * @property {string[]} blockHard
 * @property {string[]} alwaysAllow
 * @property {number} sinceDays
 * @property {AtsSource[]} ats
 * @property {number} limitPerAts
 */

export const DEFAULT_FILTERS = {
  positive: [],
  negative: [],
  allow: [],
  block: [],
  blockHard: [],
  alwaysAllow: [],
  sinceDays: 7,
  ats: [...ATS_SOURCES],
  limitPerAts: 150,
};

/**
 * Stream event grammar (NDJSON). `kind` discriminates. Discovery is FREE — the
 *  terminal `done` always carries cost {tokens:0, usd:0}.
 * Authoritative degraded-vs-empty signals from the scanner's --json mode (#1199).
 * Absent on older local checkouts (the legacy human-stdout parse can't supply them).
 * Sources whose results are missing (ran out of time or crashed) while the
 * others finished — a partial result, never "all caught up".
 *
 * @typedef {{ kind: "start"; ats: string[]; sinceDays: number; limit: number; free: true } | { kind: "atsStart"; ats: string; companies: number } | { kind: "progress"; ats: string; scanned: number; total: number; matches: number } | { kind: "atsDone"; ats: string; unreachable: number } | { kind: "offer"; offer: DiscoveredOffer } | { kind: "summary"; companiesScanned: number; unreachable: number; matches: number; companiesAvailable?: number; capHit?: boolean; datasetStatus?: Record<string, "ok" | "stale" | "empty">; postingsDroppedNoDate?: number; incomplete?: string[]; employerOutcome?: EmployerScanOutcome; employerSources?: { id: string; state: string; reason?: string }[]; } | { kind: "log"; line: string } | { kind: "error"; message: string } | { kind: "done"; count: number; offers: DiscoveredOffer[]; cost?: { tokens: number; usd: number } }} ScanEvent
 */

/**
 * The two discovery surfaces: free deterministic Scan vs token-spending AI search.
 *
 * @typedef {"scan" | "ai"} ExploreMode
 */

/**
 * @typedef {object} DiscoveredOffer
 * @property {string} url
 * @property {string} company
 * @property {string} title
 * @property {string} location
 * @property {string} postedAt YYYY-MM-DD, or "" when the engine reported n/a (AI offers always "")
 * @property {Record<string, unknown>} [geographyEvidence] Provider evidence carried through review for the conditional Inbox gate.
 * @property {string} ats
 * @property {string} source
 * @property {string} [matchedKeyword] which positive keyword matched the title (transparency, e.g. "ai" in "Nail")
 * @property {{ band: FitBand; score: number }} [fit] free, zero-token triage hint computed at discovery time from the posting  TITLE vs config/profile.yml target roles (#3260). Recommendation layer  only — never filters or orders anything; Evaluate gives the real A–F.  Scan offers only; AI offers already carry why + confidence.
 * @property {string} [note] optional free-text ranking signal preserved to pipeline.md by the canonical  writer (scan.mjs formatPipelineOffer). Generic and source-agnostic — an  importer can attach a note; the deterministic scan omits it.
 * @property {"unconfirmed"} [verification] ── AI-search (modes/discover.md) additions — all optional, so the deterministic scan offer is unaffected (fields simply absent). ── present ONLY on AI offers → drives the "unverified" badge. AI finds can't be  liveness-confirmed (AGENTS.md); the scan hits a live ATS API so it omits this.
 * @property {string} [why] one-line "why it matched" judgment (the thing a deterministic scan can't give)
 * @property {string} [postedHint] human freshness ("~5d ago", "unknown") shown when postedAt is ""
 * @property {"low" | "medium" | "high"} [confidence]
 */

/**
 * Banded title-vs-profile overlap (web/src/lib/title-fit.mjs). Words, not
 *  numbers, so it can't be mistaken for the evaluation's real 1–5 / A–F.
 *
 * @typedef {"strong" | "related" | "weak"} FitBand
 */

// cleanChips is defined in clean-chips.mjs (plain JS) so it can be shared
// with the test suite without a TypeScript runner. Import for internal use
// and re-export for external consumers (filter-builder.tsx, etc.).
import { cleanChips } from "./clean-chips.mjs";
export { cleanChips };

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function cleanAts(v) {
  if (!Array.isArray(v)) return [...ATS_SOURCES];
  const out = v
    .map((a) => String(a).toLowerCase())
    .filter((a) => ATS_SOURCES.includes(a));
  return out.length ? Array.from(new Set(out)) : [...ATS_SOURCES];
}

/** Apply a (possibly partial) action/assistant patch onto a base. The assistant
 *  emits {positive,negative,allow,block,alwaysAllow,since,ats,limit}. With
 *  merge=true, list fields are ADDED to the base; otherwise the given fields
 *  REPLACE. Unspecified fields are left as-is. */
export function parseExplorePatch(
  raw,
  base = DEFAULT_FILTERS,
  merge = false,
) {
  const next = { ...base, ats: [...base.ats] };
  if (raw.preset === "china-employers") next.preset = "china-employers";
  else if (raw.preset !== undefined) next.preset = undefined;
  if (raw.employers !== undefined && Array.isArray(raw.employers)) {
    next.employers = [...new Set(raw.employers.filter((id) => ["tencent", "bytedance", "meituan"].includes(String(id))))];
  }
  const lists = [
    ["positive", "positive"],
    ["negative", "negative"],
    ["allow", "allow"],
    ["block", "block"],
    ["blockHard", "blockHard"],
    ["alwaysAllow", "alwaysAllow"],
  ];
  for (const [field, key] of lists) {
    if (raw[key] === undefined) continue;
    const incoming = cleanChips(raw[key]);
    next[field] = (merge ? cleanChips([...(base[field]), ...incoming]) : incoming);
  }
  if (raw.since !== undefined) next.sinceDays = clampNum(raw.since, 1, 60, base.sinceDays);
  if (raw.sinceDays !== undefined) next.sinceDays = clampNum(raw.sinceDays, 1, 60, base.sinceDays);
  if (raw.limit !== undefined) next.limitPerAts = clampNum(raw.limit, 50, 500, base.limitPerAts);
  if (raw.limitPerAts !== undefined) next.limitPerAts = clampNum(raw.limitPerAts, 50, 500, base.limitPerAts);
  if (raw.ats !== undefined) next.ats = cleanAts(raw.ats);
  return next;
}

/** URL <-> filters codec (so a search is shareable/restorable). */
export function filtersToParams(f) {
  const sp = new URLSearchParams();
  if (f.preset === "china-employers") {
    sp.set("preset", f.preset);
    sp.set("employers", (f.employers ?? []).join(","));
  }
  if (f.positive.length) sp.set("q", f.positive.join(","));
  if (f.negative.length) sp.set("not", f.negative.join(","));
  if (f.allow.length) sp.set("loc", f.allow.join(","));
  if (f.block.length) sp.set("noloc", f.block.join(","));
  if (f.blockHard.length) sp.set("hardno", f.blockHard.join(","));
  if (f.alwaysAllow.length) sp.set("home", f.alwaysAllow.join(","));
  if (f.sinceDays !== DEFAULT_FILTERS.sinceDays) sp.set("since", String(f.sinceDays));
  if (f.ats.length !== ATS_SOURCES.length) sp.set("ats", f.ats.join(","));
  if (f.limitPerAts !== DEFAULT_FILTERS.limitPerAts) sp.set("limit", String(f.limitPerAts));
  return sp.toString();
}

export function paramsToFilters(sp, base = DEFAULT_FILTERS) {
  const split = (s) => (s ? s.split(",") : undefined);
  return parseExplorePatch(
    {
      preset: sp.get("preset") ?? undefined,
      employers: sp.has("employers") ? (sp.get("employers") || "").split(",") : undefined,
      positive: split(sp.get("q")),
      negative: split(sp.get("not")),
      allow: split(sp.get("loc")),
      block: split(sp.get("noloc")),
      blockHard: split(sp.get("hardno")),
      alwaysAllow: split(sp.get("home")),
      since: sp.get("since") ?? undefined,
      ats: split(sp.get("ats")),
      limit: sp.get("limit") ?? undefined,
    },
    base,
  );
}

/** AI-search URL codec (so an AI hunt is shareable/restorable). */
export function aiToParams(intent) {
  const sp = new URLSearchParams();
  sp.set("mode", "ai");
  if (intent.trim()) sp.set("intent", intent.trim());
  return sp.toString();
}

export function paramsToAi(sp) {
  if (sp.get("mode") !== "ai") return null;
  return sp.get("intent") ?? "";
}

/** Is the search broad enough that "nothing found" means "you're current"
 *  (good news) rather than "loosen your filters" (actionable)? */
export function isBroadSearch(f) {
  return f.positive.length <= 1 && f.block.length === 0 && f.allow.length === 0;
}
