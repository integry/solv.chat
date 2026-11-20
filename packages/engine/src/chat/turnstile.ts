// Cloudflare Turnstile server-side validation.
//
// Every fact here comes from Cloudflare's documentation (checked 2026-11-20):
// - Siteverify endpoint, parameters (secret, response, remoteip), response
//   fields (success, hostname, action, error-codes), 300-second token
//   lifetime, single use with eventually consistent reuse detection, and
//   "set reasonable timeouts":
//   https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
// - Test secret keys, the dummy token, and that a test secret's success
//   response always carries hostname "example.com" and no action:
//   https://developers.cloudflare.com/turnstile/troubleshooting/testing/
// - `action` is at most 32 characters of letters, digits, `_` and `-`;
//   `cData` ("customer data", the `data-cdata` attribute) is at most 255 of
//   the same characters and is returned upon validation:
//   https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/
// - Siteverify returns that value as `cdata` ("Custom data payload from
//   client-side"), on the server-side validation page above. A test
//   secret's response carries no `cdata` (testing page above).

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** How long a Turnstile token is valid after it was issued (documented: 300 seconds). */
export const TURNSTILE_TOKEN_TTL_MS = 300_000;

/**
 * How long the engine waits for Siteverify. The docs ask for a reasonable
 * timeout and give 10 seconds in an example; 5 keeps the visitor's wait on
 * a stalled exchange short, and a timeout is a refusal, never a pass.
 */
export const SITEVERIFY_TIMEOUT_MS = 5_000;

/** The action the check frame renders with, and Siteverify must echo back. */
export const TURNSTILE_ACTION = "solv-chat";

const encoder = new TextEncoder();

/**
 * The `cData` the check frame renders with for one assistant on one host
 * page, and that Siteverify must echo back: a SHA-256 of the assistant's id
 * and the parent origin, as 64 hex characters (within `cData`'s documented
 * 255 letters, digits, `_` and `-`). It binds a token to the assistant and
 * page the challenge ran for, so a token collected through one assistant's
 * frame cannot be exchanged for another assistant's session, even when the
 * engine's keys and hostname are shared. The frame is only served, and so
 * only rendered with this value, for an origin in that assistant's allowed
 * websites.
 */
export async function checkBinding(assistantId: string, parentOrigin: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`solv.chat check v1\n${assistantId}\n${parentOrigin}`),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The documented test secret keys (always pass, always fail, token already spent). */
export const TURNSTILE_TEST_SECRETS: readonly string[] = [
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
];

export function isTestSecret(secret: string): boolean {
  return TURNSTILE_TEST_SECRETS.includes(secret);
}

/** The documented test site keys. */
export const TURNSTILE_TEST_SITE_KEYS: readonly string[] = [
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "1x00000000000000000000BB",
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
];

/** The hostname a test secret's success response always carries. */
const TEST_HOSTNAME = "example.com";

export type SiteverifyResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * `rejected`: Turnstile said no (bad, expired or reused token).
       * `mismatch`: it said yes for another hostname, action or binding.
       * `unavailable`: no usable answer (timeout, network, not JSON).
       */
      reason: "rejected" | "mismatch" | "unavailable";
      /** Turnstile's `error-codes`, for the log line. Never the token or secret. */
      codes: string[];
    };

export interface SiteverifyInput {
  secret: string;
  token: string;
  /** The visitor's IP (`cf-connecting-ip`); omitted when unknown. */
  remoteIp: string;
  /** The engine's own hostname: the check frame is served from it. */
  expectedHostname: string;
  /** `checkBinding` for the assistant and origin the exchange names. */
  expectedCdata: string;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Asks Siteverify about one token. Only `success: true` with this engine's
 * hostname, the check's action and the expected binding (`cdata`) counts; everything else, including a
 * timeout or a reply that is not JSON, is a refusal.
 */
export async function siteverify(input: SiteverifyInput): Promise<SiteverifyResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body: Record<string, string> = { secret: input.secret, response: input.token };
  if (input.remoteIp !== "") body.remoteip = input.remoteIp;
  let data: unknown;
  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs ?? SITEVERIFY_TIMEOUT_MS),
    });
    if (!response.ok)
      return { ok: false, reason: "unavailable", codes: [`http_${response.status}`] };
    data = await response.json();
  } catch (err) {
    const name = err instanceof Error ? err.name : "error";
    return {
      ok: false,
      reason: "unavailable",
      codes: [name === "TimeoutError" || name === "AbortError" ? "timeout" : "network"],
    };
  }
  if (typeof data !== "object" || data === null) {
    return { ok: false, reason: "unavailable", codes: ["bad_response"] };
  }
  const result = data as Record<string, unknown>;
  const codes = Array.isArray(result["error-codes"])
    ? result["error-codes"].filter((code): code is string => typeof code === "string").slice(0, 5)
    : [];
  if (result.success !== true) return { ok: false, reason: "rejected", codes };

  // A test secret answers for the dummy token with a fixed hostname and no
  // action or cdata (documented), so the checks below cannot pass with one.
  // The admin warns that test keys protect nothing.
  const testKeys = isTestSecret(input.secret);
  const hostnameOk = testKeys
    ? result.hostname === TEST_HOSTNAME
    : result.hostname === input.expectedHostname;
  const actionOk = testKeys ? true : result.action === TURNSTILE_ACTION;
  const cdataOk = testKeys ? true : result.cdata === input.expectedCdata;
  if (!hostnameOk || !actionOk || !cdataOk) {
    return {
      ok: false,
      reason: "mismatch",
      codes: [!hostnameOk ? "hostname" : !actionOk ? "action" : "cdata"],
    };
  }
  return { ok: true };
}
