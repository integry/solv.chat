import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

export interface EmptyStateProps {
  title: ReactNode;
  /** One sentence: what goes here and how to get it. */
  description?: ReactNode;
  /** A built-in icon name or your own decorative element. Default: an inbox. */
  icon?: IconName | ReactNode;
  /** Usually one primary button. */
  action?: ReactNode;
  /** Heading level for the title; default 2 (screens own the `<h1>`). */
  headingLevel?: 2 | 3 | 4;
}

/** Shown in place of a list or table that has nothing in it yet. */
export function EmptyState({
  title,
  description,
  icon = "inbox",
  action,
  headingLevel = 2,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden="true">
        {typeof icon === "string" ? <Icon name={icon as IconName} size={24} /> : icon}
      </div>
      <Heading className="empty-state-title">{title}</Heading>
      {description !== undefined && description !== null && (
        <p className="empty-state-text">{description}</p>
      )}
      {action !== undefined && action !== null && (
        <div className="empty-state-action">{action}</div>
      )}
    </div>
  );
}
