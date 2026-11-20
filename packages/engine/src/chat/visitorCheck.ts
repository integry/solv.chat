import type { ChatErrorCode } from "@solvchat/core";
import type { VisitorCheckProvider } from "../seams/types.js";
import {
  counterSubject,
  type VisitorSessionSubject,
  verifyVisitorSession,
} from "../security/visitorSession.js";
import { TURNSTILE_TEST_SECRETS, TURNSTILE_TEST_SITE_KEYS } from "./turnstile.js";

/**
 * Worker configuration read by the visitor check. The two Turnstile keys
 * are a variable (`SOLV_TURNSTILE_SITE_KEY`) and a secret
 * (`SOLV_TURNSTILE_SECRET`); the caps are variables, each a whole number
 * (0 turns that cap off).
 */
export interface VisitorCheckEnv {
  SOLV_TURNSTILE_SITE_KEY?: string | undefined;
  SOLV_TURNSTILE_SECRET?: string | undefined;
  SOLV_SECRET_KEY?: string | undefined;
  SOLV_VISITOR_DAILY_MESSAGES?: string | undefined;
  SOLV_IP_DAILY_MESSAGES?: string | undefined;
  SOLV_CONVERSATION_MESSAGES?: string | undefined;
  SOLV_IP_HOURLY_SESSIONS?: string | undefined;
}

export interface VisitorCaps {
  /** New messages per visitor (the session's visitor id) per UTC day. */
  visitorMessagesPerDay: number;
  /** New messages per IP per UTC day. */
  ipMessagesPerDay: number;
  /** Visitor messages in one conversation. */
  conversationMessages: number;
  /** Sessions issued per IP per clock hour. */
  ipSessionsPerHour: number;
}

/**
 * Defaults for the caps. The engine keeps no usage history to measure
 * against, so they are set from the limits it already has and from what a
 * person can do: the per-IP rate limit allows 20 questions a minute, and a
 * visitor reading an answer and asking the next takes at least a minute, so
 * 100 a day is more than an hour of continuous questions to one site's
 * assistant. An IP is often shared (an office, a school, a mobile carrier),
 * so its daily cap is five such visitors. A conversation sends the model
 * only its last 6 turns, and 50 questions in one is far past any support
 * exchange. A visitor gets one session an hour per tab, so 30 sessions an
 * hour from one IP is thirty people behind one address opening the chat,
 * while farming the check for sessions stops there.
 */
export const DEFAULT_VISITOR_CAPS: VisitorCaps = {
  visitorMessagesPerDay: 100,
  ipMessagesPerDay: 500,
  conversationMessages: 50,
  ipSessionsPerHour: 30,
};

/** What is missing when the check is half set up. `secret_key` is SOLV_SECRET_KEY, which signs sessions. */
export type VisitorCheckMissing = "site_key" | "secret" | "secret_key";

export type VisitorCheck =
  | { state: "off" }
  | { state: "misconfigured"; missing: VisitorCheckMissing[] }
  | {
      state: "on";
      siteKey: string;
      secret: string;
      /** SOLV_SECRET_KEY; the session and counter keys are derived from it. */
      signingSecret: string;
      /** True when both keys are Turnstile's documented test keys. */
      testKeys: boolean;
      caps: VisitorCaps;
    };

/** What the admin is told about the check. Never a key. */
export interface VisitorCheckStatus {
  state: "on" | "off" | "test_keys" | "misconfigured";
  missing: VisitorCheckMissing[];
}

function parseCap(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function capsFrom(env: VisitorCheckEnv): VisitorCaps {
  return {
    visitorMessagesPerDay: parseCap(
      env.SOLV_VISITOR_DAILY_MESSAGES,
      DEFAULT_VISITOR_CAPS.visitorMessagesPerDay,
    ),
    ipMessagesPerDay: parseCap(env.SOLV_IP_DAILY_MESSAGES, DEFAULT_VISITOR_CAPS.ipMessagesPerDay),
    conversationMessages: parseCap(
      env.SOLV_CONVERSATION_MESSAGES,
      DEFAULT_VISITOR_CAPS.conversationMessages,
    ),
    ipSessionsPerHour: parseCap(
      env.SOLV_IP_HOURLY_SESSIONS,
      DEFAULT_VISITOR_CAPS.ipSessionsPerHour,
    ),
  };
}

/**
 * Reads the check's configuration. Neither key set (and the host does not
 * require them) is `off`: the public chat runs as it did before the check.
 * One key, or both without SOLV_SECRET_KEY to sign with, is
 * `misconfigured`: the public chat refuses every request.
 */
export async function resolveVisitorCheck(
  env: VisitorCheckEnv,
  provider: VisitorCheckProvider | undefined,
): Promise<VisitorCheck> {
  const keys = provider
    ? await provider.keys()
    : { siteKey: env.SOLV_TURNSTILE_SITE_KEY, secret: env.SOLV_TURNSTILE_SECRET };
  const siteKey = keys.siteKey?.trim() ?? "";
  const secret = keys.secret?.trim() ?? "";
  const signingSecret = env.SOLV_SECRET_KEY ?? "";
  if (siteKey === "" && secret === "" && provider?.required !== true) return { state: "off" };
  const missing: VisitorCheckMissing[] = [];
  if (siteKey === "") missing.push("site_key");
  if (secret === "") missing.push("secret");
  if (signingSecret === "") missing.push("secret_key");
  if (missing.length > 0) return { state: "misconfigured", missing };
  return {
    state: "on",
    siteKey,
    secret,
    signingSecret,
    testKeys: TURNSTILE_TEST_SECRETS.includes(secret) || TURNSTILE_TEST_SITE_KEYS.includes(siteKey),
    caps: capsFrom(env),
  };
}

export function visitorCheckStatus(check: VisitorCheck): VisitorCheckStatus {
  switch (check.state) {
    case "off":
      return { state: "off", missing: [] };
    case "misconfigured":
      return { state: "misconfigured", missing: [...check.missing] };
    case "on":
      return { state: check.testKeys ? "test_keys" : "on", missing: [] };
  }
}

/** One refusal: a code the widget can act on and a short sentence it shows. */
export interface VisitorRefusal {
  code: ChatErrorCode;
  message: string;
}

export const CHECK_CONFIG_MESSAGE = "This chat is not set up correctly. Please try again later.";
export const CHECK_REQUIRED_MESSAGE =
  "The security check has expired. Please send your message again.";
export const VISITOR_CAP_MESSAGE =
  "You have reached today's limit for questions. Please come back tomorrow.";
export const IP_CAP_MESSAGE =
  "Too many questions have come from your network today. Please come back tomorrow.";
export const CONVERSATION_CAP_MESSAGE =
  "This conversation has reached its limit. Your next question starts a new one.";

export const CONFIG_REFUSAL: VisitorRefusal = {
  code: "check_config",
  message: CHECK_CONFIG_MESSAGE,
};

/**
 * Checks the request's session against the assistant, org and visitor the
 * engine resolved. Returns null when it is valid.
 */
export async function checkSession(
  check: Extract<VisitorCheck, { state: "on" }>,
  subject: VisitorSessionSubject,
  session: string | undefined,
  now: number,
): Promise<VisitorRefusal | null> {
  const verdict = await verifyVisitorSession(check.signingSecret, subject, session, now);
  return verdict.ok ? null : { code: "check_required", message: CHECK_REQUIRED_MESSAGE };
}

export const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type CounterName = "visitor_day" | "ip_day" | "ip_sessions_hour";

interface CounterHit {
  counter: CounterName;
  subject: string;
  windowStart: number;
}

/**
 * Adds one hit to each counter, in one D1 round trip, and returns the new
 * counts in the same order. Increment and read are one statement, so two
 * simultaneous requests cannot both see the old count.
 */
async function bump(
  db: D1Database,
  orgId: string,
  assistantId: string,
  hits: readonly CounterHit[],
): Promise<number[]> {
  const results = await db.batch<{ hits: number }>(
    hits.map((hit) =>
      db
        .prepare(
          `INSERT INTO visitor_counters (org_id, assistant_id, counter, subject, window_start, hits)
           VALUES (?1, ?2, ?3, ?4, ?5, 1)
           ON CONFLICT(org_id, assistant_id, counter, subject, window_start)
           DO UPDATE SET hits = hits + 1
           RETURNING hits`,
        )
        .bind(orgId, assistantId, hit.counter, hit.subject, hit.windowStart),
    ),
  );
  const counts = results.map((result) => result.results[0]?.hits ?? 0);
  // The first hit of a new window is a cheap moment to drop windows that
  // can no longer refuse anything, so the table holds about one day.
  const stale = hits.filter((_, i) => counts[i] === 1);
  if (stale.length > 0) {
    await db.batch(
      stale.map((hit) =>
        db
          .prepare(
            "DELETE FROM visitor_counters WHERE org_id = ?1 AND counter = ?2 AND window_start < ?3",
          )
          .bind(orgId, hit.counter, hit.windowStart),
      ),
    );
  }
  return counts;
}

export interface MessageCapInput {
  orgId: string;
  assistantId: string;
  visitorId: string;
  ip: string;
  conversationId: string | undefined;
}

/**
 * Takes one slot of the conversation cap for a new visitor message, in one
 * statement, so two simultaneous requests for a conversation's last slot
 * cannot both get it. Counts the higher of the reservations and the stored
 * visitor messages, so messages written before the column existed count.
 * Returns `reserved`, `full`, or `absent` when no conversation with this id
 * belongs to this assistant and visitor (the answer then starts a new one,
 * which has no messages to cap).
 */
async function reserveConversationSlot(
  db: D1Database,
  input: MessageCapInput & { conversationId: string },
  cap: number,
): Promise<"reserved" | "full" | "absent"> {
  const used = `MAX(visitor_messages_reserved, (
    SELECT COUNT(*) FROM messages
     WHERE org_id = ?1 AND conversation_id = ?2 AND role = 'user'
  ))`;
  const res = await db
    .prepare(
      `UPDATE conversations SET visitor_messages_reserved = ${used} + 1
        WHERE org_id = ?1 AND id = ?2 AND assistant_id = ?3 AND visitor_id = ?4
          AND ${used} < ?5`,
    )
    .bind(input.orgId, input.conversationId, input.assistantId, input.visitorId, cap)
    .run();
  if ((res.meta.changes ?? 0) > 0) return "reserved";
  const exists = await db
    .prepare(
      `SELECT 1 AS found FROM conversations
        WHERE org_id = ?1 AND id = ?2 AND assistant_id = ?3 AND visitor_id = ?4`,
    )
    .bind(input.orgId, input.conversationId, input.assistantId, input.visitorId)
    .first<{ found: number }>();
  return exists === null ? "absent" : "full";
}

/** Gives back a slot taken by `reserveConversationSlot` when a later cap refuses the message. */
async function releaseConversationSlot(
  db: D1Database,
  input: MessageCapInput & { conversationId: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE conversations SET visitor_messages_reserved = visitor_messages_reserved - 1
        WHERE org_id = ?1 AND id = ?2 AND visitor_messages_reserved > 0`,
    )
    .bind(input.orgId, input.conversationId)
    .run();
}

/**
 * The per-visitor caps on a new visitor message, checked after the session,
 * the rate limit and the spend cap, and before any paid work. Costs, when
 * the request names a conversation, one D1 update that reserves the
 * conversation's slot (and one read when it does not), then one D1 batch of
 * two upserts. A slot stays taken once the message is admitted, even if the
 * answer then fails: the visitor's message is stored before any answer, so
 * the cap counts what was accepted.
 */
export async function checkMessageCaps(
  db: D1Database,
  check: Extract<VisitorCheck, { state: "on" }>,
  input: MessageCapInput,
  now: number,
): Promise<VisitorRefusal | null> {
  const { caps } = check;
  const conversation =
    input.conversationId !== undefined && caps.conversationMessages > 0
      ? { ...input, conversationId: input.conversationId }
      : null;
  let reserved = false;
  if (conversation !== null) {
    // Reserved first, so a refusal here does not use up the day's counts.
    const slot = await reserveConversationSlot(db, conversation, caps.conversationMessages);
    if (slot === "full") return { code: "conversation_cap", message: CONVERSATION_CAP_MESSAGE };
    reserved = slot === "reserved";
  }
  const refusal = await checkDailyCaps(db, check, input, now);
  // A message the daily caps refuse is not admitted, so its slot goes back.
  if (refusal !== null && reserved && conversation !== null) {
    await releaseConversationSlot(db, conversation);
  }
  return refusal;
}

async function checkDailyCaps(
  db: D1Database,
  check: Extract<VisitorCheck, { state: "on" }>,
  input: MessageCapInput,
  now: number,
): Promise<VisitorRefusal | null> {
  const { caps } = check;
  const day = Math.floor(now / DAY_MS) * DAY_MS;
  const hits: CounterHit[] = [];
  if (caps.visitorMessagesPerDay > 0) {
    hits.push({
      counter: "visitor_day",
      subject: await counterSubject(check.signingSecret, "visitor", input.visitorId),
      windowStart: day,
    });
  }
  if (caps.ipMessagesPerDay > 0) {
    hits.push({
      counter: "ip_day",
      subject: await counterSubject(check.signingSecret, "ip", input.ip),
      windowStart: day,
    });
  }
  if (hits.length === 0) return null;
  const counts = await bump(db, input.orgId, input.assistantId, hits);
  for (const [i, hit] of hits.entries()) {
    const count = counts[i] ?? 0;
    if (hit.counter === "visitor_day" && count > caps.visitorMessagesPerDay) {
      return { code: "visitor_cap", message: VISITOR_CAP_MESSAGE };
    }
    if (hit.counter === "ip_day" && count > caps.ipMessagesPerDay) {
      return { code: "ip_cap", message: IP_CAP_MESSAGE };
    }
  }
  return null;
}

/**
 * Counts one issued session against the IP's hourly cap. True when the
 * session may be issued.
 */
export async function countSessionIssued(
  db: D1Database,
  check: Extract<VisitorCheck, { state: "on" }>,
  input: { orgId: string; assistantId: string; ip: string },
  now: number,
): Promise<boolean> {
  if (check.caps.ipSessionsPerHour <= 0) return true;
  const [count = 0] = await bump(db, input.orgId, input.assistantId, [
    {
      counter: "ip_sessions_hour",
      subject: await counterSubject(check.signingSecret, "ip", input.ip),
      windowStart: Math.floor(now / HOUR_MS) * HOUR_MS,
    },
  ]);
  return count <= check.caps.ipSessionsPerHour;
}
