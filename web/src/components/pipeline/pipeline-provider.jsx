"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * A thin client mirror of the pipeline so BOTH the pages and the assistant
 * console (a different subtree) can read inbox/applications. Hydrated once from
 * /api/pipeline; refetches on window focus and on demand (refetch()) so the
 * snapshot doesn't go stale after a status writeback or a new scan.
 *
 * @typedef {object} Snapshot
 * @property {InboxJob[]} inbox
 * @property {Application[]} applications
 * @property {boolean} loading
 * @property {() => void} refetch
 */

const PipelineContext = createContext(null);

export function usePipeline() {
  const c = useContext(PipelineContext);
  if (!c) throw new Error("usePipeline must be used within <PipelineProvider>");
  return c;
}

export function PipelineProvider({ children }) {
  const [inbox, setInbox] = useState([]);
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    setLoading(true);
    fetch("/api/pipeline")
      .then((r) => r.json())
      .then((d) => {
        setInbox(Array.isArray(d.inbox) ? d.inbox : []);
        setApplications(Array.isArray(d.applications) ? d.applications : []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const onFocus = () => refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  return (
    <PipelineContext.Provider value={{ inbox, applications, loading, refetch }}>
      {children}
    </PipelineContext.Provider>
  );
}
