import { defaultVersionConfig, newId, parseAssistantInput } from "@solvchat/core";
import type { AssistantRow } from "../db/assistants.js";
import type { Tenant } from "../db/tenant.js";
import { BadRequest, NotFound } from "./errors.js";
import { mintIngestKey } from "./ingestKeys.js";

/** Lists all assistants belonging to the tenant's org. */
export async function listAssistants(tenant: Tenant): Promise<AssistantRow[]> {
  return tenant.assistants.list();
}

/**
 * Creates a new assistant with a `pk_` public key, its first draft from
 * defaults, and a freshly minted ingest key (returned once, stored hashed).
 */
export async function createAssistant(
  tenant: Tenant,
  body: unknown,
): Promise<{ assistant: AssistantRow; ingestKey: string }> {
  const parsed = parseAssistantInput(body);
  if (!parsed.ok) throw new BadRequest(parsed.errors);

  const id = newId("ast");
  const publicKey = `pk_${newId("ast").slice(4)}`;
  const now = Date.now();
  const ingest = await mintIngestKey();

  await tenant.versions.batch([
    tenant.assistants.statements.insert({
      id,
      name: parsed.value.name,
      publicKey,
      allowedOrigins: parsed.value.allowedOrigins,
      createdAt: now,
      ingestKeyHash: ingest.hash,
    }),
    tenant.versions.statements.insertDraft({
      id: newId("ver"),
      assistantId: id,
      config: defaultVersionConfig(),
      createdAt: now,
    }),
  ]);

  const assistant = await tenant.assistants.get(id);
  if (assistant === null) throw new NotFound("assistant");
  return { assistant, ingestKey: ingest.key };
}

/** Fetches a single assistant by id within the tenant's org. */
export async function getAssistant(tenant: Tenant, id: string): Promise<AssistantRow> {
  const assistant = await tenant.assistants.get(id);
  if (assistant === null) throw new NotFound("assistant");
  return assistant;
}

/** Updates an assistant's name and allowedOrigins. */
export async function updateAssistant(
  tenant: Tenant,
  id: string,
  body: unknown,
): Promise<AssistantRow> {
  const parsed = parseAssistantInput(body);
  if (!parsed.ok) throw new BadRequest(parsed.errors);

  const updated = await tenant.assistants.update(id, parsed.value);
  if (!updated) throw new NotFound("assistant");

  return getAssistant(tenant, id);
}

/** Rotates an assistant's ingest key, storing the new hash and returning the plaintext once. */
export async function rotateIngestKey(tenant: Tenant, id: string): Promise<string> {
  const ingest = await mintIngestKey();
  const updated = await tenant.assistants.setIngestKeyHash(id, ingest.hash);
  if (!updated) throw new NotFound("assistant");
  return ingest.key;
}
