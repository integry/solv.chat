/** Number formats shared by Overview and Reports: one figure, written one way. */

import type { ResponseTimeStatus } from "../api/types.js";

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

/** A wait in seconds, written for an owner: "0.8 s", "12 s", "1 min 5 s". */
export function formatDuration(ms: number): string {
  if (ms < 9_950) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const rest = seconds % 60;
  return rest === 0 ? `${seconds / 60} min` : `${Math.floor(seconds / 60)} min ${rest} s`;
}

/**
 * A response-time figure, or what stands in for it when there is no honest
 * number: no answers at all, or mostly answers from before times were kept.
 */
export function formatResponseTime(ms: number | null, status: ResponseTimeStatus): string {
  if (status === "no_answers") return "No answers";
  if (status === "mostly_untimed" || ms === null) return "Not measured";
  return formatDuration(ms);
}

/** Why a response-time figure has no number, in words; `null` when it has one. */
export function responseTimeNote(status: ResponseTimeStatus): string | null {
  if (status === "no_answers") return "No visitor got an answer in this period.";
  if (status === "mostly_untimed") {
    return "Most answers in this period are from before answer times were recorded, so a number would mislead.";
  }
  return null;
}

/**
 * The change in a wait against the previous period, compared as it is shown,
 * so two figures that read the same are "Same". Slower is "up": more time.
 */
export function durationChange(
  current: number | null,
  previous: number | null,
  days: number,
): Change | undefined {
  if (current === null) return undefined;
  if (previous === null) {
    return { direction: "same", text: `No figure for the ${days} days before` };
  }
  const shown = (ms: number) => formatDuration(ms);
  if (shown(current) === shown(previous)) {
    return { direction: "same", text: `Same as the ${days} days before` };
  }
  // To the tenth of a second the figures are shown in, so the difference
  // never reads "0.0 s" between two figures that read differently.
  const tenths = (ms: number) => Math.round(ms / 100) * 100;
  const diff = Math.max(100, Math.abs(tenths(current) - tenths(previous)));
  return {
    direction: current > previous ? "up" : "down",
    text: `${formatDuration(diff)} ${current > previous ? "slower" : "faster"} than the ${days} days before`,
  };
}
