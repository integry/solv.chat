import type { PublicAssistant } from "../db/public.js";
import type { Limits } from "../seams/types.js";

export type CheckFailureReason = "origin" | "rate_limit" | "spend_cap";

export interface CheckFailure {
  reason: CheckFailureReason;
  message: string;
}

/**
 * Returns the request's `Origin` header when it matches the assistant's
 * `allowed_origins`, or `null` otherwise.
 */
export function matchedOrigin(
  assistant: Pick<PublicAssistant, "allowedOrigins">,
  request: Request,
): string | null {
  const origin = request.headers.get("origin");
  if (origin === null || !assistant.allowedOrigins.includes(origin)) {
    return null;
  }
  return origin;
}

/**
 * Returns CORS headers echoing the matched origin, never `*`.
 */
export function corsHeaders(origin: string | null): Record<string, string> {
  if (origin === null) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
  };
}

/**
 * Per-IP rate limit, then the daily spend cap. Returns on the first failure so
 * a rejected request costs nothing — no embedding, no model.
 */
export async function checkLimits(
  limits: Limits,
  assistant: Pick<PublicAssistant, "id" | "orgId">,
  request: Request,
): Promise<CheckFailure | null> {
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  // Rate limit and spend cap are one seam call: the hosted service replaces the
  // whole policy at once, which is what "Extension seams" intends.
  const decision = await limits.check(assistant.orgId, assistant.id, { kind: "chat", ip });
  if (!decision.ok) {
    return {
      reason: decision.reason,
      message:
        decision.reason === "rate_limit"
          ? "Too many questions just now. Please wait a moment."
          : "This assistant has reached its limit for today.",
    };
  }
  return null;
}

/**
 * Origin, then per-IP rate limit, then the daily spend cap. Returns on the
 * first failure so a rejected request costs nothing — no embedding, no model.
 */
export async function runPublicChecks(
  limits: Limits,
  assistant: Pick<PublicAssistant, "id" | "orgId" | "allowedOrigins">,
  request: Request,
): Promise<CheckFailure | null> {
  // A missing Origin is a failure, not a pass: browsers send it on cross-origin
  // POSTs, and treating absence as "fine" would hand anyone with curl a free
  // assistant.
  if (matchedOrigin(assistant, request) === null) {
    // One plain sentence for every reason, so the error does not tell a prober
    // which origins are configured.
    return { reason: "origin", message: "This assistant is not available on this page." };
  }
  return checkLimits(limits, assistant, request);
}
