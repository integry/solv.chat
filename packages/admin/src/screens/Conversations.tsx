import { isQuestionLinkStart, toConversationSearch } from "@solvchat/core";
import { useEffect, useId, useState } from "react";
import type { ConversationSummary, ConversationsPage } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import {
  navigateTo,
  readQueryParam,
  replaceQueryParams,
  ScreenLink,
  screenAddress,
  useAdminNavigation,
} from "../routing.js";
import { RelativeTime } from "../ui/DateText.js";
import { EmptyState } from "../ui/EmptyState.js";
import { ErrorState } from "../ui/ErrorState.js";
import { formatDate } from "../ui/format.js";
import { PageHeader } from "../ui/PageHeader.js";
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

type FlagKey =
  | "unanswered"
  | "not_helpful"
  | "used_tool"
  | "could_not_answer"
  | "asked_for_person"
  | "off_topic";

const FLAGS: Array<{ key: FlagKey; label: string }> = [
  { key: "unanswered", label: "Unanswered" },
  { key: "not_helpful", label: "Marked not helpful" },
  { key: "used_tool", label: "Used a tool" },
  // These read the answer review's outcome, so they find reviewed replies
  // only (retrieval misses included: they are reviewed too).
  { key: "could_not_answer", label: "Could not answer" },
  { key: "asked_for_person", label: "Asked for a person" },
  { key: "off_topic", label: "Off topic" },
];

const DATE_OPTIONS = [
  { value: "", label: "Any time" },
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

/** The `filter` value for a set of flags, in the order the chips show them. */
function flagsParam(flags: ReadonlySet<FlagKey>): string {
  return FLAGS.filter((flag) => flags.has(flag.key))
    .map((flag) => flag.key)
    .join(",");
}

/** The flags an address names; names that are not flags are left out. */
function flagsOf(raw: string | null): ReadonlySet<FlagKey> {
  const named = new Set((raw ?? "").split(",").map((part) => part.trim()));
  return new Set(FLAGS.filter((flag) => named.has(flag.key)).map((flag) => flag.key));
}

/** The date choice an address names, or "" (any time) for one the list does not offer. */
function daysOf(raw: string | null): string {
  return DATE_OPTIONS.some((option) => option.value !== "" && option.value === raw)
    ? (raw ?? "")
    : "";
}

/** What the list shows, as kept in the address. */
interface ListView {
  search: string;
  flags: ReadonlySet<FlagKey>;
  days: string;
  /** A grouped question from Reports or Overview: only conversations that asked it. */
  question: string;
  /**
   * With `question`, from Reports: the UTC days (`YYYY-MM-DD`) it was asked
   * in, the report's period. "" when not set. Cleared with the question.
   */
  askedFrom: string;
  askedTo: string;
}

const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` day an address names, or "" for anything else. */
function dayOf(raw: string | null): string {
  const value = (raw ?? "").trim();
  return UTC_DAY.test(value) ? value : "";
}

/** "from 18 Oct 2026 to 16 Nov 2026", or "" when the question has no period. */
function askedPeriod(from: string, to: string): string {
  if (from !== "" && to !== "") return ` from ${formatDate(from)} to ${formatDate(to)}`;
  if (from !== "") return ` since ${formatDate(from)}`;
  if (to !== "") return ` until ${formatDate(to)}`;
  return "";
}

function viewOf(address: ConversationsAddress): ListView {
  const question = (address.question ?? "").trim();
  return {
    search: toConversationSearch(address.q ?? ""),
    flags: flagsOf(address.filter),
    days: daysOf(address.days),
    question,
    // A period only narrows a question; without one it means nothing.
    askedFrom: question === "" ? "" : dayOf(address.askedFrom),
    askedTo: question === "" ? "" : dayOf(address.askedTo),
  };
}

/** The address query for a view; what is not set is left out. */
function viewQuery(view: ListView): Record<string, string> {
  const filter = flagsParam(view.flags);
  return {
    ...(view.search === "" ? {} : { q: view.search }),
    ...(filter === "" ? {} : { filter }),
    ...(view.days === "" ? {} : { days: view.days }),
    ...(view.question === "" ? {} : { question: view.question }),
    ...(view.askedFrom === "" ? {} : { askedFrom: view.askedFrom }),
    ...(view.askedTo === "" ? {} : { askedTo: view.askedTo }),
  };
}

/**
 * A conversation's address names its assistant too, so a shared link opens
 * under the right assistant and switching assistants does not carry it over.
 */
function conversationQuery(conv: ConversationSummary): Record<string, string> {
  return { id: conv.id, assistant: conv.assistantId };
}

/**
 * The address as last arrived at: the first one, then each move, Back and
 * Forward (`popstate`). The screen's own `replaceQueryParams` writes are not
 * moves, so they leave it as it was.
 */
interface ConversationsAddress {
  path: string;
  id: string | null;
  assistant: string | null;
  q: string | null;
  filter: string | null;
  days: string | null;
  question: string | null;
  askedFrom: string | null;
  askedTo: string | null;
}

function readAddress(): ConversationsAddress {
  return {
    path: window.location.pathname,
    id: readQueryParam("id"),
    assistant: readQueryParam("assistant"),
    q: readQueryParam("q"),
    filter: readQueryParam("filter"),
    days: readQueryParam("days"),
    question: readQueryParam("question"),
    askedFrom: readQueryParam("askedFrom"),
    askedTo: readQueryParam("askedTo"),
  };
}

/**
 * The open conversation follows the address, so Back and a shared link both
 * work. The shell keeps the address's assistant and the selection together:
 * a switch drops the open conversation from the address, and Back restores
 * the assistant the address names. What is left is an address naming an
 * assistant that is not in the list: it opens nothing and is cleared, so its
 * actions cannot land on the assistant shown instead.
 */
function useConversationsAddress(assistantId: string): {
  openId: string | null;
  address: ConversationsAddress;
} {
  const [address, setAddress] = useState(readAddress);
  useEffect(() => {
    const onPopState = () => setAddress(readAddress());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const otherAssistant = address.assistant !== null && address.assistant !== assistantId;
  useEffect(() => {
    if (otherAssistant && address.id !== null) {
      window.history.replaceState(
        window.history.state,
        "",
        screenAddress(LIST_PATH, { assistant: assistantId }),
      );
      setAddress(readAddress());
    }
  }, [otherAssistant, address.id, assistantId]);
  return { openId: otherAssistant ? null : address.id, address };
}

/**
 * Whether `address` is this assistant's list, rather than a conversation or
 * another screen. `shows` is the shell's: every path the router takes to this
 * screen counts (`/admin/conversations/`, or `/admin` when it is the default),
 * not only `LIST_PATH`.
 */
function isListAddress(
  address: ConversationsAddress,
  assistantId: string,
  shows: (path: string) => boolean,
): boolean {
  return (
    shows(address.path) &&
    address.id === null &&
    (address.assistant === null || address.assistant === assistantId)
  );
}

/** What "Getting search ready" says, with how many messages are left when the engine says. */
function searchReadyDescription(remaining: number | undefined): string {
  const left =
    remaining === undefined || remaining <= 0
      ? ""
      : remaining === 1
        ? " 1 message left."
        : ` ${remaining.toLocaleString()} messages left.`;
  return `Older messages are being prepared for search. This happens once, and the results show here when it is done.${left}`;
}

function ConversationRow({ conv }: { conv: ConversationSummary }) {
  const messages = conv.turnCount === 1 ? "1 message" : `${conv.turnCount} messages`;
  return (
    <li className="conv-item">
      <ScreenLink to="conversations" query={conversationQuery(conv)} className="conv-row">
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
  const { openId, address } = useConversationsAddress(assistantId);
  const { shows } = useAdminNavigation();
  const [offset, setOffset] = useState(0);
  const [initialView] = useState(() => viewOf(address));
  const [searchInput, setSearchInput] = useState(initialView.search);
  // What is sent: the box, cut to the length the list accepts. A pasted
  // question longer than that still finds its conversations by its start.
  const [search, setSearch] = useState(initialView.search);
  const [flags, setFlags] = useState<ReadonlySet<FlagKey>>(initialView.flags);
  const [days, setDays] = useState(initialView.days);
  const [question, setQuestion] = useState(initialView.question);
  const [askedFrom, setAskedFrom] = useState(initialView.askedFrom);
  const [askedTo, setAskedTo] = useState(initialView.askedTo);
  // Back, Forward and links that arrive at the list bring what it shows with
  // them (search, flags, dates, question): the address is what the screen
  // shows. Followed during render, not in an effect, so the effect below that
  // writes the view into the address never sees the arrived address beside
  // the view it replaced. A part already on show is left as it is (the box
  // mid-typing, on a switch of assistant, say).
  const [followedAddress, setFollowedAddress] = useState(address);
  if (followedAddress !== address) {
    setFollowedAddress(address);
    if (isListAddress(address, assistantId, shows)) {
      const arrived = viewOf(address);
      let changed = false;
      if (arrived.search !== search) {
        setSearchInput(arrived.search);
        setSearch(arrived.search);
        changed = true;
      }
      if (flagsParam(arrived.flags) !== flagsParam(flags)) {
        setFlags(arrived.flags);
        changed = true;
      }
      if (arrived.days !== days) {
        setDays(arrived.days);
        changed = true;
      }
      if (arrived.question !== question) {
        setQuestion(arrived.question);
        changed = true;
      }
      if (arrived.askedFrom !== askedFrom || arrived.askedTo !== askedTo) {
        setAskedFrom(arrived.askedFrom);
        setAskedTo(arrived.askedTo);
        changed = true;
      }
      if (changed) setOffset(0);
    }
  }
  const view: ListView = { search, flags, days, question, askedFrom, askedTo };
  const query = viewQuery(view);
  const queryKey = new URLSearchParams(query).toString();
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

  // What the list shows (search, flags, dates, question) is kept in the
  // address, so a reload, a copied link and an assistant switch (which keeps
  // the query) show the same list, and a cleared filter stays cleared. Only
  // while the list is what the address shows, at any path the router takes
  // here: a Back waiting for an answer has moved it to another place.
  useEffect(() => {
    if (openId !== null || !shows(window.location.pathname)) return;
    const named = readQueryParam("assistant");
    if (named !== null && named !== assistantId) return;
    const values = Object.fromEntries(new URLSearchParams(queryKey));
    replaceQueryParams({
      q: values.q ?? null,
      filter: values.filter ?? null,
      days: values.days ?? null,
      question: values.question ?? null,
      askedFrom: values.askedFrom ?? null,
      askedTo: values.askedTo ?? null,
    });
  }, [queryKey, openId, assistantId, shows]);

  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
    ...query,
  });
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
        // A move straight to another conversation starts afresh, rather than
        // showing the last one's transcript and actions under the new id.
        key={openId}
        assistantId={assistantId}
        conversationId={openId}
        onBack={() => {
          // The list comes back as it was, in the address too.
          navigateTo(screenAddress(LIST_PATH, { assistant: assistantId, ...query }));
          listRes.reload();
        }}
      />
    );
  }

  const page = listRes.value;
  const filtered = flags.size > 0 || days !== "" || search !== "" || question !== "";
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
    setQuestion("");
    setAskedFrom("");
    setAskedTo("");
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

      {question !== "" && (
        <div className="list-question">
          <span className="list-question-text" title={question}>
            {/* A long question's link carries only its start. */}
            Asked: “{question}
            {isQuestionLinkStart(question) ? "…" : ""}”{askedPeriod(askedFrom, askedTo)}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-label={`Remove “Asked: ${question}${isQuestionLinkStart(question) ? "…" : ""}”`}
            onClick={() => {
              setQuestion("");
              setAskedFrom("");
              setAskedTo("");
              setOffset(0);
            }}
          >
            Remove
          </button>
        </div>
      )}

      {listRes.status === "error" ? (
        <ErrorState
          title="Could not load conversations."
          detail={listRes.error}
          onRetry={listRes.reload}
        />
      ) : !page ? (
        <ListSkeleton />
      ) : page.searchPending === true ? (
        <div role="status">
          <EmptyState
            icon="conversations"
            title="Getting search ready"
            description={searchReadyDescription(page.searchRemaining)}
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
