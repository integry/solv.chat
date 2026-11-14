import {
  type ChatHistoryTurn,
  MAX_CHAT_HISTORY_TURNS,
  MAX_CHAT_MESSAGE_LENGTH,
} from "@solvchat/core";
import { type FormEvent, useRef, useState } from "react";
import { streamDraftChat } from "../api/chat.js";
import type { Assistant } from "../api/types.js";

interface Citation {
  id: string;
  url: string;
  title: string;
}

interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  error?: string;
  failed?: boolean;
}

export interface TryItPaneProps {
  assistant: Assistant;
}

/**
 * Mounted once in the shell outside `<main>` so the owner keeps their draft
 * conversation while moving between screens.
 */
export function TryItPane({ assistant }: TryItPaneProps) {
  const [turnsByAssistant, setTurnsByAssistant] = useState<Record<string, Turn[]>>({});
  const [conversationIds, setConversationIds] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const turns = turnsByAssistant[assistant.id] ?? [];
  const conversationId = conversationIds[assistant.id];

  function updateTurns(assistantId: string, updater: (prev: Turn[]) => Turn[]) {
    setTurnsByAssistant((prev) => ({
      ...prev,
      [assistantId]: updater(prev[assistantId] ?? []),
    }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || sending) return;
    if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
      setInputError(`Message must be at most ${MAX_CHAT_MESSAGE_LENGTH} characters.`);
      return;
    }

    setInputError(null);
    const assistantId = assistant.id;
    const history: ChatHistoryTurn[] = turns
      .filter((t) => !t.error && !t.failed && t.content.trim() !== "")
      .slice(-MAX_CHAT_HISTORY_TURNS)
      .map((t) => ({
        role: t.role,
        content: t.content.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH).trim(),
      }));

    const userTurnId = `u_${Date.now()}_${Math.random()}`;
    const assistantTurnId = `a_${Date.now()}_${Math.random()}`;

    setInput("");
    setSending(true);
    updateTurns(assistantId, (prev) => [
      ...prev,
      { id: userTurnId, role: "user", content: message },
      { id: assistantTurnId, role: "assistant", content: "", citations: [] },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;
    let succeeded = false;
    let failed = false;

    try {
      for await (const ev of streamDraftChat({
        assistantPublicKey: assistant.publicKey,
        visitorId: "admin-preview",
        message,
        history,
        conversationId,
        signal: controller.signal,
      })) {
        if (ev.type === "token") {
          updateTurns(assistantId, (prev) =>
            prev.map((t) =>
              t.id === assistantTurnId ? { ...t, content: t.content + ev.text } : t,
            ),
          );
        } else if (ev.type === "citation") {
          updateTurns(assistantId, (prev) =>
            prev.map((t) =>
              t.id === assistantTurnId
                ? {
                    ...t,
                    citations: [
                      ...(t.citations ?? []),
                      {
                        id: `${ev.url}-${(t.citations ?? []).length}`,
                        url: ev.url,
                        title: ev.title,
                      },
                    ],
                  }
                : t,
            ),
          );
        } else if (ev.type === "done") {
          succeeded = true;
          setConversationIds((prev) => ({ ...prev, [assistantId]: ev.conversationId }));
        } else if (ev.type === "error") {
          failed = true;
          updateTurns(assistantId, (prev) =>
            prev.map((t) =>
              t.id === userTurnId
                ? { ...t, failed: true }
                : t.id === assistantTurnId
                  ? { ...t, error: ev.message, failed: true }
                  : t,
            ),
          );
        }
      }
      if (!succeeded && !failed && !controller.signal.aborted) {
        updateTurns(assistantId, (prev) =>
          prev.map((t) =>
            t.id === userTurnId || t.id === assistantTurnId ? { ...t, failed: true } : t,
          ),
        );
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const msg = err instanceof Error ? err.message : "Could not reach the assistant.";
        updateTurns(assistantId, (prev) =>
          prev.map((t) =>
            t.id === userTurnId
              ? { ...t, failed: true }
              : t.id === assistantTurnId
                ? { ...t, error: msg, failed: true }
                : t,
          ),
        );
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setSending(false);
    }
  }

  function handleClear() {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setInputError(null);
    setTurnsByAssistant((prev) => ({ ...prev, [assistant.id]: [] }));
    setConversationIds((prev) => {
      const next = { ...prev };
      delete next[assistant.id];
      return next;
    });
  }

  return (
    <aside className="try-it" aria-label="Try it">
      <div className="try-it-header">
        <div>
          <h2 className="try-it-title">Try it</h2>
          <p className="muted">Tests your draft</p>
        </div>
        {turns.length > 0 && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleClear}>
            Clear
          </button>
        )}
      </div>

      <div className="try-it-log" role="log" aria-live="polite">
        {turns.length === 0 ? (
          <p className="muted">Ask a question to preview your draft assistant.</p>
        ) : (
          turns.map((turn) => (
            <div key={turn.id} className={`turn turn-${turn.role}`}>
              <div className="turn-role">{turn.role === "user" ? "You" : assistant.name}</div>
              {turn.content && <div className="turn-content">{turn.content}</div>}
              {turn.error && (
                <p className="error-text" role="alert">
                  {turn.error}
                </p>
              )}
              {turn.citations && turn.citations.length > 0 && (
                <ul className="turn-citations">
                  {turn.citations.map((c) => (
                    <li key={c.id}>
                      <a href={c.url} target="_blank" rel="noreferrer">
                        {c.title || c.url}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
      </div>

      <form className="try-it-form" onSubmit={handleSubmit}>
        <label htmlFor="try-it-input" className="sr-only">
          Ask a question
        </label>
        <input
          id="try-it-input"
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (inputError) setInputError(null);
          }}
          placeholder="Ask a question…"
          disabled={sending}
        />
        <button type="submit" className="btn btn-primary" disabled={sending || !input.trim()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
      {inputError && (
        <p className="field-error" role="alert">
          {inputError}
        </p>
      )}
    </aside>
  );
}
