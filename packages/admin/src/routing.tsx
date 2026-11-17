import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

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

/** How a screen moves to another screen: through the shell, so its checks apply. */
export interface AdminNavigation {
  navigate: (path: string) => void;
  /** The path of a visible screen, or null when it is hidden or unknown. */
  pathFor: (id: string) => string | null;
}

export const AdminNavigationContext = createContext<AdminNavigation | null>(null);

const FALLBACK_NAVIGATION: AdminNavigation = {
  navigate: (path) => window.location.assign(path),
  pathFor: (id) => NAV_ITEMS.find((item) => item.id === id)?.path ?? null,
};

export function useAdminNavigation(): AdminNavigation {
  return useContext(AdminNavigationContext) ?? FALLBACK_NAVIGATION;
}

/**
 * A link to another admin screen. Renders its children as plain text when
 * that screen is hidden, so a screen never points at something missing.
 */
export function ScreenLink({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  const { navigate, pathFor } = useAdminNavigation();
  const path = pathFor(to);
  if (path === null) return <>{children}</>;
  return (
    <a
      href={path}
      className={className}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        ) {
          return;
        }
        event.preventDefault();
        navigate(path);
      }}
    >
      {children}
    </a>
  );
}
