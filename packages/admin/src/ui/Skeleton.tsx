export interface SkeletonProps {
  /** Number of grey lines; default 3. */
  lines?: number;
  /** Read out instead of the shapes; default "Loading…". */
  label?: string;
  className?: string;
}

/** Placeholder lines while content loads. Announced once as `label`. */
export function Skeleton({ lines = 3, label = "Loading…", className }: SkeletonProps) {
  const count = Math.max(1, Math.floor(lines));
  return (
    <div className={className ? `skeleton ${className}` : "skeleton"} role="status">
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, i) => (
        <span
          // Static placeholders: the index is the identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders never reorder
          key={i}
          className="skeleton-line"
          aria-hidden="true"
          style={{ width: i === count - 1 && count > 1 ? "60%" : "100%" }}
        />
      ))}
    </div>
  );
}
