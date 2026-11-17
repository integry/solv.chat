/** Number formats shared by Overview and Reports: one figure, written one way. */

export type CostUnit = "usd" | "credits";

export function formatCost(costMicros: number, unit: CostUnit = "usd"): string {
  const amount = costMicros / 1_000_000;
  if (unit === "credits") {
    if (costMicros > 0 && amount < 0.01) return "< 0.01 credits";
    return `${amount.toFixed(2)} credits`;
  }
  if (costMicros > 0 && amount < 0.01) return "< $0.01";
  return `$${amount.toFixed(2)}`;
}

export function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function formatTimes(count: number): string {
  return count === 1 ? "1 time" : `${count} times`;
}

export type ChangeDirection = "up" | "down" | "same";

export interface Change {
  direction: ChangeDirection;
  /** "3 more than the 7 days before", "5 points lower…", "Same as the 7 days before". */
  text: string;
}

/** The change in a count against the previous period, in words. */
export function countChange(current: number, previous: number, days: number): Change {
  const diff = current - previous;
  if (diff === 0) return { direction: "same", text: `Same as the ${days} days before` };
  return {
    direction: diff > 0 ? "up" : "down",
    text: `${Math.abs(diff)} ${diff > 0 ? "more" : "fewer"} than the ${days} days before`,
  };
}

/** The change in a share, in percentage points (rounded as the share is shown). */
export function shareChange(current: number, previous: number, days: number): Change {
  const diff = Math.round(current * 100) - Math.round(previous * 100);
  if (diff === 0) return { direction: "same", text: `Same as the ${days} days before` };
  const points = Math.abs(diff) === 1 ? "point" : "points";
  return {
    direction: diff > 0 ? "up" : "down",
    text: `${Math.abs(diff)} ${points} ${diff > 0 ? "higher" : "lower"} than the ${days} days before`,
  };
}

/** The previous period's cost, so the owner compares two amounts rather than a ratio. */
export function costChange(
  current: number,
  previous: number,
  days: number,
  unit: CostUnit = "usd",
): Change {
  const direction: ChangeDirection =
    current === previous ? "same" : current > previous ? "up" : "down";
  return { direction, text: `${formatCost(previous, unit)} in the ${days} days before` };
}
