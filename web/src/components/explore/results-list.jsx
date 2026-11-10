"use client";

import { useMemo, useState } from "react";
import { Search, Plus, Compass } from "lucide-react";
import { cn } from "@/lib/cn";
import { CHINA_SOURCES } from "@/lib/employer-preset.mjs";
import {
  inferHierarchyFromAllowChips,
  matchesLocationHierarchy,
} from "@/lib/location-catalog.mjs";
import { CostBadge } from "@/components/cost/cost-badge";
import { DiscoveryCard } from "./discovery-card.jsx";
import { LocationHierarchyPicker } from "./location-hierarchy-picker.jsx";
import { useExplore } from "./explore-provider.jsx";

export function ResultsList({ offers }) {
  const {
    filters,
    setFilters,
    discover,
    companiesScanned,
    partial,
    error,
    addToPipeline,
    added,
    mode,
    running,
  } = useExplore();
  const isAi = mode === "ai";
  const employer = offers.some(o => CHINA_SOURCES.includes(o.source));
  const [sort, setSort] = useState("fresh");
  const [q, setQ] = useState("");
  const [locFilter, setLocFilter] = useState(() =>
    inferHierarchyFromAllowChips(filters?.allow || []),
  );

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = offers;
    if (locFilter.country) {
      list = list.filter((o) => matchesLocationHierarchy(o.location, locFilter));
    }
    if (needle) {
      list = list.filter(
        (o) =>
          o.title.toLowerCase().includes(needle) ||
          o.company.toLowerCase().includes(needle) ||
          (o.location || "").toLowerCase().includes(needle),
      );
    }
    const sorted = [...list].sort((a, b) =>
      sort === "fresh" ? (b.postedAt || "").localeCompare(a.postedAt || "") : a.company.localeCompare(b.company),
    );
    return sorted;
  }, [offers, q, sort, locFilter]);

  const addable = view.filter((o) => !o.inPipeline && !o.evaluatedN && !added.has(o.url));

  const rescanForLocation = () => {
    if (!locFilter.allow?.length) return;
    setFilters({
      ...filters,
      allow: locFilter.allow,
      alwaysAllow: locFilter.alwaysAllow || locFilter.allow.slice(0, 12),
      sinceDays: Math.max(filters?.sinceDays || 7, 30),
    });
    void discover();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <p className="text-sm text-foreground">
            <span className="font-semibold">{offers.length}</span> {isAi ? `candidate${offers.length === 1 ? "" : "s"}` : employer ? `match${offers.length === 1 ? "" : "es"}` : `fresh role${offers.length === 1 ? "" : "s"}`}
            <CostBadge kind={isAi ? "spend" : "free-network"} size="xs" className="ml-2 align-middle" />
          </p>
          <p className="text-[12px] text-faint">
            {isAi
              ? "found by AI on the open web · unverified until you evaluate"
              : employer ? "From selected employer sites · check the original JD · 0 tokens spent" : `${companiesScanned > 0 ? `${companiesScanned.toLocaleString()} companies scanned · ` : ""}0 tokens spent${partial ? " · some boards were unreachable (normal for public directories)" : ""}`}
          </p>
          {!isAi && error && <p className="text-[12px] text-amber-800 dark:text-amber-300">{error}</p>}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5">
            <Search className="size-3.5 text-faint" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter results…"
              className="w-32 bg-transparent text-[13px] outline-none placeholder:text-faint"
            />
          </div>
          <div className="inline-flex rounded-lg border border-border bg-surface/40 p-0.5 text-xs">
            {(["fresh", "company"]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSort(s)}
                className={cn("rounded-md px-2.5 py-1 font-medium capitalize transition-colors", sort === s ? "bg-brand-soft text-brand-text" : "text-muted hover:text-foreground")}
              >
                {s}
              </button>
            ))}
          </div>
          {addable.length > 1 && (
            <button
              type="button"
              onClick={() => addToPipeline(addable)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand-text"
            >
              <Plus className="size-3.5" /> Add all {addable.length}
            </button>
          )}
        </div>
      </div>

      {!employer && (
        <div className="space-y-2">
          <LocationHierarchyPicker
            compact
            country={locFilter.country}
            state={locFilter.state}
            city={locFilter.city}
            includeRemote={locFilter.includeRemote}
            onChange={(next) => {
              setLocFilter(next);
              if (filters) {
                setFilters({
                  ...filters,
                  allow: next.allow,
                  alwaysAllow: next.alwaysAllow,
                });
              }
            }}
          />
          {locFilter.country && !running && !isAi && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand/25 bg-brand/5 px-3 py-2 text-xs">
              <span className="text-muted">
                Showing <strong className="text-foreground">{view.length}</strong> of {offers.length} roles matching{" "}
                <strong className="text-foreground">{[locFilter.city, locFilter.state, locFilter.country].filter(Boolean).join(" → ")}</strong>
                {locFilter.includeRemote ? " (+ Remote)" : ""}.
              </span>
              <button
                type="button"
                onClick={rescanForLocation}
                className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground transition hover:brightness-110"
              >
                <Compass className="size-3.5" /> Scan live ATS boards for {[locFilter.city, locFilter.state, locFilter.country].filter(Boolean).join(", ")}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {view.map((o) => (
          <DiscoveryCard key={o.url} offer={o} inPipeline={o.inPipeline} evaluatedN={o.evaluatedN} />
        ))}
      </div>

      {view.length === 0 && (q.trim() || locFilter.country || !running) && (
        <div className="py-10 text-center text-sm text-faint space-y-3">
          <p>
            No results in the current batch match{" "}
            {locFilter.country
              ? [locFilter.city, locFilter.state, locFilter.country].filter(Boolean).join(" → ")
              : `“${q}”`}
            .
          </p>
          {locFilter.country && !running && !isAi && (
            <button
              type="button"
              onClick={rescanForLocation}
              className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-xs font-medium text-brand-foreground transition hover:brightness-110"
            >
              <Compass className="size-3.5" /> Run a deep ATS scan specifically for {[locFilter.city, locFilter.state, locFilter.country].filter(Boolean).join(", ")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
