import { type ReactNode, useId } from "react";
import { NAV_GROUPS, NAV_ITEMS, type NavItem, navItemAddress } from "../routing.js";
import { Icon, type IconName } from "../ui/Icon.js";

export interface NavigationProps {
  current: string | null;
  onNavigate: (path: string) => void;
  items?: readonly NavItem[];
  /** The assistant on show: assistant screens' links name it. */
  assistantId?: string | null;
}

const BUILTIN_ICONS: Record<string, IconName> = {
  overview: "overview",
  reports: "reports",
  conversations: "conversations",
  gaps: "gaps",
  sources: "sources",
  behaviour: "behaviour",
  tools: "tools",
  widget: "widget",
  tests: "tests",
  install: "install",
  providers: "providers",
  "operator-access": "tools",
};

const BUILTIN_IDS = new Set(NAV_ITEMS.map((item) => item.id));

function itemIcon(item: NavItem): ReactNode {
  if (BUILTIN_IDS.has(item.id)) {
    const name = BUILTIN_ICONS[item.id];
    return name ? <Icon name={name} /> : null;
  }
  return item.icon ?? null;
}

function renderNavItem(
  item: NavItem,
  current: string | null,
  onNavigate: (path: string) => void,
  assistantId: string | null,
) {
  const active = item.id === current;
  const icon = itemIcon(item);
  const address = navItemAddress(item, assistantId);
  return (
    <li key={item.id}>
      <a
        href={address}
        className={active ? "nav-link nav-link-active" : "nav-link"}
        aria-current={active ? "page" : undefined}
        onClick={(event) => {
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
          onNavigate(address);
        }}
      >
        {icon !== null && (
          <span className="nav-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        {item.label}
      </a>
    </li>
  );
}

interface Group {
  label: string | null;
  items: NavItem[];
}

/** Built-in groups first (in their fixed order), then host sections in the order they appear. */
export function groupNavItems(items: readonly NavItem[]): Group[] {
  const builtinOrder = new Map<string, number>(NAV_GROUPS.map((label, i) => [label, i]));
  const groups = new Map<string, Group>();
  const ungrouped: NavItem[] = [];
  for (const item of items) {
    if (!item.section) {
      ungrouped.push(item);
      continue;
    }
    let group = groups.get(item.section);
    if (!group) {
      group = { label: item.section, items: [] };
      groups.set(item.section, group);
    }
    group.items.push(item);
  }
  const all = [...groups.values()];
  const builtin = all
    .filter((g) => g.label !== null && builtinOrder.has(g.label))
    .sort(
      (a, b) => (builtinOrder.get(a.label ?? "") ?? 0) - (builtinOrder.get(b.label ?? "") ?? 0),
    );
  const host = all.filter((g) => g.label === null || !builtinOrder.has(g.label));
  const result = [...builtin, ...host];
  if (ungrouped.length > 0) result.push({ label: null, items: ungrouped });
  return result;
}

/**
 * Primary admin navigation: Monitor, Build, Go live and Settings, then any
 * host sections.
 */
export function Navigation({
  current,
  onNavigate,
  items = NAV_ITEMS,
  assistantId = null,
}: NavigationProps) {
  const baseId = useId();
  const groups = groupNavItems(items);

  return (
    <nav className="nav" aria-label="Primary">
      {groups.map((group, index) => {
        const headingId = `${baseId}-group-${index}`;
        return (
          <div key={group.label ?? `ungrouped-${index}`} className="nav-section">
            {group.label !== null && (
              <h2 id={headingId} className="nav-section-label">
                {group.label}
              </h2>
            )}
            <ul className="nav-list" aria-labelledby={group.label !== null ? headingId : undefined}>
              {group.items.map((item) => renderNavItem(item, current, onNavigate, assistantId))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
