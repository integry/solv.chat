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

/**
 * Asks whether to leave the current screen, and calls `leave` to go ahead. To
 * stay, the caller calls `restore`, which also undoes a Back or Forward.
 */
export type ConfirmLeave = (leave: () => void) => void;

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

/** The current address within the app: path and query. */
function currentAddress(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** The path part of an address, without its query or fragment. */
function pathOf(address: string): string {
  return address.split(/[?#]/, 1)[0] ?? address;
}

/** The assistant an address names, if any. */
function assistantOf(search: string): string | null {
  return new URLSearchParams(search).get("assistant");
}

/**
 * Moves to another admin path from inside a screen (screens are not handed
 * the shell's `navigate`). The shell listens for `popstate`, so it follows.
 */
export function navigateTo(path: string): void {
  if (currentAddress() !== path) {
    const index = historyIndex(window.history.state) ?? 0;
    window.history.pushState(withHistoryIndex(null, index + 1), "", path);
  }
  // The state goes with the event, so the shell counts this entry as it does
  // a Back or Forward, and asks first when the move leaves unsaved edits.
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

/**
 * The address of one assistant's screen, e.g. its Gaps. It names the
 * assistant, so a link opened in a new tab (where the shell starts from the
 * address) shows that assistant rather than the first one. Organisation-wide
 * screens such as Providers need no assistant.
 */
export function assistantPath(path: string, assistantId: string): string {
  return `${path}?${new URLSearchParams({ assistant: assistantId }).toString()}`;
}

/**
 * The current address with `assistantId` as its assistant. An open
 * conversation (`id`) belongs to the assistant it was opened under, so it is
 * dropped; the rest of the query (a search, say) stays.
 */
export function withAssistant(assistantId: string): string {
  const params = new URLSearchParams(window.location.search);
  params.set("assistant", assistantId);
  params.delete("id");
  return `${window.location.pathname}?${params.toString()}`;
}

/** Reads one query parameter of the current address. */
export function readQueryParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

/**
 * Drops the named query parameters a screen has consumed, without a new
 * history entry. Others stay: `assistant` in particular, so a reload of the
 * address still shows the same assistant.
 */
export function dropQueryParams(names: readonly string[]): void {
  const params = new URLSearchParams(window.location.search);
  if (!names.some((name) => params.has(name))) return;
  for (const name of names) params.delete(name);
  const query = params.toString();
  const address = query === "" ? window.location.pathname : `${window.location.pathname}?${query}`;
  window.history.replaceState(window.history.state, "", address);
}

export function useRoute(
  navItems: readonly NavItem[] = NAV_ITEMS,
  defaultScreen?: string,
  confirmLeave?: ConfirmLeave,
): {
  screen: string | null;
  /**
   * The assistant the addresses on show have named, or null while none has.
   * It changes only once a move goes ahead, so a Back still waiting for an answer
   * does not switch the assistant early.
   */
  assistant: string | null;
  navigate: (path: string) => void;
  /**
   * Whether `path` leads to the screen on show. While a Back or Forward waits
   * for an answer, the address belongs to another screen.
   */
  shows: (path: string) => boolean;
  /**
   * Puts the address back on the entry of the screen on show, if a Back or
   * Forward that is no longer going ahead moved it. Otherwise does nothing.
   */
  restore: () => void;
} {
  const [screen, setScreen] = useState<string | null>(() =>
    matchScreen(window.location.pathname, navItems, defaultScreen),
  );
  const [assistant, setAssistant] = useState<string | null>(() =>
    assistantOf(window.location.search),
  );
  // The screen on show, the assistant its address names and the history entry
  // it belongs to. Back and Forward change the address before we hear about
  // them, so these are what "Stay here" returns to.
  const screenRef = useRef(screen);
  const assistantRef = useRef(assistant);
  const indexRef = useRef(0);
  const confirmRef = useRef(confirmLeave);
  confirmRef.current = confirmLeave;

  /** Shows the screen of the current address. */
  const showAddress = useCallback(() => {
    const next = matchScreen(window.location.pathname, navItems, defaultScreen);
    // An address naming no assistant (a bare screen path) keeps the one on show.
    const nextAssistant = assistantOf(window.location.search) ?? assistantRef.current;
    screenRef.current = next;
    assistantRef.current = nextAssistant;
    setScreen(next);
    setAssistant(nextAssistant);
  }, [navItems, defaultScreen]);

  useEffect(() => {
    const current = historyIndex(window.history.state);
    if (current === null) {
      window.history.replaceState(withHistoryIndex(window.history.state, indexRef.current), "");
    } else {
      indexRef.current = current;
    }
    showAddress();

    const onPopState = (event: PopStateEvent) => {
      const next = matchScreen(window.location.pathname, navItems, defaultScreen);
      const nextAssistant = assistantOf(window.location.search);
      const arrived = historyIndex(event.state);
      const commit = () => {
        // Read the address again: it may have moved on while the owner decided.
        const index = historyIndex(window.history.state);
        if (index !== null) indexRef.current = index;
        showAddress();
      };
      // The same screen of the same assistant (a new query, say) leaves nothing
      // behind. An address naming no assistant keeps the one on show.
      const samePlace =
        next === screenRef.current &&
        (nextAssistant === null || nextAssistant === assistantRef.current);
      if (samePlace || !confirmRef.current) {
        if (arrived !== null) indexRef.current = arrived;
        showAddress();
        return;
      }
      confirmRef.current(commit);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [navItems, defaultScreen, showAddress]);

  // The same move as a screen's: the query is compared too, and `popstate`
  // tells screens that follow the address (an open conversation).
  const navigate = useCallback(
    (path: string) => {
      // Count from the entry the browser is on. A Back or Forward still waiting
      // for an answer has moved it away from the screen on show.
      const current = historyIndex(window.history.state) ?? indexRef.current;
      if (currentAddress() !== path) {
        indexRef.current = current + 1;
        window.history.pushState(withHistoryIndex(null, indexRef.current), "", path);
      } else {
        // Already at that address (a waiting Back or Forward went there): use its entry.
        indexRef.current = current;
      }
      showAddress();
      // The router has already moved, so its own listener sees the same place.
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    },
    [showAddress],
  );

  const shows = useCallback(
    (path: string) => matchScreen(pathOf(path), navItems, defaultScreen) === screenRef.current,
    [navItems, defaultScreen],
  );

  const restore = useCallback(() => {
    const index = historyIndex(window.history.state);
    const committed = indexRef.current;
    if (index !== null) {
      // Step back to the entry the owner is still on.
      if (index !== committed) window.history.go(committed - index);
      return;
    }
    if (matchScreen(window.location.pathname, navItems, defaultScreen) === screenRef.current) {
      return;
    }
    // An entry we did not create: put the current screen's address back.
    const path = navItems.find((item) => item.id === screenRef.current)?.path;
    if (path) {
      const address =
        assistantRef.current === null ? path : assistantPath(path, assistantRef.current);
      window.history.pushState(withHistoryIndex(null, committed + 1), "", address);
      indexRef.current = committed + 1;
    }
  }, [navItems, defaultScreen]);

  return { screen, assistant, navigate, shows, restore };
}

/** How a screen moves to another screen: through the shell, so its checks apply. */
export interface AdminNavigation {
  navigate: (path: string) => void;
  /** The path of a visible screen, or null when it is hidden or unknown. */
  pathFor: (id: string) => string | null;
}

export const AdminNavigationContext = createContext<AdminNavigation | null>(null);

const FALLBACK_NAVIGATION: AdminNavigation = {
  // Outside the shell (a screen on its own) there is no leave check to run.
  navigate: navigateTo,
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
