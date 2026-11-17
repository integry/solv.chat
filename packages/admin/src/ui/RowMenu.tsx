import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { useOutsidePress } from "./focus.js";
import { Icon } from "./Icon.js";

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  /** `danger` marks a destructive item. */
  tone?: "default" | "danger";
  disabled?: boolean;
}

export interface RowMenuProps {
  /** Accessible name of the trigger, such as "More actions for Docs". */
  label: string;
  items: readonly RowMenuItem[];
  /** Visible trigger content; default a "⋯" icon (the label stays the accessible name). */
  trigger?: ReactNode;
  /** Which edge the menu lines up with; default `end`. */
  align?: "start" | "end";
  className?: string;
}

/**
 * A "more actions" button that opens a short menu. Arrow keys move, Enter
 * chooses, Escape closes and returns focus to the button.
 */
export function RowMenu({ label, items, trigger, align = "end", className }: RowMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useOutsidePress([buttonRef, menuRef], open, () => setOpen(false));

  function itemButtons(): HTMLButtonElement[] {
    return Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ??
        [],
    );
  }

  function openMenu(focus: "first" | "last") {
    setOpen(true);
    requestAnimationFrame(() => {
      const list = itemButtons();
      (focus === "first" ? list[0] : list[list.length - 1])?.focus();
    });
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const list = itemButtons();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      list[list.length - 1]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    }
  }

  return (
    <div className={className ? `row-menu ${className}` : "row-menu"}>
      <button
        ref={buttonRef}
        type="button"
        className={trigger === undefined ? "btn-icon" : "btn btn-secondary"}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu("first"))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openMenu("first");
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            openMenu("last");
          }
        }}
      >
        {trigger ?? <Icon name="more" />}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className={`row-menu-list row-menu-${align}`}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={item.tone === "danger" ? "row-menu-item row-menu-danger" : "row-menu-item"}
              disabled={item.disabled}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
