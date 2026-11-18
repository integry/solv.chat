import { Skeleton } from "../ui/Skeleton.js";

/**
 * What Overview and Reports show while their figures load: four figure cards
 * and a panel below, the shape both screens have.
 */
export function StatsSkeleton({ label }: { label: string }) {
  return (
    <div className="stack" aria-busy="true">
      <Skeleton label={label} lines={1} className="skeleton-heading" />
      <div className="overview-grid overview-grid-4" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="source-card stat-card">
            <span className="skeleton-line" style={{ width: "50%" }} />
            <span className="skeleton-line skeleton-line-lg" style={{ width: "35%" }} />
            <span className="skeleton-line" />
          </div>
        ))}
      </div>
      <div className="source-card" aria-hidden="true">
        <span className="skeleton-block" />
      </div>
    </div>
  );
}
