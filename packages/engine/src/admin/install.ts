import type { Tenant } from "../db/tenant.js";
import { NotFound } from "./errors.js";

export interface InstallInfo {
  assistantId: string;
  publicKey: string;
  allowedOrigins: string[];
  snippet: string;
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
  };
}
