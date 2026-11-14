import {
  CHAT_PROTOCOL_VERSION,
  type ChatEvent,
  type ChatHistoryTurn,
  type ChatRequest,
  parseChatEventLine,
} from "@solvchat/core";
import { notifyUnauthorized } from "./client.js";

interface RawEventLine {
  name: string;
  data: string;
}

function parseBlock(block: string): RawEventLine | null {
  let name = "message";
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      name = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) return null;
  return { name, data: dataLines.join("\n") };
}

async function* readEventLines(
  response: Response,
  signal?: AbortSignal,
): AsyncIterable<RawEventLine> {
  if (!response.body || signal?.aborted) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (signal?.aborted) break;
      if (done) {
        finished = true;
        buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
        break;
      }
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      for (let at = buffer.indexOf("\n\n"); at !== -1; at = buffer.indexOf("\n\n")) {
        if (signal?.aborted) break;
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const parsed = parseBlock(block);
        if (parsed !== null) yield parsed;
      }
    }

    if (!signal?.aborted && buffer.trim().length > 0) {
      const parsed = parseBlock(buffer);
      if (parsed !== null) yield parsed;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!finished) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

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

  for await (const raw of readEventLines(response, params.signal)) {
    const event = parseChatEventLine(raw.name, raw.data);
    if (event.type !== "unknown") {
      yield event;
    }
  }
}
