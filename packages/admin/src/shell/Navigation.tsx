import { NAV_ITEMS, type ScreenId } from "../routing.js";

export interface NavigationProps {
  current: ScreenId;
  onNavigate: (path: string) => void;
}

/** Primary admin navigation, built from NAV_ITEMS. */
export function Navigation({ current, onNavigate }: NavigationProps) {
  return (
    <nav className="nav" aria-label="Primary">
      <ul className="nav-list">
        {NAV_ITEMS.map((item) => {
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
        })}
      </ul>
    </nav>
  );
}
