import { NAV_ITEMS, type NavItem } from "../routing.js";

export interface NavigationProps {
  current: string;
  onNavigate: (path: string) => void;
  items?: readonly NavItem[];
}

function renderNavItem(item: NavItem, current: string, onNavigate: (path: string) => void) {
  const active = item.id === current;
  return (
    <li key={item.id}>
      <a
        href={item.path}
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
          onNavigate(item.path);
        }}
      >
        {item.label}
      </a>
    </li>
  );
}

/**
 * Primary admin navigation, built from the resolved nav items.
 */
export function Navigation({ current, onNavigate, items = NAV_ITEMS }: NavigationProps) {
  const mainItems = items.filter((item) => !item.section);
  const sections: Array<{ label: string; items: NavItem[] }> = [];
  const sectionMap = new Map<string, NavItem[]>();

  for (const item of items) {
    if (!item.section) continue;
    let list = sectionMap.get(item.section);
    if (!list) {
      list = [];
      sectionMap.set(item.section, list);
      sections.push({ label: item.section, items: list });
    }
    list.push(item);
  }

  return (
    <nav className="nav" aria-label="Primary">
      <ul className="nav-list">
        {mainItems.map((item) => renderNavItem(item, current, onNavigate))}
      </ul>
      {sections.map((section) => (
        <div key={section.label} className="nav-section">
          <div className="nav-section-label">{section.label}</div>
          <ul className="nav-list">
            {section.items.map((item) => renderNavItem(item, current, onNavigate))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
