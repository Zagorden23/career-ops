import { LayoutDashboard, Compass, ListChecks, Send, Radar, BarChart3, FileText, Files, Settings, CalendarClock } from "lucide-react";

/**
 * Single source of truth for the app's primary destinations — shared by the
 * desktop sidebar and the mobile nav so they can never drift.
 *
 * @typedef {object} NavItem
 * @property {string} href
 * @property {string} label
 * @property {ComponentType<SVGProps<SVGSVGElement>>} icon
 * @property {string} [chip]
 */

export const NAV_ITEMS = [
  { href: "/", label: "Today", icon: LayoutDashboard },
  { href: "/explore", label: "Explore", icon: Compass, chip: "New" },
  { href: "/scheduled-scans", label: "Scheduled scans", icon: CalendarClock },
  { href: "/pipeline", label: "Pipeline", icon: ListChecks },
  { href: "/followups", label: "Follow-ups", icon: Send },
  { href: "/portals", label: "Portals", icon: Radar },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/cv", label: "CV", icon: FileText },
  { href: "/documents", label: "Documents", icon: Files },
  { href: "/config", label: "Config", icon: Settings },
];

export function visibleNavItems(followupsEnabled) {
  return followupsEnabled ? NAV_ITEMS : NAV_ITEMS.filter((item) => item.href !== "/followups");
}

export function isActivePath(href, pathname) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
