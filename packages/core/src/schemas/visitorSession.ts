import { Errors, fail, ok, type Result } from "../result.js";
import { SUPPORTED_CHAT_PROTOCOLS } from "./chat.js";
import { isPlainObject, readTrimmedString } from "./shared.js";

/**
 * Longest Turnstile token accepted, from the Siteverify documentation
 * ("Maximum length: 2048 characters").
 * Source (checked 2026-11-20):
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
export const MAX_TURNSTILE_TOKEN_LENGTH = 2048;

/** `POST /v1/session`: a Turnstile token exchanged for a visitor session. */
export interface VisitorSessionRequest {
  protocol: number;
  assistant: string;
  visitorId: string;
  token: string;
}

/** The engine's answer to a successful exchange. */
export interface VisitorSessionResponse {
  session: string;
  /** Milliseconds since the epoch; the widget renews the session before then. */
  expiresAt: number;
}

/**
 * Codes on a refused exchange.
 *
 * - `check_failed`: the token was refused, already used, or could not be checked.
 * - `check_config`: the engine's visitor check is set up wrongly.
 * - `session_cap`: too many sessions from this network in the last hour.
 */
export type VisitorSessionErrorCode = "check_failed" | "check_config" | "session_cap";

/** Validates an incoming `POST /v1/session` body. */
export function parseVisitorSessionRequest(value: unknown): Result<VisitorSessionRequest> {
  if (!isPlainObject(value)) return fail("body: must be a JSON object");
  const errors = new Errors();

  const protocol =
    typeof value.protocol === "number" && SUPPORTED_CHAT_PROTOCOLS.includes(value.protocol)
      ? value.protocol
      : null;
  if (protocol === null) errors.add("protocol", "must be a supported protocol version");

  const assistant = readTrimmedString(value.assistant, 4, 128);
  if (assistant === null || !assistant.startsWith("pk_") || /\s/.test(assistant)) {
    errors.add("assistant", "must be a public key starting with pk_");
  }

  const visitorId = readTrimmedString(value.visitorId, 1, 128);
  if (visitorId === null) errors.add("visitorId", "must be 1 to 128 characters");

  const token =
    typeof value.token === "string" &&
    value.token.length > 0 &&
    value.token.length <= MAX_TURNSTILE_TOKEN_LENGTH
      ? value.token
      : null;
  if (token === null) {
    errors.add("token", `must be 1 to ${MAX_TURNSTILE_TOKEN_LENGTH} characters`);
  }

  if (errors.failed || protocol === null || assistant === null || visitorId === null || !token) {
    return fail(...errors.list);
  }
  return ok({ protocol, assistant, visitorId, token });
}
