"use client";

import { Globe, MapPin, RotateCcw } from "lucide-react";
import {
  WORLD_LOCATION_CATALOG,
  getStatesForCountry,
  getCitiesForState,
  buildLocationFilterTokens,
} from "@/lib/location-catalog.mjs";

export function LocationHierarchyPicker({
  country = "",
  state = "",
  city = "",
  includeRemote = true,
  onChange,
  compact = false,
}) {
  const states = country ? getStatesForCountry(country) : [];
  const cities = country ? getCitiesForState(country, state) : [];

  const emit = (next) => {
    const merged = {
      country,
      state,
      city,
      includeRemote,
      ...next,
    };
    const tokens = buildLocationFilterTokens(merged);
    onChange?.({
      ...merged,
      allow: tokens.allow,
      alwaysAllow: tokens.alwaysAllow,
      label: tokens.label,
    });
  };

  return (
    <div className="rounded-xl border border-border bg-surface/50 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Globe className="size-3.5 text-brand-text" />
          Filter by Country &rarr; State / Region &rarr; Company Office City
        </span>
        {country && (
          <button
            type="button"
            onClick={() => emit({ country: "", state: "", city: "" })}
            className="inline-flex items-center gap-1 text-[11px] text-muted transition hover:text-foreground"
          >
            <RotateCcw className="size-3" /> Reset to Worldwide
          </button>
        )}
      </div>

      <div className={compact ? "grid gap-2 sm:grid-cols-4" : "grid gap-2.5 sm:grid-cols-3"}>
        {/* 1. Country */}
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted">
            1. Country
          </label>
          <select
            aria-label="Select country"
            value={country}
            onChange={(e) =>
              emit({ country: e.target.value, state: "", city: "" })
            }
            className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground outline-none transition focus:border-brand/50"
          >
            <option value="">All Countries (Worldwide)</option>
            {WORLD_LOCATION_CATALOG.map((c) => (
              <option key={c.code} value={c.country}>
                {c.country}
              </option>
            ))}
          </select>
        </div>

        {/* 2. State / Province */}
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted">
            2. State / Province
          </label>
          <select
            aria-label="Select state or province"
            value={state}
            disabled={!country}
            onChange={(e) => emit({ state: e.target.value, city: "" })}
            className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground outline-none transition focus:border-brand/50 disabled:opacity-50"
          >
            <option value="">
              {country ? `All States in ${country}` : "Select a country first"}
            </option>
            {states.map((s) => (
              <option key={s.state} value={s.state}>
                {s.state} ({s.cities.map((c) => c.name).join(", ")})
              </option>
            ))}
          </select>
        </div>

        {/* 3. Office / Branch City */}
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted">
            3. Office / Branch City
          </label>
          <select
            aria-label="Select office or branch city"
            value={city}
            disabled={!country}
            onChange={(e) => emit({ city: e.target.value })}
            className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground outline-none transition focus:border-brand/50 disabled:opacity-50"
          >
            <option value="">
              {state
                ? `All Office Cities in ${state}`
                : country
                  ? `All Office Cities in ${country}`
                  : "Select a country first"}
            </option>
            {cities.map((c) => (
              <option key={`${state}-${c.name}`} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* Include Remote Toggle */}
        <div className={compact ? "flex items-end pb-1" : "sm:col-span-3 flex flex-wrap items-center justify-between gap-2 pt-1"}>
          <button
            type="button"
            aria-pressed={includeRemote}
            onClick={() => emit({ includeRemote: !includeRemote })}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${
              includeRemote
                ? "border-brand/40 bg-brand/10 font-medium text-brand-text"
                : "border-border bg-surface text-muted hover:text-foreground"
            }`}
          >
            <span>{includeRemote ? "✓" : "+"} Also include Remote roles eligible for {country || "your region"}</span>
          </button>
          {country && (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2.5 py-0.5 text-[11px] font-medium text-brand-text">
              <MapPin className="size-3" />
              Active: {[city, state, country].filter(Boolean).join(" → ")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
