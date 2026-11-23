import type { VisitorCheckStatus } from "../chat/visitorCheck.js";
import type { Tenant } from "../db/tenant.js";
import { WIDGET_BOOT, WIDGET_BOOT_HASH } from "../widgetBundle.js";
import { NotFound } from "./errors.js";

export interface InstallInfo {
  assistantId: string;
  publicKey: string;
  allowedOrigins: string[];
  snippet: string;
  /**
   * Where and when the widget was last seen in use: the page of the newest
   * conversation. Null until a visitor sends a first message. The page URL
   * comes from the visitor's browser, so the admin shows it as text only.
   */
  lastSeen: { pageUrl: string; at: number } | null;
  /**
   * What a host site's Content-Security-Policy must allow for the widget,
   * one directive per entry, naming the engine and the inline script hash. The
   * visitor check adds `frame-src` (its challenge runs in a frame served
   * from this origin); nothing from Turnstile is loaded by the host page.
   */
  hostPolicy: { directive: string; value: string }[];
  /** Whether the visitor check runs; absent when the caller did not say. */
  visitorCheck?: VisitorCheckStatus | undefined;
}

/** Returns the embed snippet (with public key and deployed origin) and allowed origins. */
export async function getInstallInfo(
  tenant: Tenant,
  assistantId: string,
  publicBaseUrl: string,
  visitorCheck?: VisitorCheckStatus,
): Promise<InstallInfo> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");

  const baseUrl = publicBaseUrl.replace(/\/+$/, "");
  const snippet = `<!-- In <head> after your stylesheets -->
<script data-key="${assistant.publicKey}">${WIDGET_BOOT}</script>
<script src="${baseUrl}/widget.js" defer></script>
<!-- In <body> -->
<solv-chat assistant="${assistant.publicKey}"></solv-chat>`;

  let engineOrigin = baseUrl;
  try {
    engineOrigin = new URL(baseUrl).origin;
  } catch {
    // Keep the configured base as written.
  }
  const checkRuns = visitorCheck?.state === "on" || visitorCheck?.state === "test_keys";
  const hostPolicy = [
    { directive: "script-src", value: `${engineOrigin} ${WIDGET_BOOT_HASH}` },
    { directive: "connect-src", value: engineOrigin },
    ...(checkRuns ? [{ directive: "frame-src", value: engineOrigin }] : []),
  ];

  return {
    assistantId: assistant.id,
    publicKey: assistant.publicKey,
    allowedOrigins: assistant.allowedOrigins,
    snippet,
    lastSeen: await tenant.conversations.latestPageSeen(assistant.id),
    hostPolicy,
    ...(visitorCheck ? { visitorCheck } : {}),
  };
}
