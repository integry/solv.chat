import { type ReactNode, useCallback, useEffect, useState } from "react";

export type BuiltinScreenId =
  | "overview"
  | "reports"
  | "conversations"
  | "gaps"
  | "sources"
  | "tools"
  | "behaviour"
  | "widget"
  | "tests"
  | "install"
  | "providers";

export type ScreenId = BuiltinScreenId;

export interface NavItem {
  id: string;
  label: string;
  path: string;
  /** Sidebar group heading. Built-in screens use the groups below. */
  section?: string;
  /** Small decorative icon shown before the label (a host item's own SVG). */
  icon?: ReactNode;
}

/** Built-in sidebar groups, in order. Host sections are listed after them. */
export const NAV_GROUPS = ["Monitor", "Build", "Go live", "Settings"] as const;

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "overview", label: "Overview", path: "/admin/overview", section: "Monitor" },
  { id: "reports", label: "Reports", path: "/admin/reports", section: "Monitor" },
  {
    id: "conversations",
    label: "Conversations",
    path: "/admin/conversations",
    section: "Monitor",
  },
  { id: "gaps", label: "Gaps", path: "/admin/gaps", section: "Monitor" },
  { id: "sources", label: "Sources", path: "/admin/sources", section: "Build" },
  { id: "behaviour", label: "Behaviour", path: "/admin/behaviour", section: "Build" },
  { id: "tools", label: "Tools", path: "/admin/tools", section: "Build" },
  { id: "widget", label: "Widget", path: "/admin/widget", section: "Build" },
  { id: "tests", label: "Tests", path: "/admin/tests", section: "Build" },
  { id: "install", label: "Install", path: "/admin/install", section: "Go live" },
  { id: "providers", label: "Providers", path: "/admin/providers", section: "Settings" },
];

/** "How is it doing" screens: the Try it pane starts closed here. */
export const MONITOR_SCREENS: ReadonlySet<string> = new Set([
  "overview",
  "reports",
  "conversations",
  "gaps",
]);

/** "Set it up" screens: the header offers Publish here. */
export const BUILD_SCREENS: ReadonlySet<string> = new Set([
  "sources",
  "behaviour",
  "tools",
  "widget",
  "tests",
]);

export function matchScreen(
  pathname: string,
  navItems: readonly NavItem[] = NAV_ITEMS,
  defaultScreen?: string,
): string | null {
  const first = navItems[0];
  if (!first) return null;
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const fallback =
    defaultScreen !== undefined && navItems.some((item) => item.id === defaultScreen)
      ? defaultScreen
      : navItems.some((item) => item.id === "overview")
        ? "overview"
        : first.id;
  if (normalized === "/admin" || normalized === "/") return fallback;
  const found = navItems.find((item) => item.path === normalized);
  return found ? found.id : fallback;
}

/**
 * Moves to another admin path from inside a screen (screens are not handed
 * the shell's `navigate`). The shell listens for `popstate`, so it follows.
 */
export function navigateTo(path: string): void {
  if (`${window.location.pathname}${window.location.search}` !== path) {
    window.history.pushState(null, "", path);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Reads one query parameter of the current address. */
export function readQueryParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

/** Drops query parameters a screen has consumed, without a new history entry. */
export function clearQueryParams(): void {
  if (window.location.search !== "") {
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }
}

export function useRoute(
  navItems: readonly NavItem[] = NAV_ITEMS,
  defaultScreen?: string,
): {
  screen: string | null;
  navigate: (path: string) => void;
} {
  const [screen, setScreen] = useState<string | null>(() =>
    matchScreen(window.location.pathname, navItems, defaultScreen),
  );

  useEffect(() => {
    setScreen(matchScreen(window.location.pathname, navItems, defaultScreen));
    const onPopState = () => {
      setScreen(matchScreen(window.location.pathname, navItems, defaultScreen));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [navItems, defaultScreen]);

  const navigate = useCallback(
    (path: string) => {
      if (window.location.pathname !== path) {
        window.history.pushState(null, "", path);
      }
      setScreen(matchScreen(window.location.pathname, navItems, defaultScreen));
    },
    [navItems, defaultScreen],
  );

  return { screen, navigate };
}
