import {
  type ChatHistoryTurn,
  MAX_CHAT_HISTORY_TURNS,
  MAX_CHAT_MESSAGE_LENGTH,
} from "@solvchat/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { streamDraftChat } from "../api/chat.js";
import type { Assistant } from "../api/types.js";
import { isSafeHttpUrl } from "../safeUrl.js";
import { Icon } from "../ui/Icon.js";

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
  /** Hides the pane without unmounting it, so the conversation is kept. */
  hidden?: boolean;
  /** Element id, for the header toggle's `aria-controls`. */
  id?: string;
  /** Shows a close button that calls this. */
  onClose?: () => void;
  /** True when shown as a sheet over the page (narrow screens): Escape closes it. */
  overlay?: boolean;
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Mounted once in the shell outside `<main>` so the owner keeps their draft
 * conversation while moving between screens.
 */
export function TryItPane({
  assistant,
  hidden = false,
  id,
  onClose,
  overlay = false,
}: TryItPaneProps) {
  const [turnsByAssistant, setTurnsByAssistant] = useState<Record<string, Turn[]>>({});
  const [conversationIds, setConversationIds] = useState<Record<string, string>>({});
  const [inputsByAssistant, setInputsByAssistant] = useState<Record<string, string>>({});
  const [inputErrorsByAssistant, setInputErrorsByAssistant] = useState<
    Record<string, string | null>
  >({});
  const [sendingByAssistant, setSendingByAssistant] = useState<Record<string, boolean>>({});
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const controllers = abortControllersRef.current;
    return () => {
      mountedRef.current = false;
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
    };
  }, []);

  const turns = turnsByAssistant[assistant.id] ?? [];
  const conversationId = conversationIds[assistant.id];
  const input = inputsByAssistant[assistant.id] ?? "";
  const inputError = inputErrorsByAssistant[assistant.id] ?? null;
  const sending = Boolean(sendingByAssistant[assistant.id]);

  function updateTurns(assistantId: string, updater: (prev: Turn[]) => Turn[]) {
    if (!mountedRef.current) return;
    setTurnsByAssistant((prev) => {
      const current = prev[assistantId] ?? [];
      const next = updater(current);
      if (next === current) return prev;
      return {
        ...prev,
        [assistantId]: next,
      };
    });
  }

  function markTurnsFailed(
    assistantId: string,
    userTurnId: string,
    assistantTurnId: string,
    errorMessage?: string,
  ) {
    updateTurns(assistantId, (prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.id === userTurnId) {
          changed = true;
          return { ...t, failed: true };
        }
        if (t.id === assistantTurnId) {
          changed = true;
          return errorMessage !== undefined
            ? { ...t, error: errorMessage, failed: true }
            : { ...t, failed: true };
        }
        return t;
      });
      return changed ? next : prev;
    });
  }

  function clearSendingForController(assistantId: string, controller: AbortController) {
    if (abortControllersRef.current.get(assistantId) !== controller) return;
    abortControllersRef.current.delete(assistantId);
    if (!mountedRef.current) return;
    setSendingByAssistant((prev) => omitKey(prev, assistantId));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const assistantId = assistant.id;
    const message = input.trim();
    if (!message || sending || abortControllersRef.current.has(assistantId)) return;
    if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
      setInputErrorsByAssistant((prev) => ({
        ...prev,
        [assistantId]: `Message must be at most ${MAX_CHAT_MESSAGE_LENGTH} characters.`,
      }));
      return;
    }

    setInputErrorsByAssistant((prev) => omitKey(prev, assistantId));

    const history: ChatHistoryTurn[] = turns
      .filter((t) => !t.error && !t.failed && t.content.trim() !== "")
      .slice(-MAX_CHAT_HISTORY_TURNS)
      .map((t) => ({
        role: t.role,
        content: t.content.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH).trim(),
      }));

    const userTurnId = `u_${Date.now()}_${Math.random()}`;
    const assistantTurnId = `a_${Date.now()}_${Math.random()}`;

    const controller = new AbortController();
    abortControllersRef.current.set(assistantId, controller);

    setInputsByAssistant((prev) => ({ ...prev, [assistantId]: "" }));
    setSendingByAssistant((prev) => ({ ...prev, [assistantId]: true }));
    updateTurns(assistantId, (prev) => [
      ...prev,
      { id: userTurnId, role: "user", content: message },
      { id: assistantTurnId, role: "assistant", content: "", citations: [] },
    ]);

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
        if (
          controller.signal.aborted ||
          abortControllersRef.current.get(assistantId) !== controller
        ) {
          break;
        }
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
          if (mountedRef.current) {
            setConversationIds((prev) => ({ ...prev, [assistantId]: ev.conversationId }));
          }
        } else if (ev.type === "error") {
          failed = true;
          markTurnsFailed(assistantId, userTurnId, assistantTurnId, ev.message);
        }
      }
      if (!succeeded && !failed) {
        markTurnsFailed(assistantId, userTurnId, assistantTurnId);
      }
    } catch (err) {
      if (!succeeded && !failed) {
        const msg = controller.signal.aborted
          ? undefined
          : err instanceof Error
            ? err.message
            : "Could not reach the assistant.";
        markTurnsFailed(assistantId, userTurnId, assistantTurnId, msg);
      }
    } finally {
      clearSendingForController(assistantId, controller);
    }
  }

  function handleClear() {
    const assistantId = assistant.id;
    const controller = abortControllersRef.current.get(assistantId);
    if (controller) {
      abortControllersRef.current.delete(assistantId);
      controller.abort();
    }
    setSendingByAssistant((prev) => omitKey(prev, assistantId));
    setInputErrorsByAssistant((prev) => omitKey(prev, assistantId));
    setTurnsByAssistant((prev) => ({ ...prev, [assistantId]: [] }));
    setConversationIds((prev) => omitKey(prev, assistantId));
  }

  return (
    <aside
      id={id}
      className={overlay ? "try-it try-it-overlay" : "try-it"}
      aria-label="Try it"
      hidden={hidden}
      onKeyDown={(event) => {
        if (overlay && onClose && event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="try-it-header">
        <div>
          <h2 className="try-it-title">Try it</h2>
          <p className="try-it-draft">
            <span className="badge badge-tone-info">Draft</span>
            <span className="muted">
              Uses your saved draft. Visitors still get the published version.
            </span>
          </p>
        </div>
        <div className="try-it-header-actions">
          {turns.length > 0 && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleClear}>
              Clear
            </button>
          )}
          {onClose && (
            <button type="button" className="btn-icon" aria-label="Close Try it" onClick={onClose}>
              <Icon name="close" />
            </button>
          )}
        </div>
      </div>

      <div className="try-it-log" role="log" aria-live="polite">
        {turns.length === 0 ? (
          <p className="muted">Ask a question to see how your draft answers.</p>
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
              {turn.citations?.some((c) => isSafeHttpUrl(c.url)) && (
                <ul className="turn-citations">
                  {turn.citations
                    .filter((c) => isSafeHttpUrl(c.url))
                    .map((c) => (
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
            const assistantId = assistant.id;
            const value = e.target.value;
            setInputsByAssistant((prev) => ({ ...prev, [assistantId]: value }));
            if (inputError) {
              setInputErrorsByAssistant((prev) => omitKey(prev, assistantId));
            }
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
