"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { scoreTone } from "@/lib/format";
import { resolveCliId } from "@/lib/saved-cli";
import { createWorkerFeedback } from "@/lib/worker-feedback.mjs";
import { readJobStream } from "@/lib/job-stream.mjs";
import { createJobsPersister } from "@/lib/jobs-persist.mjs";

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} title
 * @property {string} [subtitle]
 * @property {string} [page] route the job was launched from / refers to
 * @property {string} [input] the URL/posting it processed (links inbox rows to their worker)
 * @property {string} [kind]
 * @property {string[]} [evaluationSections]
 * @property {string} [batchId] groups jobs fired together (e.g. "evaluate all Anthropic")
 * @property {"running" | "done" | "error" | "gated"} status
 * @property {JobGate} [gate]
 * @property {JobStep[]} steps
 * @property {string} text
 * @property {JobResult} [result]
 * @property {{ tokens: number; usd?: number }} [cost] per-run token cost (Claude result event) — local only
 * @property {number | null} [reportN]
 * @property {number} startedAt
 * @property {number} [endedAt]
 */

const JobsContext = createContext(null);
export function useJobs() {
  const c = useContext(JobsContext);
  if (!c) throw new Error("useJobs must be used within <JobsProvider>");
  return c;
}

const JOBS_KEY = "career-ops:jobs";

function parseVerdict(text) {
  const m = text.match(/VERDICT:\s*([\d.]+)\s*\/\s*5\s*[—:|-]+\s*(.+)/i);
  if (m) {
    const score = parseFloat(m[1]);
    return { score, summary: m[2].trim().replace(/\s+/g, " ").slice(0, 90), tone: scoreTone(`${score}`) };
  }
  const s = text.match(/\b([0-5](?:\.\d)?)\s*\/\s*5\b/);
  if (s) {
    const score = parseFloat(s[1]);
    return { score, summary: "", tone: scoreTone(`${score}`) };
  }
  return { score: null, summary: "", tone: "muted" };
}

export function JobsProvider({ children }) {
  const [jobs, setJobs] = useState([]);
  const [announcement, setAnnouncement] = useState("");
  const feedback = useRef(null);
  useEffect(() => {
    const owner = createWorkerFeedback(setAnnouncement);
    feedback.current = owner;
    return () => { owner.dispose(); feedback.current = null; };
  }, []);
  const seq = useRef(0);
  const loaded = useRef(false);

  // restore history
  useEffect(() => {
    try {
      const raw = localStorage.getItem(JOBS_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        // anything left "running" from a previous session is stale → mark interrupted
        setJobs(arr.map((j) => (j.status === "running" ? { ...j, status: "error", steps: [...(j.steps || []), { kind: "status", label: "Interrupted (page reloaded)", ts: Date.now() }] } : j)));
      }
    } catch {
      /* ignore */
    }
    loaded.current = true;
  }, []);

  // persist. Every streamed chunk replaces `jobs`, so writes go through the
  // persister: at once when nothing runs, at most once a second while a job
  // streams, and flushed when the page is hidden or the provider unmounts.
  const persister = useRef(null);
  if (persister.current === null) {
    persister.current = createJobsPersister({
      write: (list) => {
        try {
          localStorage.setItem(JOBS_KEY, JSON.stringify(list.slice(0, 40)));
        } catch {
          /* quota */
        }
      },
      isActive: (list) => list.some((j) => j.status === "running"),
    });
  }
  useEffect(() => {
    const owner = persister.current;
    const flush = () => owner?.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    persister.current?.save(jobs);
  }, [jobs]);

  const patch = useCallback((id, fn) => {
    setJobs((js) => js.map((j) => (j.id === id ? fn(j) : j)));
  }, []);

  const startJob = useCallback(
    (opts) => {
      const id = `job-${Date.now()}-${seq.current++}`;
      const job = {
        id,
        title: opts.title,
        subtitle: opts.subtitle,
        page: opts.page,
        input: opts.input,
        kind: opts.kind,
        evaluationSections: opts.evaluationSections ? [...opts.evaluationSections] : undefined,
        batchId: opts.batchId,
        status: "running",
        steps: [{ kind: "status", label: "Starting…", ts: Date.now() }],
        text: "",
        startedAt: Date.now(),
      };
      setJobs((js) => [job, ...js]);

      // Declared before resolveCliId() so its stale-CLI notice lands in the log
      // sent to /api/runs/save, not only in the live job.
      const steps = [];
      (async () => {
        // resolveCliId() validates the saved id against what is installed; a
        // bare readSavedCliId() here would short-circuit that check and launch
        // a run against an uninstalled CLI (#4012).
        // A stale saved id is replaced silently otherwise — name the switch in
        // the job log so a transient "not installed" can't rewrite the user's
        // choice without a record.
        const cliId = await resolveCliId((stale, replacement) => {
          const label = replacement
            ? `Saved CLI '${stale}' is not installed — using '${replacement}'`
            : `Saved CLI '${stale}' is not installed`;
          const step = { kind: "status", label, ts: Date.now() };
          steps.push(step);
          patch(id, (j) => ({ ...j, steps: [...j.steps, step] }));
        });
        if (!cliId) {
          feedback.current?.push({ ...job, status: "error" });
          patch(id, (j) => ({
            ...j,
            status: "error",
            endedAt: Date.now(),
            steps: [...j.steps, { kind: "status", label: "No CLI configured — open Config and click Save config", ts: Date.now() }],
          }));
          return;
        }
        let text = "";
        let verdictLine = ""; // latched separately so the 8000-char tail can't drop it
        let doneTokens = 0; // per-run token cost, forwarded on the done event (#6)
        let doneCostUsd = null;
        let doneReportN = null;
        let finished = false;
        const finish = (status, lastLabel, gate) => {
          if (finished) return;
          finished = true;
          feedback.current?.push({ ...job, status });
          const result = status === "done" ? parseVerdict(verdictLine || text) : undefined;
          const cost = status !== "error" && doneTokens > 0 ? { tokens: doneTokens, usd: doneCostUsd ?? undefined } : undefined;
          patch(id, (j) => ({
            ...j,
            status,
            gate,
            result,
            cost,
            reportN: doneReportN,
            endedAt: Date.now(),
            steps: lastLabel ? [...j.steps, { kind: "status", label: lastLabel, ts: Date.now() }] : j.steps,
          }));
          // persist a readable log file so the CLI/assistant can read past runs
          if (status === "done" || status === "gated") {
            fetch("/api/runs/save", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, title: opts.title, subtitle: opts.subtitle, page: opts.page, input: opts.input, status, gate, result, cost, steps, output: text }),
            }).catch(() => {});
            // Tell server-snapshot surfaces (Today, pipeline) to refetch — the
            // worker just wrote a real tracker row / report they don't yet see.
            if (status === "done" && typeof window !== "undefined" && (opts.kind === "evaluate" || opts.kind === "pdf")) {
              window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: opts.kind, input: opts.input } }));
            }
          }
        };

        try {
          const res = await fetch("/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: opts.kind, input: opts.input, cliId, brief: opts.brief, evaluationSections: opts.evaluationSections }),
          });
          if (!res.ok || !res.body) {
            const e = await res.json().catch(() => ({}));
            finish("error", e.error || "Failed to start");
            return;
          }
          const completion = await readJobStream(res.body, (ev) => {
            if (ev.type === "tool") {
              steps.push({ kind: "tool", label: ev.name, ts: Date.now() });
              patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "tool", label: ev.name, ts: Date.now() }] }));
            } else if (ev.type === "status") {
              steps.push({ kind: "status", label: ev.label, ts: Date.now() });
              patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "status", label: ev.label, ts: Date.now() }] }));
            } else if (ev.type === "text") {
              const full = text + ev.text;
              const vm = full.match(/VERDICT:[^\n]*/i);
              if (vm) verdictLine = vm[0];
              text = full.slice(-8000);
              patch(id, (j) => ({ ...j, text }));
            }
          });
          if (completion.status === "error") {
            finish("error", completion.message);
            return;
          }
          doneTokens = completion.tokens ?? 0;
          doneCostUsd = completion.costUsd ?? null;
          if (completion.status === "gated") {
            finish("gated", "Evaluation stopped — review the reason", {
              reason: completion.reason,
              message: completion.message,
              confirmationRequired: completion.confirmationRequired,
            });
            return;
          }
          doneReportN = typeof completion.reportN === "number" ? completion.reportN : null;
          finish("done", "Done");
        } catch {
          finish("error", "Connection error");
        }
      })();

      return id;
    },
    [patch],
  );

  const removeJob = useCallback((id) => setJobs((js) => js.filter((j) => j.id !== id)), []);
  const clearFinished = useCallback(() => setJobs((js) => js.filter((j) => j.status === "running")), []);

  // A new object only when the list or an action changes, not on every render
  // of this provider (the screen-reader announcement re-renders it too).
  const value = useMemo(() => ({ jobs, startJob, removeJob, clearFinished }), [jobs, startJob, removeJob, clearFinished]);

  return (
    <JobsContext.Provider value={value}>
      {children}
      <div role="status" aria-label="Worker task status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>
    </JobsContext.Provider>
  );
}
