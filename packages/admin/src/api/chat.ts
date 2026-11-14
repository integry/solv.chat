import {
  CHAT_PROTOCOL_VERSION,
  type ChatEvent,
  type ChatHistoryTurn,
  type ChatRequest,
  parseChatEventLine,
} from "@solvchat/core";

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

async function* readEventLines(response: Response): AsyncIterable<RawEventLine> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
        break;
      }
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      for (let at = buffer.indexOf("\n\n"); at !== -1; at = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const parsed = parseBlock(block);
        if (parsed !== null) yield parsed;
      }
    }

    if (buffer.trim().length > 0) {
      const parsed = parseBlock(buffer);
      if (parsed !== null) yield parsed;
    }
  } finally {
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
 * Calls the public `POST /v1/chat` endpoint with `target: "draft"` and the
 * shared `CHAT_PROTOCOL_VERSION`, yielding parsed chat events.
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

  const response = await fetch("/v1/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (!response.ok) {
    yield { type: "error", message: `Chat request failed (${response.status}).` };
    return;
  }

  for await (const raw of readEventLines(response)) {
    const event = parseChatEventLine(raw.name, raw.data);
    if (event.type !== "unknown") {
      yield event;
    }
  }
}
