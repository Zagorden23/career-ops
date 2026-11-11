"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Sparkles,
  TrendingUp,
  CheckCircle2,
  ArrowRight,
  Loader2,
  Building2,
  Target,
  Wand2,
  Compass,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { DEFAULT_FILTERS, filtersToParams } from "@/lib/explore";
import {
  buildLocationFilterTokens,
  inferLocationHierarchyFromText,
} from "@/lib/location-catalog.mjs";
import { LocationHierarchyPicker } from "@/components/explore/location-hierarchy-picker.jsx";
import {
  analyzeCvAndSuggestMarketJobs,
  modifyCvForMarketJobs,
} from "@/lib/cv/market-modifier.mjs";

const QUICK_INTEREST_CHIPS = [
  "Generative AI & LLM Agents",
  "Full-Stack React / Next.js",
  "Backend & Distributed Systems",
  "Data & ML Pipelines",
  "Cloud DevOps & Kubernetes",
  "Frontend & Design Systems",
  "Technical Product & Solutions",
];

export function CvMarketModifier({ cvContent = "", onApplyModifiedCv }) {
  const router = useRouter();
  const [interests, setInterests] = useState("");
  const [analysis, setAnalysis] = useState(() =>
    analyzeCvAndSuggestMarketJobs(cvContent, ""),
  );
  const [selectedIds, setSelectedIds] = useState([]);
  const [modifying, setModifying] = useState(false);
  const [result, setResult] = useState(null);
  const [draftModified, setDraftModified] = useState("");
  const [appliedBanner, setAppliedBanner] = useState(false);
  const [error, setError] = useState("");
  const [locSelection, setLocSelection] = useState(() =>
    inferLocationHierarchyFromText(cvContent),
  );

  // Re-run local instant analysis whenever cvContent or interests change
  useEffect(() => {
    const next = analyzeCvAndSuggestMarketJobs(cvContent, interests);
    setAnalysis(next);
    setSelectedIds((prev) => {
      const valid = prev.filter((id) => next.suggestions.some((s) => s.id === id));
      if (valid.length > 0) return valid;
      return next.suggestions.slice(0, 2).map((s) => s.id);
    });
    setLocSelection((prev) => {
      if (prev.country) return prev;
      return inferLocationHierarchyFromText(cvContent);
    });
  }, [cvContent, interests]);

  const toggleRole = useCallback((id) => {
    setSelectedIds((prev) =>
      prev.includes(id)
        ? prev.length > 1
          ? prev.filter((x) => x !== id)
          : prev
        : [...prev, id],
    );
  }, []);

  const addInterestChip = (chip) => {
    setInterests((prev) => {
      const clean = prev.trim();
      if (!clean) return chip;
      if (clean.toLowerCase().includes(chip.toLowerCase())) return clean;
      return `${clean}, ${chip}`;
    });
  };

  const runAiModify = async () => {
    if (!cvContent.trim()) {
      setError("Add or upload your CV above first so the AI modifier can analyze and rewrite it.");
      return;
    }
    setError("");
    setModifying(true);
    setAppliedBanner(false);
    try {
      const res = await fetch("/api/cv/market-modify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "modify",
          cvContent,
          interests,
          selectedRoleIds: selectedIds,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setResult(data);
        setDraftModified(data.modifiedCv || "");
        if (data.analysis) setAnalysis(data.analysis);
      } else {
        // Fallback to client-side deterministic engine if network hiccups
        const local = modifyCvForMarketJobs({
          cvMarkdown: cvContent,
          interests,
          selectedRoleIds: selectedIds,
        });
        setResult(local);
        setDraftModified(local.modifiedCv);
      }
    } catch {
      const local = modifyCvForMarketJobs({
        cvMarkdown: cvContent,
        interests,
        selectedRoleIds: selectedIds,
      });
      setResult(local);
      setDraftModified(local.modifiedCv);
    } finally {
      setModifying(false);
    }
  };

  const applyToEditor = () => {
    if (!draftModified.trim()) return;
    onApplyModifiedCv?.(draftModified);
    setAppliedBanner(true);
  };

  const scanMatchingJobs = () => {
    const roles =
      result?.targetRoles?.length > 0
        ? result.targetRoles
        : analysis.suggestions
            .filter((s) => selectedIds.includes(s.id))
            .flatMap((s) => s.searchRoles)
            .slice(0, 5);
    const locTokens = buildLocationFilterTokens(locSelection);
    const f = {
      ...DEFAULT_FILTERS,
      ats: [...DEFAULT_FILTERS.ats],
      positive: roles.length > 0 ? roles : ["Software Engineer"],
      allow: locTokens.allow,
      alwaysAllow: locTokens.alwaysAllow,
      sinceDays: 30,
    };
    const qs = filtersToParams(f);
    router.push(`/explore?${qs}${qs ? "&" : ""}run=1`);
  };

  return (
    <section
      aria-label="AI Market CV Modifier"
      className="mt-8 rounded-2xl border border-brand/30 bg-surface/50 p-6 shadow-sm"
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-xs font-medium text-brand-text">
            <Sparkles className="size-3.5" /> AI Market-Driven CV Modifier & Role Advisor
          </div>
          <h2 className="mt-2 font-display text-xl tracking-tight text-landing">
            Optimize your CV for the most demanding market jobs
          </h2>
          <p className="mt-1 text-sm text-muted">
            Analyzes your current <code className="text-foreground">cv.md</code> and career interests, recommends high-demand market roles you fit best, and rewrites your CV to maximize ATS & recruiter readiness—without fabricating facts.
          </p>
        </div>

        {/* Readiness Gauge */}
        <div className="flex items-center gap-4 rounded-xl border border-border bg-surface px-4 py-3">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-faint">Market Readiness</p>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="font-display text-2xl font-semibold text-foreground tabular-nums">
                {analysis.readinessScore}%
              </span>
              {result?.afterScore && result.afterScore > analysis.readinessScore && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-800 dark:text-emerald-400">
                  <ArrowRight className="size-3" /> {result.afterScore}% optimized
                </span>
              )}
            </div>
          </div>
          <div className="border-l border-border pl-4 text-xs text-muted">
            <div>
              <strong className="text-foreground">{analysis.detectedSkills.length}</strong> market skills
            </div>
            <div>
              <strong className="text-foreground">{analysis.metricsCount}</strong> impact metrics
            </div>
          </div>
        </div>
      </div>

      {/* Step 1: User Interests & Career Direction */}
      <div className="mt-5">
        <label htmlFor="cv-market-interests" className="block text-xs font-medium uppercase tracking-wider text-muted">
          1. Your Career Interests & Target Market Focus
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="cv-market-interests"
            type="text"
            value={interests}
            onChange={(e) => setInterests(e.target.value)}
            placeholder="e.g., Applied AI, LLM Agents, Full-Stack Next.js, Scalable Backend APIs, Cloud Architecture…"
            className="flex-1 rounded-xl border border-border bg-surface px-3.5 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-faint focus:border-brand/50"
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-faint">Quick add:</span>
          {QUICK_INTEREST_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => addInterestChip(chip)}
              className="rounded-full border border-border bg-surface/70 px-2.5 py-1 text-[11px] text-muted transition hover:border-brand/40 hover:text-brand-text"
            >
              + {chip}
            </button>
          ))}
        </div>
      </div>

      {/* Diagnostic Strengths & Opportunities */}
      {cvContent.trim() && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-surface/40 p-3.5">
            <p className="text-xs font-medium text-foreground">Detected CV Strengths</p>
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {analysis.strengths.map((s, idx) => (
                <li key={idx} className="flex items-start gap-1.5">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-border bg-surface/40 p-3.5">
            <p className="text-xs font-medium text-foreground">High-Impact Upgrade Opportunities</p>
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {analysis.improvementOpportunities.map((item, idx) => (
                <li key={idx} className="flex items-start gap-1.5">
                  <Target className="mt-0.5 size-3.5 shrink-0 text-brand-text" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Step 2: High-Demand Market Job Suggestions */}
      <div className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted">
            2. Relevant High-Demand Market Jobs (Select target roles to tailor your CV)
          </p>
          <span className="text-xs text-faint">
            {selectedIds.length} role{selectedIds.length === 1 ? "" : "s"} selected
          </span>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {analysis.suggestions.slice(0, 6).map((role) => {
            const selected = selectedIds.includes(role.id);
            return (
              <div
                key={role.id}
                onClick={() => toggleRole(role.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleRole(role.id);
                  }
                }}
                className={cn(
                  "cursor-pointer rounded-xl border p-4 transition-all",
                  selected
                    ? "border-brand bg-brand/5 ring-1 ring-brand/30"
                    : "border-border bg-surface/40 hover:border-brand/40",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="inline-flex items-center gap-1 rounded-md bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand-text">
                      <TrendingUp className="size-3" /> {role.demandScore}% Market Demand · {role.growthLabel}
                    </span>
                    <h3 className="mt-1.5 text-sm font-semibold text-foreground">{role.title}</h3>
                  </div>
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums",
                      selected ? "bg-brand text-brand-foreground" : "border border-border bg-surface text-muted",
                    )}
                  >
                    {role.currentMatchPct}% → {role.projectedMatchPct}% fit
                  </span>
                </div>

                <p className="mt-2 text-xs text-muted">{role.whyFit}</p>

                {role.matchedSkills.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1">
                    {role.matchedSkills.slice(0, 6).map((sk) => (
                      <span
                        key={sk}
                        className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-800 dark:text-emerald-300"
                      >
                        ✓ {sk}
                      </span>
                    ))}
                    {role.emphasizeKeywords.slice(0, 3).map((kw) => (
                      <span
                        key={kw}
                        className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-faint"
                        title="High-demand skill in this market track"
                      >
                        + {kw}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-faint">
                  <Building2 className="size-3 shrink-0" />
                  <span className="truncate">Hiring: {role.hiringCompanies.join(", ")}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Step 3: Target Location (Country -> State -> Office City) & Action Bar */}
      <div className="mt-6 space-y-4 border-t border-border pt-4">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">
            3. Target Job Location (Country &rarr; State / Province &rarr; Company Office / Branch City)
          </p>
          <LocationHierarchyPicker
            country={locSelection.country}
            state={locSelection.state}
            city={locSelection.city}
            includeRemote={locSelection.includeRemote}
            onChange={(next) =>
              setLocSelection({
                country: next.country,
                state: next.state,
                city: next.city,
                includeRemote: next.includeRemote,
              })
            }
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-muted">
            Preserves every real company, date, and metric in <code className="text-foreground">cv.md</code> while upgrading positioning, summary, and ATS keywords.
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={scanMatchingJobs}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-4 py-2 text-xs font-medium text-foreground transition hover:border-brand/40 hover:text-brand-text"
            >
              <Compass className="size-3.5" /> Scan live jobs for selected roles{locSelection.country ? ` in ${[locSelection.city, locSelection.state, locSelection.country].filter(Boolean).join(", ")}` : ""}
            </button>
            <button
              type="button"
              onClick={runAiModify}
              disabled={modifying || !cvContent.trim()}
              className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2 text-xs font-medium text-brand-foreground transition hover:bg-brand-200 disabled:opacity-50"
            >
              {modifying ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Optimizing CV for market demand…
                </>
              ) : (
                <>
                  <Wand2 className="size-3.5" /> Rewrite & Optimize CV for Selected Jobs
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-xs text-red-800 dark:text-red-400">
          {error}
        </p>
      )}

      {/* Step 4: Rewritten CV Review & 1-Click Apply */}
      {result && (
        <div className="mt-6 rounded-2xl border border-brand/30 bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                AI Market-Optimized CV Ready ({result.beforeScore}% → {result.afterScore}% Market Fit)
              </h3>
              <ul className="mt-1.5 space-y-1 text-xs text-muted">
                {result.changesSummary?.map((item, i) => (
                  <li key={i} className="flex items-center gap-1.5">
                    <CheckCircle2 className="size-3.5 shrink-0 text-brand-text" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={applyToEditor}
                className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-xs font-medium text-brand-foreground transition hover:bg-brand-200"
              >
                <CheckCircle2 className="size-3.5" /> Apply to CV & Save (cv.md)
              </button>
              <button
                type="button"
                onClick={scanMatchingJobs}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-4 py-2 text-xs font-medium text-foreground transition hover:border-brand/40 hover:text-brand-text"
              >
                Find Demanding Jobs Now <ArrowRight className="size-3.5" />
              </button>
            </div>
          </div>

          {appliedBanner && (
            <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300">
              ✓ Applied to your CV editor above and queued for auto-save to <code>cv.md</code>!
            </p>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <label htmlFor="ai-modified-cv-textarea" className="mb-1.5 block text-xs font-medium text-muted">
                Optimized CV Markdown (editable before applying)
              </label>
              <textarea
                id="ai-modified-cv-textarea"
                value={draftModified}
                onChange={(e) => setDraftModified(e.target.value)}
                spellCheck={false}
                className="h-80 w-full resize-y rounded-xl border border-border bg-surface/60 p-3 font-mono text-xs leading-relaxed outline-none focus:border-brand/50"
              />
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted">Live Formatted Preview</p>
              <article className="report-prose h-80 overflow-auto rounded-xl border border-border bg-surface/30 p-4 text-xs">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{draftModified}</ReactMarkdown>
              </article>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
