"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const START_EVENT = "career-ops:route-progress:start";

/** Start the navigation indicator before a route transition begins. */
export function startRouteProgress() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(START_EVENT));
  }
}

/**
 * App Router does not expose the old router event API. This small client
 * indicator listens for internal link clicks and completes when the committed
 * pathname or query string changes, while route-level `loading.tsx` supplies
 * the detailed skeleton underneath it.
 */
export function RouteProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locationKey = `${pathname}?${searchParams.toString()}`;
  const [state, setState] = useState("idle");
  const doneTimer = useRef(undefined);
  const safetyTimer = useRef(undefined);
  const activeLocation = useRef(locationKey);

  useEffect(() => {
    const onStart = () => {
      window.clearTimeout(doneTimer.current);
      window.clearTimeout(safetyTimer.current);
      setState("loading");
      // Same-route clicks and cancelled navigations must not leave a bar stuck.
      safetyTimer.current = window.setTimeout(() => setState("idle"), 8000);
    };

    const onClick = (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      let url;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      startRouteProgress();
    };

    window.addEventListener(START_EVENT, onStart);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener(START_EVENT, onStart);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  useEffect(() => {
    if (locationKey === activeLocation.current) return;
    activeLocation.current = locationKey;
    window.clearTimeout(safetyTimer.current);
    setState((current) => (current === "loading" ? "done" : current));
    doneTimer.current = window.setTimeout(() => setState("idle"), 500);
    return () => window.clearTimeout(doneTimer.current);
  }, [locationKey]);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {state === "loading" ? "Loading page" : ""}
      </div>
      <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5">
        <div data-state={state} className="route-bar h-full w-full rounded-r-full" />
      </div>
    </>
  );
}
