import type { MouseEvent, ReactNode } from "react";
import { useAdminNavigation } from "../routing.js";

export interface ScreenLinkProps {
  /** An admin path, optionally with a query, e.g. `/admin/gaps`. */
  to: string;
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}

/**
 * A link to another admin screen. A plain click moves inside the app; a
 * modified click (new tab, new window) is left to the browser. The move goes
 * through the shell, so leaving unsaved edits asks first.
 */
export function ScreenLink({ to, children, className, "aria-label": ariaLabel }: ScreenLinkProps) {
  const { navigate } = useAdminNavigation();
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    navigate(to);
  }
  return (
    <a href={to} className={className} aria-label={ariaLabel} onClick={onClick}>
      {children}
    </a>
  );
}
