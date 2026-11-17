import type { MouseEvent, ReactNode } from "react";
import { navigateTo } from "../routing.js";

export interface ScreenLinkProps {
  /** An admin path, optionally with a query, e.g. `/admin/gaps`. */
  to: string;
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}

/**
 * A link to another admin screen. A plain click moves inside the app; a
 * modified click (new tab, new window) is left to the browser.
 */
export function ScreenLink({ to, children, className, "aria-label": ariaLabel }: ScreenLinkProps) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    navigateTo(to);
  }
  return (
    <a href={to} className={className} aria-label={ariaLabel} onClick={onClick}>
      {children}
    </a>
  );
}
