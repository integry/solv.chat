import { toConversationSearch } from "@solvchat/core";
import { useEffect, useId, useState } from "react";
import type { ConversationSummary, ConversationsPage } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { assistantPath, navigateTo, readQueryParam } from "../routing.js";
import { RelativeTime } from "../ui/DateText.js";
import { EmptyState } from "../ui/EmptyState.js";
import { ErrorState } from "../ui/ErrorState.js";
import { PageHeader } from "../ui/PageHeader.js";
import { ScreenLink } from "../ui/ScreenLink.js";
import { Skeleton } from "../ui/Skeleton.js";
import { StatusBadge } from "../ui/StatusBadge.js";
import { Conversation } from "./Conversation.js";

export interface ConversationsProps {
  assistantId: string;
}

const PAGE_SIZE = 25;
const SEARCH_DELAY_MS = 300;
/** How long to wait before asking again while search is getting ready. */
const SEARCH_PENDING_RETRY_MS = 1000;
const LIST_PATH = "/admin/conversations";

type FlagKey = "unanswered" | "not_helpful" | "used_tool";

const FLAGS: Array<{ key: FlagKey; label: string }> = [
  { key: "unanswered", label: "Unanswered" },
  { key: "not_helpful", label: "Marked not helpful" },
  { key: "used_tool", label: "Used a tool" },
];

const DATE_OPTIONS = [
  { value: "", label: "Any time" },
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

/**
 * A conversation's address names its assistant too, so a shared link opens
 * under the right assistant and switching assistants does not carry it over.
 */
function conversationPath(conv: ConversationSummary): string {
  const params = new URLSearchParams({ id: conv.id, assistant: conv.assistantId });
  return `${LIST_PATH}?${params.toString()}`;
}

interface OpenAddress {
  id: string | null;
  assistant: string | null;
}

function readOpenAddress(): OpenAddress {
  return { id: readQueryParam("id"), assistant: readQueryParam("assistant") };
}

/**
 * The open conversation follows the address, so Back and a shared link both
 * work. An address naming another assistant (left over from before a switch,
 * or reached with Back) opens nothing and is cleared, so its actions cannot
 * land on the assistant now selected.
 */
function useOpenConversationId(assistantId: string): string | null {
  const [address, setAddress] = useState(readOpenAddress);
  useEffect(() => {
    const onPopState = () => setAddress(readOpenAddress());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const otherAssistant = address.assistant !== null && address.assistant !== assistantId;
  useEffect(() => {
    if (otherAssistant && address.id !== null) {
      window.history.replaceState(window.history.state, "", assistantPath(LIST_PATH, assistantId));
      setAddress({ id: null, assistant: null });
    }
  }, [otherAssistant, address.id, assistantId]);
  return otherAssistant ? null : address.id;
}

function ConversationRow({ conv }: { conv: ConversationSummary }) {
  const messages = conv.turnCount === 1 ? "1 message" : `${conv.turnCount} messages`;
  return (
    <li className="conv-item">
      <ScreenLink to={conversationPath(conv)} className="conv-row">
        <span className="conv-title">
          {conv.firstQuestion ?? "Conversation without a question"}
        </span>
        <span className="conv-meta">
          <RelativeTime value={conv.lastMessageAt ?? conv.startedAt} />
          <span aria-hidden="true">·</span>
          <span>{messages}</span>
          {(conv.hasUnanswered || conv.hasNotHelpful || conv.usedTool) && (
            <span className="conv-badges">
              {conv.hasUnanswered && <StatusBadge tone="warning">Unanswered</StatusBadge>}
              {conv.hasNotHelpful && <StatusBadge tone="danger">Marked not helpful</StatusBadge>}
              {conv.usedTool && <StatusBadge tone="info">Used a tool</StatusBadge>}
            </span>
          )}
        </span>
      </ScreenLink>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div className="source-card">
      <Skeleton label="Loading conversations…" lines={6} />
    </div>
  );
}

export function Conversations({ assistantId }: ConversationsProps) {
  const openId = useOpenConversationId(assistantId);
  const [offset, setOffset] = useState(0);
  const [searchInput, setSearchInput] = useState(() =>
    toConversationSearch(readQueryParam("q") ?? ""),
  );
  // What is sent: the box, cut to the length the list accepts. A pasted
  // question longer than that still finds its conversations by its start.
  const [search, setSearch] = useState(() => toConversationSearch(searchInput));
  const [flags, setFlags] = useState<ReadonlySet<FlagKey>>(new Set());
  const [days, setDays] = useState("");
  const searchId = useId();
  const dateId = useId();

  // Typing waits a moment before searching, so each key press is not a request.
  useEffect(() => {
    const next = toConversationSearch(searchInput);
    if (next === search) return;
    const timer = setTimeout(() => {
      setSearch(next);
      setOffset(0);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchInput, search]);

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (flags.size > 0) params.set("filter", [...flags].join(","));
  if (days !== "") params.set("days", days);
  if (search !== "") params.set("q", search);
  const listRes = useResource<ConversationsPage>(
    `/api/admin/assistants/${assistantId}/conversations?${params.toString()}`,
  );

  // The engine does not search until older messages are prepared for it; it
  // says so and prepares a share each time it is asked. Ask again after a
  // moment until it answers, rather than showing "No conversations match".
  const pendingPage =
    openId === null && listRes.status === "ready" && listRes.value?.searchPending === true
      ? listRes.value
      : undefined;
  const reloadList = listRes.reload;
  useEffect(() => {
    if (pendingPage === undefined) return;
    const timer = setTimeout(reloadList, SEARCH_PENDING_RETRY_MS);
    return () => clearTimeout(timer);
  }, [pendingPage, reloadList]);

  if (openId !== null) {
    return (
      <Conversation
        assistantId={assistantId}
        conversationId={openId}
        onBack={() => {
          navigateTo(assistantPath(LIST_PATH, assistantId));
          listRes.reload();
        }}
      />
    );
  }

  const page = listRes.value;
  const filtered = flags.size > 0 || days !== "" || search !== "";
  const hasPrevious = offset > 0;
  const hasNext = page ? offset + page.limit < page.total : false;
  const updating = listRes.status === "loading" && page !== undefined;

  function toggleFlag(key: FlagKey) {
    setFlags((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setOffset(0);
  }

  function clearFilters() {
    setFlags(new Set());
    setDays("");
    setSearchInput("");
    setSearch("");
    setOffset(0);
  }

  return (
    <div className="screen screen-medium">
      <PageHeader
        title="Conversations"
        description="Read what visitors asked and how your assistant replied."
      />

      <form
        className="list-toolbar"
        aria-label="Find conversations"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(toConversationSearch(searchInput));
          setOffset(0);
        }}
      >
        <div className="field list-search">
          <label htmlFor={searchId} className="sr-only">
            Search conversations
          </label>
          <input
            id={searchId}
            type="search"
            placeholder="Search questions and answers"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <fieldset className="filter-chips">
          <legend className="sr-only">Show only</legend>
          {FLAGS.map((flag) => (
            <button
              key={flag.key}
              type="button"
              className={flags.has(flag.key) ? "chip is-on" : "chip"}
              aria-pressed={flags.has(flag.key)}
              onClick={() => toggleFlag(flag.key)}
            >
              {flag.label}
            </button>
          ))}
        </fieldset>
        <div className="field list-date">
          <label htmlFor={dateId} className="sr-only">
            Started
          </label>
          <select
            id={dateId}
            className="select"
            value={days}
            onChange={(e) => {
              setDays(e.target.value);
              setOffset(0);
            }}
          >
            {DATE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </form>

      {listRes.status === "error" ? (
        <ErrorState
          title="Could not load conversations."
          message={listRes.error}
          onRetry={listRes.reload}
        />
      ) : !page ? (
        <ListSkeleton />
      ) : page.searchPending === true ? (
        <div role="status">
          <EmptyState
            icon="conversations"
            title="Getting search ready"
            description="Older messages are being prepared for search. This happens once, and the results show here when it is done."
          />
        </div>
      ) : page.conversations.length === 0 && !hasPrevious ? (
        filtered ? (
          <EmptyState
            icon="conversations"
            title="No conversations match"
            description="Try other words, or show every conversation."
            action={
              <button type="button" className="btn btn-secondary" onClick={clearFilters}>
                Clear filters
              </button>
            }
          />
        ) : (
          <EmptyState
            icon="conversations"
            title="No conversations yet"
            description="When visitors chat on your site, their conversations show up here."
          />
        )
      ) : (
        <div className="stack" aria-busy={updating}>
          <p className="muted list-count" aria-live="polite">
            {page.total === 0
              ? "No conversations on this page."
              : `Showing ${offset + 1}–${Math.min(offset + page.conversations.length, page.total)} of ${page.total}`}
          </p>
          <ul className={updating ? "conv-list is-updating" : "conv-list"}>
            {page.conversations.map((conv) => (
              <ConversationRow key={conv.id} conv={conv} />
            ))}
          </ul>

          {(hasPrevious || hasNext) && (
            <nav className="actions pager" aria-label="Pages">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!hasPrevious}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!hasNext}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </button>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}
