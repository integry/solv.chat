import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
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

/** Asks whether to leave the current screen; calls exactly one of the two. */
export type ConfirmLeave = (leave: () => void, stay: () => void) => void;

const HISTORY_INDEX_KEY = "solvAdminIndex";

function historyIndex(state: unknown): number | null {
  if (state === null || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[HISTORY_INDEX_KEY];
  return typeof value === "number" ? value : null;
}

function withHistoryIndex(state: unknown, index: number): Record<string, unknown> {
  const base =
    state !== null && typeof state === "object" ? (state as Record<string, unknown>) : {};
  return { ...base, [HISTORY_INDEX_KEY]: index };
}

export function useRoute(
  navItems: readonly NavItem[] = NAV_ITEMS,
  defaultScreen?: string,
  confirmLeave?: ConfirmLeave,
): {
  screen: string | null;
  navigate: (path: string) => void;
} {
  const [screen, setScreen] = useState<string | null>(() =>
    matchScreen(window.location.pathname, navItems, defaultScreen),
  );
  // The screen on show and the history entry it belongs to. Back and Forward
  // change the address before we hear about them, so these are what "Stay
  // here" returns to.
  const screenRef = useRef(screen);
  const indexRef = useRef(0);
  const confirmRef = useRef(confirmLeave);
  confirmRef.current = confirmLeave;

  const show = useCallback((next: string | null) => {
    screenRef.current = next;
    setScreen(next);
  }, []);

  useEffect(() => {
    const current = historyIndex(window.history.state);
    if (current === null) {
      window.history.replaceState(withHistoryIndex(window.history.state, indexRef.current), "");
    } else {
      indexRef.current = current;
    }
    show(matchScreen(window.location.pathname, navItems, defaultScreen));

    const onPopState = (event: PopStateEvent) => {
      const next = matchScreen(window.location.pathname, navItems, defaultScreen);
      const arrived = historyIndex(event.state);
      const commit = () => {
        // Read the address again: it may have moved on while the owner decided.
        const index = historyIndex(window.history.state);
        if (index !== null) indexRef.current = index;
        show(matchScreen(window.location.pathname, navItems, defaultScreen));
      };
      if (next === screenRef.current || !confirmRef.current) {
        if (arrived !== null) indexRef.current = arrived;
        show(next);
        return;
      }
      confirmRef.current(commit, () => {
        const index = historyIndex(window.history.state);
        const committed = indexRef.current;
        if (index !== null && index !== committed) {
          // Step back to the entry the owner is still on.
          window.history.go(committed - index);
        } else if (index === null) {
          // An entry we did not create: put the current screen's address back.
          const path = navItems.find((item) => item.id === screenRef.current)?.path;
          if (path) {
            window.history.pushState(withHistoryIndex(null, committed + 1), "", path);
            indexRef.current = committed + 1;
          }
        }
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [navItems, defaultScreen, show]);

  const navigate = useCallback(
    (path: string) => {
      if (window.location.pathname !== path) {
        indexRef.current += 1;
        window.history.pushState(withHistoryIndex(null, indexRef.current), "", path);
      }
      show(matchScreen(window.location.pathname, navItems, defaultScreen));
    },
    [navItems, defaultScreen, show],
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
