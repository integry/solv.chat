import type { ReactNode } from "react";

export interface DataTableColumn<Row> {
  /** Stable key for the column. */
  key: string;
  /** Column heading; also the row label when the table stacks on narrow screens. */
  header: string;
  render: (row: Row) => ReactNode;
  /** Right-aligns numbers on wide screens. */
  align?: "start" | "end";
  /** Hides the header text visually (for an actions column); the label still names the cells. */
  hideHeader?: boolean;
}

export interface DataTableProps<Row> {
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Describes the table for assistive technology. */
  caption: string;
  /** Shows the caption on screen; default false. */
  showCaption?: boolean;
  /** Shown instead of the table when there are no rows. */
  empty?: ReactNode;
  /** Extra class on the table, for screen-specific column widths. */
  className?: string;
}

/**
 * A plain table that stacks into labelled rows under 600px, so nothing
 * scrolls sideways on a phone.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  showCaption = false,
  empty,
  className,
}: DataTableProps<Row>) {
  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;
  return (
    <table className={className ? `data-table ${className}` : "data-table"}>
      <caption className={showCaption ? "data-table-caption" : "sr-only"}>{caption}</caption>
      <thead>
        <tr>
          {columns.map((col) => (
            <th
              key={col.key}
              scope="col"
              className={col.align === "end" ? "data-table-end" : undefined}
            >
              {col.hideHeader ? <span className="sr-only">{col.header}</span> : col.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((col) => (
              <td
                key={col.key}
                data-label={col.hideHeader ? undefined : col.header}
                className={col.align === "end" ? "data-table-end" : undefined}
              >
                {col.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
