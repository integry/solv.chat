import { checkTopicName, isId, isPlainObject, type TopicItem } from "@solvchat/core";
import type { Tenant } from "../db/tenant.js";
import { BadRequest, Conflict, NotFound } from "./errors.js";

/**
 * Managing an assistant's topics (Reports → "Manage topics"): rename, merge
 * one into another, delete. Topics are only ever assigned by the answer
 * review; there is no manual tagging of a message.
 */

export interface TopicsList {
  topics: TopicItem[];
  /** The "Review answers" switch: off, no topic is assigned. */
  reviewAnswers: boolean;
}

const NAME_PROBLEMS = {
  empty: "name: must not be empty",
  too_long: "name: must be at most 40 characters",
  too_many_words: "name: must be at most 4 words",
  characters: "name: may use letters, numbers, spaces and - ' & / , only",
  personal: "name: must not contain an address, an email or a long number",
} as const;

async function assistantOrThrow(tenant: Tenant, assistantId: string): Promise<void> {
  if ((await tenant.assistants.get(assistantId)) === null) throw new NotFound("assistant");
}

async function topicOrThrow(tenant: Tenant, assistantId: string, id: string): Promise<TopicItem> {
  // A malformed id is not a lookup: it cannot name a topic anywhere.
  const topic = isId(id, "top") ? await tenant.topics.get(assistantId, id) : null;
  if (topic === null) throw new NotFound("topic");
  return topic;
}

export async function listTopics(tenant: Tenant, assistantId: string): Promise<TopicsList> {
  await assistantOrThrow(tenant, assistantId);
  const [topics, settings] = await Promise.all([
    tenant.topics.list(assistantId),
    tenant.providerSettings.get(),
  ]);
  return { topics, reviewAnswers: settings?.reviewAnswers !== false };
}

/** `{ name }`. The name passes the same checks as one the reviewer proposes. */
export async function renameTopic(
  tenant: Tenant,
  assistantId: string,
  topicId: string,
  body: unknown,
): Promise<{ topic: TopicItem }> {
  await assistantOrThrow(tenant, assistantId);
  if (!isPlainObject(body)) throw new BadRequest(["body: must be a JSON object"]);
  const checked = checkTopicName(body.name);
  if (!checked.ok) throw new BadRequest([NAME_PROBLEMS[checked.problem]]);
  await topicOrThrow(tenant, assistantId, topicId);
  const result = await tenant.topics.rename(assistantId, topicId, checked.name);
  if (result === "not_found") throw new NotFound("topic");
  if (result === "exists") {
    throw new Conflict("Another topic already has this name. Merge the two instead.");
  }
  return { topic: await topicOrThrow(tenant, assistantId, topicId) };
}

/** `{ into }`: every question of this topic moves to `into`, and this topic is deleted. */
export async function mergeTopic(
  tenant: Tenant,
  assistantId: string,
  topicId: string,
  body: unknown,
): Promise<{ topic: TopicItem }> {
  await assistantOrThrow(tenant, assistantId);
  if (!isPlainObject(body) || typeof body.into !== "string") {
    throw new BadRequest(["into: must be a topic id"]);
  }
  if (body.into === topicId) throw new BadRequest(["into: must be another topic"]);
  await topicOrThrow(tenant, assistantId, topicId);
  const into = await topicOrThrow(tenant, assistantId, body.into);
  if (!(await tenant.topics.merge(assistantId, topicId, into.id))) {
    // One of the two went away meanwhile.
    throw new NotFound("topic");
  }
  return { topic: into };
}

/** Deletes a topic; its questions become untagged. */
export async function deleteTopic(
  tenant: Tenant,
  assistantId: string,
  topicId: string,
): Promise<{ deleted: true }> {
  await assistantOrThrow(tenant, assistantId);
  await topicOrThrow(tenant, assistantId, topicId);
  if (!(await tenant.topics.remove(assistantId, topicId))) throw new NotFound("topic");
  return { deleted: true };
}
