import { useCallback, useEffect, useState } from "react";

export type ScreenId =
  | "overview"
  | "conversations"
  | "gaps"
  | "sources"
  | "behaviour"
  | "widget"
  | "install";

export interface NavItem {
  id: ScreenId;
  label: string;
  path: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "overview", label: "Overview", path: "/admin/overview" },
  { id: "conversations", label: "Conversations", path: "/admin/conversations" },
  { id: "gaps", label: "Gaps", path: "/admin/gaps" },
  { id: "sources", label: "Sources", path: "/admin/sources" },
  { id: "behaviour", label: "Behaviour", path: "/admin/behaviour" },
  { id: "widget", label: "Widget", path: "/admin/widget" },
  { id: "install", label: "Install", path: "/admin/install" },
];

export function matchScreen(pathname: string): ScreenId {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/admin" || normalized === "/") return "overview";
  const found = NAV_ITEMS.find((item) => item.path === normalized);
  return found ? found.id : "overview";
}

export function useRoute(): { screen: ScreenId; navigate: (path: string) => void } {
  const [screen, setScreen] = useState<ScreenId>(() => matchScreen(window.location.pathname));

  useEffect(() => {
    const onPopState = () => {
      setScreen(matchScreen(window.location.pathname));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((path: string) => {
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
    setScreen(matchScreen(path));
  }, []);

  return { screen, navigate };
}
