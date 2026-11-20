import {
  parseVisitorSessionRequest,
  type VisitorSessionErrorCode,
  type VisitorSessionResponse,
} from "@solvchat/core";
import type { Limits, Seams } from "../seams/types.js";
import { issueVisitorSession, tokenHash } from "../security/visitorSession.js";
import { checkLimits, corsHeaders, matchedOrigin } from "./checks.js";
import { bodyKeyedPreflight, publicAssistant } from "./route.js";
import {
  checkBinding,
  isTestSecret,
  SITEVERIFY_TIMEOUT_MS,
  siteverify,
  TURNSTILE_ACTION,
  TURNSTILE_TOKEN_TTL_MS,
} from "./turnstile.js";
import {
  CHECK_CONFIG_MESSAGE,
  countSessionIssued,
  resolveVisitorCheck,
  type VisitorCheckEnv,
} from "./visitorCheck.js";

export interface VisitorSessionEnv extends VisitorCheckEnv {
  DB: D1Database;
}

export interface VisitorSessionDeps {
  seams: Pick<Seams, "auth" | "limits" | "visitorCheck">;
  fetchImpl?: typeof fetch | undefined;
  /** Siteverify timeout; tests shorten it. */
  siteverifyTimeoutMs?: number | undefined;
  now?: (() => number) | undefined;
}

export const CHECK_FAILED_MESSAGE = "The security check could not be completed. Please try again.";
export const SESSION_CAP_MESSAGE =
  "Too many security checks have come from your network. Please try again in an hour.";

function refuse(
  status: number,
  code: VisitorSessionErrorCode,
  message: string,
  origin: string | null,
): Response {
  return Response.json(
    { error: message, code },
    { status, headers: { "cache-control": "no-store", ...corsHeaders(origin) } },
  );
}

/**
 * Handles `POST /v1/session` and its preflight: exchanges a Turnstile token
 * for a signed visitor session. Order: Origin, the per-IP rate limit and
 * spend cap (the config budget: an exchange costs no model call), the
 * spent-token record (not for a test secret), Siteverify (hostname, action
 * and the assistant-and-page binding), then the sessions-per-IP cap.
 */
export async function visitorSessionRoute(
  request: Request,
  env: VisitorSessionEnv,
  deps: VisitorSessionDeps,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return bodyKeyedPreflight(request, env.DB, deps.seams.auth, "POST, OPTIONS");
  }
  if (request.method !== "POST") return Response.json({ error: "Not found." }, { status: 404 });

  const check = await resolveVisitorCheck(env, deps.seams.visitorCheck);
  if (check.state === "off") return Response.json({ error: "Not found." }, { status: 404 });

  const body = await request.json().catch(() => null);
  const parsed = parseVisitorSessionRequest(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.errors[0] ?? "Invalid request." }, { status: 400 });
  }
  const assistant = await publicAssistant(env.DB, deps.seams.auth, parsed.value.assistant);
  if (assistant === null) return Response.json({ error: "Not found." }, { status: 404 });

  const origin = matchedOrigin(assistant, request);
  if (origin === null) {
    return Response.json(
      { error: "This assistant is not available on this page." },
      { status: 403 },
    );
  }
  if (check.state === "misconfigured") {
    return refuse(503, "check_config", CHECK_CONFIG_MESSAGE, origin);
  }
  const limited = await checkLimits(deps.seams.limits as Limits, assistant, request, "config");
  if (limited !== null) {
    return Response.json({ error: limited.message }, { status: 429, headers: corsHeaders(origin) });
  }

  const now = (deps.now ?? Date.now)();
  // Expired rows go first, so a token's row never outlives its 300 s.
  await env.DB.prepare("DELETE FROM visitor_check_tokens WHERE org_id = ?1 AND expires_at < ?2")
    .bind(assistant.orgId, now)
    .run();
  // Recorded before asking Turnstile: its own reuse check is eventually
  // consistent, so two exchanges of one token seconds apart could both pass
  // it. The first insert wins; every later one is refused.
  // A test secret accepts only the one fixed dummy token (documented:
  // https://developers.cloudflare.com/turnstile/troubleshooting/testing/ —
  // checked 2026-11-20), so recording it would let the always-pass keys
  // issue one session and then refuse every visitor. It skips the record and
  // still goes to Siteverify, so the always-fail and spent-token test
  // secrets refuse as they are documented to. Test keys protect nothing, and
  // the admin says so.
  if (!isTestSecret(check.secret)) {
    const spent = await env.DB.prepare(
      `INSERT INTO visitor_check_tokens (token_hash, org_id, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(token_hash) DO NOTHING RETURNING token_hash`,
    )
      .bind(await tokenHash(parsed.value.token), assistant.orgId, now + TURNSTILE_TOKEN_TTL_MS)
      .first<{ token_hash: string }>();
    if (spent === null) return refuse(403, "check_failed", CHECK_FAILED_MESSAGE, origin);
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const verdict = await siteverify({
    secret: check.secret,
    token: parsed.value.token,
    remoteIp: ip,
    expectedHostname: new URL(request.url).hostname,
    // The token must come from this assistant's frame, opened for this page.
    expectedCdata: await checkBinding(assistant.id, origin),
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.siteverifyTimeoutMs ?? SITEVERIFY_TIMEOUT_MS,
  });
  if (!verdict.ok) {
    // Codes only: never the token, the secret or the visitor's address.
    console.warn("visitor check: token refused", { reason: verdict.reason, codes: verdict.codes });
    return refuse(
      verdict.reason === "unavailable" ? 503 : 403,
      "check_failed",
      CHECK_FAILED_MESSAGE,
      origin,
    );
  }

  const allowed = await countSessionIssued(
    env.DB,
    check,
    { orgId: assistant.orgId, assistantId: assistant.id, ip },
    now,
  );
  if (!allowed) return refuse(429, "session_cap", SESSION_CAP_MESSAGE, origin);

  const issued = await issueVisitorSession(
    check.signingSecret,
    { orgId: assistant.orgId, assistantId: assistant.id, visitorId: parsed.value.visitorId },
    now,
  );
  const response: VisitorSessionResponse = issued;
  return Response.json(response, {
    status: 200,
    headers: { "cache-control": "no-store", ...corsHeaders(origin) },
  });
}

/**
 * Turnstile's script, loaded inside the check frame only.
 * `render=explicit` and `onload=<function>` are documented parameters:
 * https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/ — checked 2026-11-20
 */
export const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=solvCheckLoaded";

/**
 * The check frame's policy. Turnstile needs `script-src` and `frame-src`
 * for `https://challenges.cloudflare.com` (documented:
 * https://developers.cloudflare.com/turnstile/reference/content-security-policy/
 * — checked 2026-11-20). `frame-ancestors` names the one host page origin
 * this frame was opened for, and only after it is found in the assistant's
 * allowed websites, so no other site can frame it to collect tokens.
 */
export function checkFramePolicy(parentOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${parentOrigin}`,
  ].join("; ");
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Handles `GET /v1/check/frame?assistant=pk_…&parent=<origin>&theme=light|dark`:
 * the page the widget frames to run Turnstile on the engine's own origin.
 * It costs no model call and writes nothing.
 */
export async function checkFrameRoute(
  request: Request,
  env: VisitorSessionEnv,
  deps: Pick<VisitorSessionDeps, "seams">,
): Promise<Response> {
  if (request.method !== "GET") return Response.json({ error: "Not found." }, { status: 404 });
  const check = await resolveVisitorCheck(env, deps.seams.visitorCheck);
  if (check.state !== "on") return new Response("Not found.", { status: 404 });
  const url = new URL(request.url);
  const publicKey = url.searchParams.get("assistant") ?? "";
  const parent = url.searchParams.get("parent") ?? "";
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
  const assistant =
    publicKey.startsWith("pk_") && publicKey.length <= 128
      ? await publicAssistant(env.DB, deps.seams.auth, publicKey)
      : null;
  // The parent must be one of the assistant's websites, exactly: it becomes
  // the frame's only allowed ancestor and the only origin it posts the token to.
  if (assistant === null || !assistant.allowedOrigins.includes(parent)) {
    return new Response("Not found.", { status: 404 });
  }
  // Limited like the config read it follows: it costs a lookup, nothing more.
  const limited = await checkLimits(deps.seams.limits as Limits, assistant, request, "config");
  if (limited !== null) return new Response(limited.message, { status: 429 });
  const html = `<!doctype html>
<html lang="en" data-site-key="${escapeAttr(check.siteKey)}" data-parent="${escapeAttr(parent)}" data-theme="${theme}" data-action="${TURNSTILE_ACTION}" data-cdata="${await checkBinding(assistant.id, parent)}">
<head><meta charset="utf-8"><meta name="color-scheme" content="${theme}"><title>Security check</title><script src="/v1/check/frame.js" defer></script></head>
<body><div id="check"></div></body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": checkFramePolicy(parent),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * The check frame's script. It renders Turnstile explicitly (no hidden form
 * field), sends the token and the challenge's state to the parent page with
 * `postMessage` addressed to the parent's origin only, and accepts one
 * message back, `reset`, only from that origin and that window.
 *
 * Options used, all documented on
 * https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/
 * (checked 2026-11-20): `action` and `cData` (the assistant-and-page
 * binding Siteverify must echo), `appearance: "interaction-only"` (shown only when the
 * visitor must act), `size: "flexible"` (100% wide, at least 300px),
 * `retry: "never"` (the widget decides when to retry), `refresh-expired:
 * "never"` (the session, not the token, is what lasts), `response-field:
 * false`, and the `before-interactive` / `after-interactive` / `error` /
 * `expired` / `timeout` / `unsupported` callbacks.
 */
export const CHECK_FRAME_SCRIPT = `(() => {
  "use strict";
  const data = document.documentElement.dataset;
  const parentOrigin = data.parent || "";
  if (window.parent === window || parentOrigin === "") return;
  let widgetId = null;
  const post = (message) => {
    window.parent.postMessage(Object.assign({ solvCheck: 1 }, message), parentOrigin);
  };
  document.documentElement.style.background = "transparent";
  document.documentElement.style.overflow = "hidden";
  document.body.style.margin = "0";
  window.solvCheckLoaded = () => {
    try {
      widgetId = window.turnstile.render("#check", {
        sitekey: data.siteKey || "",
        action: data.action || "",
        cData: data.cdata || "",
        theme: data.theme === "dark" ? "dark" : "light",
        size: "flexible",
        appearance: "interaction-only",
        retry: "never",
        "refresh-expired": "never",
        "response-field": false,
        callback: (token) => post({ type: "token", token: String(token) }),
        "error-callback": (code) => {
          post({ type: "error", code: String(code) });
          return true;
        },
        "expired-callback": () => post({ type: "expired" }),
        "timeout-callback": () => post({ type: "error", code: "timeout" }),
        "unsupported-callback": () => post({ type: "error", code: "unsupported" }),
        "before-interactive-callback": () => post({ type: "interactive" }),
        "after-interactive-callback": () => post({ type: "settled" }),
      });
    } catch (err) {
      post({ type: "error", code: "render" });
    }
  };
  window.addEventListener("message", (event) => {
    if (event.origin !== parentOrigin || event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.solvCheck !== 1) return;
    if (message.type === "reset" && widgetId !== null && window.turnstile) {
      window.turnstile.reset(widgetId);
    }
  });
  const script = document.createElement("script");
  script.src = ${JSON.stringify(TURNSTILE_SCRIPT_URL)};
  script.async = true;
  script.onerror = () => post({ type: "error", code: "load" });
  document.head.appendChild(script);
  post({ type: "ready" });
})();
`;

export function checkFrameScript(): Response {
  return new Response(CHECK_FRAME_SCRIPT, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
