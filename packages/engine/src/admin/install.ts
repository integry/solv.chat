import type { Tenant } from "../db/tenant.js";
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
}

/** Returns the embed snippet (with public key and deployed origin) and allowed origins. */
export async function getInstallInfo(
  tenant: Tenant,
  assistantId: string,
  publicBaseUrl: string,
): Promise<InstallInfo> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");

  const baseUrl = publicBaseUrl.replace(/\/+$/, "");
  const snippet = `<script src="${baseUrl}/widget.js" defer></script>\n<solv-chat assistant="${assistant.publicKey}"></solv-chat>`;

  return {
    assistantId: assistant.id,
    publicKey: assistant.publicKey,
    allowedOrigins: assistant.allowedOrigins,
    snippet,
    lastSeen: await tenant.conversations.latestPageSeen(assistant.id),
  };
}
