import type { ComponentType } from "react";
import { apiFetch, deleteJson, getJson, patchJson, postJson, putJson } from "./api/client.js";
import type { Assistant } from "./api/types.js";
import { useResource } from "./api/useResource.js";
import { type BuiltinScreenId, NAV_ITEMS, type NavItem, type ScreenId } from "./routing.js";

/** Same-origin API helpers passed to extra admin screens. */
export interface AdminApiHelpers {
  apiFetch: typeof apiFetch;
  getJson: typeof getJson;
  postJson: typeof postJson;
  putJson: typeof putJson;
  patchJson: typeof patchJson;
  deleteJson: typeof deleteJson;
  useResource: typeof useResource;
}

export const ADMIN_API_HELPERS: AdminApiHelpers = {
  apiFetch,
  getJson,
  postJson,
  putJson,
  patchJson,
  deleteJson,
  useResource,
};

/** Props passed to every extra screen component rendered in the admin main area. */
export interface ExtraScreenProps {
  /** Currently selected assistant, or null if none is selected or still loading. */
  assistant: Assistant | null;
  /** ID of the currently selected assistant, or null. */
  assistantId: string | null;
  /** Same-origin API helpers shared with built-in screens. */
  api: AdminApiHelpers;
}

/** Props passed to the host components rendered in the admin top bar. */
export interface HeaderSlotProps {
  /** Same-origin API helpers shared with built-in screens. */
  api: AdminApiHelpers;
}

/** Navigation item appended to the admin sidebar by a host. */
export interface ExtraNavItem {
  id: string;
  label: string;
  path: string;
  section?: string;
  /**
   * Whether the screen is about the selected assistant. Default `true`. When
   * `false`, the assistant switcher, "New assistant" and the Try it pane are
   * hidden on this screen, and it renders even when no assistant exists.
   */
  assistantScoped?: boolean;
}

/** Props passed to the sign-in component when the API returns 401. */
export interface SignInProps {
  onSignedIn: () => void;
}

/** Options accepted by `mountAdmin(root, options)`. */
export interface MountAdminOptions {
  extraNavItems?: readonly ExtraNavItem[];
  extraScreens?: Readonly<Record<string, ComponentType<ExtraScreenProps>>>;
  signIn?: ComponentType<SignInProps>;
  onSignOut?: () => void | Promise<void>;
  hideScreens?: readonly BuiltinScreenId[];
  /** Rendered in the top bar right after the product name. */
  headerStart?: ComponentType<HeaderSlotProps>;
  /** Rendered in the top bar right before the Sign out button. */
  headerEnd?: ComponentType<HeaderSlotProps>;
  /**
   * Screen `/admin/` (and any unknown admin path) lands on: a built-in screen
   * id or the id of one of `extraNavItems`. Default: the built-in Overview.
   */
  defaultScreen?: ScreenId | (string & {});
}

export interface ResolvedAdminConfig {
  navItems: readonly NavItem[];
  extraScreens: Readonly<Record<string, ComponentType<ExtraScreenProps>>>;
  extraScreenIds: ReadonlySet<string>;
  signIn: ComponentType<SignInProps> | undefined;
  onSignOut: (() => void | Promise<void>) | undefined;
  /** Extra screen ids registered with `assistantScoped: false`. */
  unscopedScreenIds: ReadonlySet<string>;
  headerStart: ComponentType<HeaderSlotProps> | undefined;
  headerEnd: ComponentType<HeaderSlotProps> | undefined;
  /** Validated landing screen id, or undefined for the default fallback. */
  defaultScreen: string | undefined;
}

const BUILTIN_IDS = new Set<string>(NAV_ITEMS.map((item) => item.id));
const BUILTIN_PATHS = new Set<string>(NAV_ITEMS.map((item) => item.path));

function normalizeAdminPath(path: string, id: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(
      `Extra admin nav item "${id}" must have a path under "/admin/" (got "${path}").`,
    );
  }
  if (path.includes("?") || path.includes("#")) {
    throw new Error(
      `Extra admin nav item "${id}" path must not include a query string or fragment (got "${path}").`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(path, "http://localhost");
  } catch {
    throw new Error(
      `Extra admin nav item "${id}" must have a valid path under "/admin/" (got "${path}").`,
    );
  }
  const withoutTrailingSlash = path.replace(/\/+$/, "") || "/";
  const canonicalPathname = parsed.pathname.replace(/\/+$/, "") || "/";
  if (parsed.origin !== "http://localhost" || canonicalPathname !== withoutTrailingSlash) {
    throw new Error(
      `Extra admin nav item "${id}" must use a canonical path under "/admin/" (got "${path}").`,
    );
  }
  return canonicalPathname;
}

/**
 * Validates extension options and resolves the effective navigation and screen
 * configuration. Throws synchronously if an extra item clashes with a built-in
 * id or route, or is otherwise invalid.
 */
export function resolveAdminConfig(options?: MountAdminOptions): ResolvedAdminConfig {
  const extraScreens = options?.extraScreens ?? {};
  const extraNavItems = options?.extraNavItems ?? [];
  const hideSet = new Set<string>(options?.hideScreens ?? []);

  const seenExtraIds = new Set<string>();
  const seenExtraPaths = new Set<string>();
  const resolvedExtraNavItems: NavItem[] = [];
  const unscopedScreenIds = new Set<string>();

  for (const item of extraNavItems) {
    const id = item.id.trim();
    if (!id) {
      throw new Error("Extra admin nav item id must be a non-empty string.");
    }
    if (BUILTIN_IDS.has(id)) {
      throw new Error(
        `Cannot register extra admin screen "${id}": clashes with a built-in screen id.`,
      );
    }
    if (seenExtraIds.has(id)) {
      throw new Error(`Duplicate extra admin screen id "${id}".`);
    }
    seenExtraIds.add(id);

    const normalizedPath = normalizeAdminPath(item.path, id);
    if (!normalizedPath.startsWith("/admin/")) {
      throw new Error(
        `Extra admin nav item "${id}" must have a path under "/admin/" (got "${item.path}").`,
      );
    }
    if (BUILTIN_PATHS.has(normalizedPath)) {
      throw new Error(
        `Cannot register extra admin screen "${id}" at path "${normalizedPath}": clashes with a built-in route.`,
      );
    }
    if (seenExtraPaths.has(normalizedPath)) {
      throw new Error(`Duplicate extra admin route path "${normalizedPath}".`);
    }
    seenExtraPaths.add(normalizedPath);

    if (!extraScreens[id]) {
      throw new Error(`Extra admin nav item "${id}" has no matching component in extraScreens.`);
    }

    if (item.assistantScoped === false) {
      unscopedScreenIds.add(id);
    }

    const section = item.section?.trim();
    resolvedExtraNavItems.push({
      id,
      label: item.label,
      path: normalizedPath,
      ...(section ? { section } : {}),
    });
  }

  for (const id of Object.keys(extraScreens)) {
    if (BUILTIN_IDS.has(id)) {
      throw new Error(`Cannot override built-in admin screen "${id}" in extraScreens.`);
    }
  }

  const visibleBuiltinNavItems = NAV_ITEMS.filter((item) => !hideSet.has(item.id));
  const navItems = [...visibleBuiltinNavItems, ...resolvedExtraNavItems];

  const defaultScreen = options?.defaultScreen?.trim();
  if (options?.defaultScreen !== undefined && !navItems.some((item) => item.id === defaultScreen)) {
    throw new Error(
      `defaultScreen "${options.defaultScreen}" is not a visible built-in screen or extra nav item id.`,
    );
  }

  return {
    navItems,
    extraScreens,
    extraScreenIds: seenExtraIds,
    signIn: options?.signIn,
    onSignOut: options?.onSignOut,
    unscopedScreenIds,
    headerStart: options?.headerStart,
    headerEnd: options?.headerEnd,
    defaultScreen: defaultScreen || undefined,
  };
}
