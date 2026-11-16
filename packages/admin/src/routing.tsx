import { useCallback, useEffect, useState } from "react";

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
  section?: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "overview", label: "Overview", path: "/admin/overview" },
  { id: "reports", label: "Reports", path: "/admin/reports" },
  { id: "conversations", label: "Conversations", path: "/admin/conversations" },
  { id: "gaps", label: "Gaps", path: "/admin/gaps" },
  { id: "sources", label: "Sources", path: "/admin/sources" },
  { id: "tools", label: "Tools", path: "/admin/tools" },
  { id: "behaviour", label: "Behaviour", path: "/admin/behaviour" },
  { id: "widget", label: "Widget", path: "/admin/widget" },
  { id: "tests", label: "Tests", path: "/admin/tests" },
  { id: "install", label: "Install", path: "/admin/install" },
  { id: "providers", label: "Providers", path: "/admin/providers", section: "Settings" },
];

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
