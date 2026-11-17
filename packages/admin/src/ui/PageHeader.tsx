import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: ReactNode;
  /** One sentence under the title. */
  description?: ReactNode;
  /** Buttons and badges shown at the right (they wrap under the title on narrow screens). */
  actions?: ReactNode;
  /** Id for the `<h1>`, to name a region or form after it. */
  titleId?: string;
}

/** The title row at the top of every admin screen. */
export function PageHeader({ title, description, actions, titleId }: PageHeaderProps) {
  return (
    <div className="screen-header">
      <div className="screen-header-text">
        <h1 id={titleId}>{title}</h1>
        {description !== undefined && description !== null && (
          <p className="muted">{description}</p>
        )}
      </div>
      {actions !== undefined && actions !== null && <div className="screen-actions">{actions}</div>}
    </div>
  );
}
