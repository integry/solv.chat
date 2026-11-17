import type { ReactNode } from "react";

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

export interface StatusBadgeProps {
  tone?: StatusTone;
  children: ReactNode;
  /** Optional longer explanation, shown as a tooltip. */
  title?: string;
  className?: string;
}

/**
 * A small pill for a status word ("Live", "Failed"). The word carries the
 * meaning; colour and the dot only repeat it.
 */
export function StatusBadge({ tone = "neutral", children, title, className }: StatusBadgeProps) {
  return (
    <span
      className={`badge status-badge badge-tone-${tone}${className ? ` ${className}` : ""}`}
      title={title}
    >
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}
