// Client-safe (NO node imports) tolerant streaming parser for the AI-search
// `<<offer:{...}>>` envelopes emitted by modes/discover.md. Modeled on the
// assistant console's <<act:>> envelope parsing, factored out so the grammar
// can't drift. The load-bearing requirement: an envelope (or its opener) split
// across stream chunk boundaries must BUFFER, never flush as garbage or drop.

import { pendingOpenerLen } from "./stream-parse.mjs";
import { normalizeUrl } from "./core/url-key.mjs";

const OPEN = "<<offer:";
const CLOSE = ">>";

/**
 * Normalize a URL for dedup. Delegates to the parity-tested normalizeUrl
 * mirror (url-key.mjs) instead of host+pathname — a bare host+path key
 * discarded the query string unconditionally, so two DIFFERENT postings that
 * share a path and differ only by a functional query id (e.g. Greenhouse's
 * `?gh_jid=`) collapsed onto one key and every opening after the first at
 * that host+path was silently dropped from AI Discover results.
 *
 * Can return '' for an unparseable / non-http(s) input — callers must treat
 * that as NO KEY, never as a value that matches another ''.
 */
export function canon(u) {
  return normalizeUrl(u);
}

function toOffer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const o = raw;
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return null;
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const conf = o.confidence;
  return {
    url,
    company: str(o.company),
    title: str(o.title),
    location: str(o.location),
    postedAt: "", // AI gives only a human postedHint, never a trustworthy date
    ats: str(o.ats) || "other",
    source: "ai-search",
    verification: "unconfirmed",
    why: str(o.why) || undefined,
    postedHint: str(o.postedHint) || undefined,
    confidence: conf === "low" || conf === "medium" || conf === "high" ? conf : undefined,
  };
}

/**
 * Server side of the known-URL dedup: passes the AI's text through unchanged
 * except for `<<offer:…>>` envelopes whose URL is already known (scan history,
 * inbox), which it drops. /api/explore/ai runs it on the stream so the full
 * known set never has to be sent to the browser. The envelope grammar, the
 * offer reading and the URL key are the client parser's own, so both sides
 * agree on what an offer and its key are. A malformed envelope passes through
 * for the client to report.
 */
export function makeKnownOfferFilter(known) {
  let buf = "";
  return {
    feed(delta) {
      buf += delta;
      let out = "";
      for (;;) {
        const open = buf.indexOf(OPEN);
        if (open === -1) {
          // Hold back a trailing partial opener, as the client parser does.
          const hold = pendingOpenerLen(buf, OPEN);
          out += buf.slice(0, buf.length - hold);
          buf = buf.slice(buf.length - hold);
          return out;
        }
        out += buf.slice(0, open);
        const close = buf.indexOf(CLOSE, open + OPEN.length);
        if (close === -1) {
          buf = buf.slice(open);
          return out;
        }
        const envelope = buf.slice(open, close + CLOSE.length);
        const json = buf.slice(open + OPEN.length, close);
        buf = buf.slice(close + CLOSE.length);
        let offer = null;
        try {
          offer = toOffer(JSON.parse(json));
        } catch {
          offer = null;
        }
        const key = offer ? canon(offer.url) : "";
        if (key && known.has(key)) continue;
        out += envelope;
      }
    },
    /** Whatever is still buffered when the stream ends. */
    flush() {
      const rest = buf;
      buf = "";
      return rest;
    },
  };
}

export function makeAiStreamParser(opts) {
  const known = opts?.knownUrls ?? new Set();
  const seen = new Set();
  let buf = "";

  return {
    feed(delta) {
      buf += delta;
      const out = [];
      for (;;) {
        const open = buf.indexOf(OPEN);
        if (open === -1) {
          // No opener in view. Flush as narration — but hold back the longest
          // trailing run that could be the start of a split opener ("<<offe…"),
          // so an offer whose marker straddles a chunk boundary is never dropped
          // as garbage (#2290). A fixed-length tail check missed the shorter
          // partial openers ("<<", "<<off") preceded by other text.
          const hold = pendingOpenerLen(buf, OPEN);
          const text = hold ? buf.slice(0, buf.length - hold) : buf;
          if (text.trim()) out.push({ kind: "narration", text });
          buf = hold ? buf.slice(buf.length - hold) : "";
          break;
        }
        const before = buf.slice(0, open);
        if (before.trim()) out.push({ kind: "narration", text: before });
        const close = buf.indexOf(CLOSE, open + OPEN.length);
        if (close === -1) {
          // Envelope still streaming — keep from the opener onward and wait.
          buf = buf.slice(open);
          break;
        }
        const json = buf.slice(open + OPEN.length, close);
        buf = buf.slice(close + CLOSE.length);
        let offer = null;
        try {
          offer = toOffer(JSON.parse(json));
        } catch {
          offer = null;
        }
        if (!offer) {
          out.push({ kind: "malformed", raw: json.slice(0, 120) });
          continue;
        }
        const key = canon(offer.url);
        // '' means NO KEY (an unparseable-but-regex-passing url) — never treat
        // two such offers as duplicates of EACH OTHER just because both are ''.
        if (key && (seen.has(key) || known.has(key))) continue; // intra-run + known dedup
        if (key) seen.add(key);
        out.push({ kind: "offer", offer });
      }
      return out;
    },
    /** Emit any trailing buffered narration when the stream ends. */
    flush() {
      const text = buf;
      buf = "";
      return text.trim() ? [{ kind: "narration", text }] : [];
    },
  };
}
