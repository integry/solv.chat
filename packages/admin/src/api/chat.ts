import {
  CHAT_PROTOCOL_VERSION,
  type ChatEvent,
  type ChatHistoryTurn,
  type ChatRequest,
  parseChatEventLine,
  readSseBlocks,
} from "@solvchat/core";
import { notifyUnauthorized } from "./client.js";

export interface DraftChatParams {
  assistantPublicKey: string;
  visitorId: string;
  message: string;
  history: ChatHistoryTurn[];
  conversationId?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Calls the authenticated `POST /api/admin/chat` preview endpoint with
 * `target: "draft"` and the shared `CHAT_PROTOCOL_VERSION`, yielding parsed
 * chat events. A 401 response clears the active session.
 */
export async function* streamDraftChat(params: DraftChatParams): AsyncIterable<ChatEvent> {
  const body: ChatRequest = {
    protocol: CHAT_PROTOCOL_VERSION,
    assistant: params.assistantPublicKey,
    visitorId: params.visitorId,
    message: params.message,
    target: "draft",
    ...(params.history.length > 0 ? { history: params.history } : {}),
    ...(params.conversationId ? { conversationId: params.conversationId } : {}),
  };

  if (params.signal?.aborted) return;

  const response = await fetch("/api/admin/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (params.signal?.aborted) return;

  if (response.status === 401) {
    notifyUnauthorized();
    yield { type: "error", message: "Sign in first." };
    return;
  }

  if (!response.ok) {
    yield { type: "error", message: `Chat request failed (${response.status}).` };
    return;
  }
  if (!response.body) return;

  for await (const raw of readSseBlocks(response.body, { signal: params.signal })) {
    const event = parseChatEventLine(raw.event ?? "message", raw.data);
    if (event.type !== "unknown") {
      yield event;
    }
  }
}
