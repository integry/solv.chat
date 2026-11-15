import { NAV_ITEMS, type NavItem, type ScreenId } from "../routing.js";

export interface NavigationProps {
  current: ScreenId;
  onNavigate: (path: string) => void;
}

function renderNavItem(item: NavItem, current: ScreenId, onNavigate: (path: string) => void) {
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
 * Primary admin navigation, built from NAV_ITEMS.
 */
export function Navigation({ current, onNavigate }: NavigationProps) {
  const mainItems = NAV_ITEMS.filter((item) => !item.section);
  const settingsItems = NAV_ITEMS.filter((item) => item.section === "Settings");

  return (
    <nav className="nav" aria-label="Primary">
      <ul className="nav-list">
        {mainItems.map((item) => renderNavItem(item, current, onNavigate))}
      </ul>
      {settingsItems.length > 0 && (
        <div className="nav-section">
          <div className="nav-section-label">Settings</div>
          <ul className="nav-list">
            {settingsItems.map((item) => renderNavItem(item, current, onNavigate))}
          </ul>
        </div>
      )}
    </nav>
  );
}
