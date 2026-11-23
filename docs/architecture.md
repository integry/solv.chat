# solv.chat architecture

This document is the specification for the open-source engine. When a task and
this document disagree, the task's issue text wins for that task and this
document is updated in the same pull request.

## What it is

A chatbot a site owner embeds on their website. Visitors ask questions; the
assistant answers from the owner's own content and, when the owner allows it,
calls tools on MCP servers the owner has configured. Owners read the
conversations, see which questions went unanswered, and fix the gaps.

One account manages many assistants (one per site). Everything runs on
Cloudflare: one Worker, D1, Vectorize, R2 and Queues.

## Open core and cloud

| Lives here (Apache 2.0)            | Lives in the closed cloud repo   |
| ---------------------------------- | -------------------------------- |
| Chat engine, retrieval, MCP client | Sign-up and login for the public |
| Embeddable widget                  | Teams and roles                  |
| Ingest CLI and GitHub Action       | Billing and usage metering       |
| Multi-assistant admin              | Managed model keys               |

The engine must run complete for a self-hoster with their own provider keys.
The cloud layer plugs in through the seams listed under "Extension seams"; it
never forks engine code.

## Packages

```
packages/
  core/     Shared types, IDs, validation schemas. No runtime dependencies on Cloudflare.
  engine/   The Worker: public chat API, ingest API, admin API, serves widget and admin.
  widget/   Dependency-free web component, built to a single JS file.
  admin/    React single-page app, served by the Worker as static assets.
  cli/      `solv` command: push content, run tests, apply solv.config.
```

npm workspaces, TypeScript everywhere, Node 24.

## Data model (D1)

Every table carries `org_id`. A self-hosted install has exactly one org, created
on first run. No query may omit the `org_id` filter; route handlers receive it
from the auth seam and pass it down.

- `orgs` — id, name.
- `assistants` — id, org_id, name, public_key (used by the widget), allowed_origins,
  tried_at and widget_seen_at (first "Try it" question and first widget
  configuration request on an allowed origin; set once, for the Overview checklist), and content_changed_at
  (when its searchable content last changed: chunks committed with new
  vectors, documents deleted, a Rebuild queued; see "Index lag").
- `assistant_versions` — id, assistant_id, state (`draft` | `published` | `archived`),
  config JSON (behaviour, widget, tool allowlist), created_at, published_at.
  Exactly one draft and at most one published version per assistant. Publishing
  promotes the draft row itself to `published` (it keeps its id, so a "Try it"
  conversation started against the draft still resolves), archives the previous
  published version, and inserts a fresh draft with the same config; rollback
  republishes an archived version.
- `sources` — id, assistant_id, kind (`push` | `sitemap` | `entry`), label, settings.
  A sitemap source's settings are `url` (the sitemap), `sync` (`off` | `daily` |
  `weekly`; left out means `off`), `maxRemovePercent` (1–100, default 50) and
  `recheckDays` (1–365, default 7); see "Scheduled sitemap sync". Every
  source also has repeated_blocks: the hashes of the text blocks that repeat
  across most of its pages, as last worked out, with repeated_pending (the
  hashes whose change of status some pages may not have been queued for yet),
  repeated_rev (how many times repeated_blocks was stored), repeated_owed
  (how many times its pages were removed; never lowered), repeated_reconciled
  (the repeated_owed a reconciliation read and then ran through; it owes one
  while repeated_owed is higher) and repeated_pages_rev (how many times one
  of its pages was committed with its blocks or deleted, kept by triggers on
  `documents`); see "Repeated blocks".
- `documents` — id, source_id, external_id, url, title, content_hash, updated_at,
  indexed_hash (the content last made searchable), index_error and
  index_error_hash (a short code saying why the content with that hash could
  not be indexed: `too_long`, `missing_body` or `embedding_failed`; never a
  provider message), and for sitemap sync: etag, last_modified and
  sitemap_lastmod (validators from the last check) and sync_checked_at (when
  a check last succeeded), and ingest_version (the ingest version its chunks
  were built with) and page_version (for a fetched page, the version of the
  HTML extraction its stored text came from; NULL otherwise); see
  "Re-indexing".
  Also repeated_key: which of its blocks were repeated across its source
  when its chunks were built (`''` for none, a hash of their hashes
  otherwise; NULL until its blocks are recorded, and always for written
  answers); see "Repeated blocks".
- `document_blocks` — org_id, source_id, document_id, block_hash: the
  distinct block hashes of each indexed page of a push or sitemap source.
  Hashes only, never text. Deleted with the document.
- `source_blocks` — org_id, source_id, block_hash, pages: on how many of the
  source's pages each hash is, kept by triggers on `document_blocks`.
- `source_syncs` — org_id, source_id, run_id, lease_until (set while a run
  holds the source), started_at, finished_at, outcome (`running` |
  `succeeded` | `partial` | `failed`), counts (added, updated, unchanged,
  removed, failed, deferred, withheld: removals a run refused by the wipe
  guard would have made) and error
  (a short code). One row per source: the current or latest run.
- `source_sync_pages` — org_id, run_id, source_id, url, lastmod, state
  (`pending` | `added` | `updated` | `unchanged` | `failed`): the pages one run
  queued. Deleted when the source's next run starts.
- `source_sync_attempts` — org_id, source_id, url, attempted_at: when a run
  last queued each page of the source, new or already a document, whatever
  came of it. Kept across runs; a page no longer listed is forgotten by the
  next run that reads the whole sitemap.
- `sync_org_refusals` — org_id, refused_at: when the auth seam last refused
  the org at a scheduler tick (see "Scheduled sitemap sync").
- `chunks` — id, document_id, ordinal, text, heading_path. Vectors live in Vectorize
  keyed by chunk id, with `org_id` and `assistant_id` as metadata filters. A
  written answer has one more chunk than its text needs: the same text as its
  first chunk, embedded as its question alone (see "Chunks and embeddings").
- `retired_chunks` — id, org_id, document_id, text, heading_path, retired_at,
  revision: the chunks a re-index or update replaced, kept for
  `RETIRED_CHUNK_KEEP_MS` so a search that still returns their vectors finds
  their text. `revision` counts the document's replacements (one value per
  commit). Deleted with the document; see "Index lag".
- `conversations` — id, assistant_id, visitor_id (random, cookie-less; stored in
  the widget's localStorage), started_at, page_url, last_message_at (when the
  newest message was written, `started_at` while there is none; kept by
  triggers, and the order of the Conversations list), visitor_messages_reserved
  (visitor messages admitted under the conversation cap; see "Visitor check").
- `messages` — id, conversation_id, role, content, citations JSON, tool_calls JSON,
  tokens_in, tokens_out, answered (boolean: did retrieval find support),
  search_text (content in Unicode lowercase, NFC, final sigma "ς" as "σ",
  whitespace runs collapsed like the question key, for the Conversations search. For rows written before it
  existed, the migration fills it for ASCII text and the engine folds the rest
  of the searched assistant's messages before it runs a search, a bounded
  share per request; until none are left a search answers `searchPending: true`
  with no results instead of searching), and for assistant replies
  first_token_ms and total_ms (milliseconds from the request to the first
  token sent to the visitor, and to the complete reply; NULL for replies
  written before migration 0026, and for a paused reply they are the first
  request's).
  For assistant replies to visitors, also outcome (`answered` | `partial` |
  `declined` | `off_topic` | `wants_human`, or NULL when not reviewed) and
  outcome_confidence (0-1, NULL when the reviewer cannot give one; nothing
  reads it yet). See "Answer review".
  For assistant replies, also citations_shown (1 when the visitor was shown
  the list of sources under the answer, 0 when the version showed none:
  "Show sources in answers" on "Link in the text" without "List sources
  under answers", or "None"; 1 for rows written before migration 0034). The
  citations are stored either way.
  For visitor questions, topic_id (the question's topic, or NULL: not
  reviewed, or its topic was deleted; indexed on its own, so deleting a topic
  finds its questions without reading every message). See "Topics".
- `topics` — org_id, assistant_id, id, name, name_key (the name in NFKC
  lowercase with whitespace collapsed; unique per assistant), created_at.
  Deleted with the assistant.
- `message_traces` — org_id, message_id, detail JSON, created_at, updated_at;
  one row per assistant reply to a visitor, keyed (org_id, message_id) and
  deleted with its message. See "Answer traces".
- `preview_traces` — org_id, id (the reply id the preview's `done` event
  carried), assistant_id, source (`try_it` | `test_run`), run_id and test_id
  (a test run's), tokens_in, tokens_out, cost_micros, detail JSON (the same
  shape as `message_traces`), created_at: how a "Try it" or test-run answer
  was made, since neither stores a message. No report reads it. Deleted with
  the assistant, and each write keeps only the assistant's newest 200
  (`MAX_PREVIEW_TRACES`). See "Answer traces".
- `message_documents` — org_id, message_id, document_id: the documents an
  assistant reply to a visitor was given to answer from, every kind (pages,
  pushed documents, written answers), once each; written with the reply (and
  by a resume, under its claim) and deleted with it. Internal: citations keep
  only public addresses, and nothing here reaches a visitor. `document_id`
  has no foreign key, so deleting a document keeps the record. See "Reports".
- `feedback` — message_id, value (`up` | `down`), note.
- `mcp_servers` — id, assistant_id, label, url, auth_kind (`none` | `static_header`),
  header_name, secret_ciphertext, test_secret_ciphertext (optional encrypted test key),
  enabled, send_conversation_context (default 0;
  see "Conversation context headers").
- `mcp_tools` — server_id, name, description, input_schema, allowed (default false).
- `tests` — id, assistant_id, question, expectation (must-cite URL, must-contain,
  must-not-contain, or must-decline).
- `test_runs` — id, version_id, started_at, results JSON, passed.
- `usage_daily` — org_id, assistant_id, day, messages, tokens_in, tokens_out, cost_micros.
- `org_provider_settings` — org_id, the stored provider choices (see "Provider
  settings") and review_answers (the "Review answers" switch; NULL is the
  default, on).
- `gap_dismissals` — org_id, assistant_id, question_key, dismissed_at. A dismissed gap
  group is hidden until the question is asked again after `dismissed_at`.
- `visitor_check_tokens` — token_hash (SHA-256 of a Turnstile token, the key),
  org_id, expires_at: tokens already exchanged for a visitor session, kept for
  the token's 300-second life. Keyed on the hash alone, because a token is the
  operator's and may be spent once across every org. Not written for a test
  secret. See "Visitor check".
- `visitor_counters` — org_id, assistant_id, counter (`visitor_day` | `ip_day` |
  `ip_sessions_hour`), subject (an HMAC of the visitor id or IP, never the value),
  window_start, hits: the per-visitor caps. See "Visitor check".

Migrations are plain SQL files under `packages/engine/migrations`, applied with
`wrangler d1 migrations`.

## Public API (called by the widget)

- `POST /v1/chat` — body: assistant public key, conversation id (optional), message.
  The body also carries a protocol version; the engine refuses a version it does
  not support with an `error` event, and clients ignore event types they do not
  know. Responds with server-sent events: `token`, `citation`, `tool`, `done`,
  `error` (and `action` from phase 2). The optional `toolCredentials` object
  holds up to 8 raw tokens of up to 4,096 characters each, keyed by the
  exact HTTPS endpoint URL. It may accompany a new question or continuation.
  The route hands it only to the per-request MCP runner. Logs, traces,
  conversations, reports and model requests never receive the field.

  An answer that needs a page action pauses rather than waiting on the open
  stream: the engine emits `action` events and then `done` with
  `awaitingActions`, and the widget runs them and sends a second request with
  the same conversation id, `resumeMessageId` and `actionResults`, and no
  `message`. A held-open stream would not survive `navigate`, which replaces
  the page the stream belongs to.
- `POST /v1/feedback` — thumbs up or down on a message.
- `GET /v1/assistants/:publicKey` — published widget config (title, colours,
  launcher label and shortcut, opening mode, greeting, suggested questions,
  `visitorCheck: true` when the visitor check runs, and `pageToolServerUrls`
  when the published version has enabled servers that take visitor keys).
  The widget revalidates the list before sending any held token.
  No secrets, no prompts. The response has an `ETag` for the JSON bytes and
  `Cache-Control: private, max-age=60, must-revalidate, no-transform`. Both
  200 and 304 responses vary on `Origin`. Origin and limit checks happen
  before accepting a validator. The browser can reuse a fresh response for
  up to one minute after publishing. A tab restoring an open panel from
  saved configuration asks the browser to revalidate it in the background.
- `POST /v1/session` — exchanges a Turnstile token for a visitor session (see
  "Visitor check"). Answers 404 when the check is off.
- `GET /v1/check/frame` — the page the widget frames to run Turnstile on the
  engine's origin. 404 when the check is off.
- `GET /v1/check/frame.js` — the public script for that page.
- `GET /widget.js` — the widget bundle.
- `GET /boot.js` — the inline first-paint script, also published by the widget package.

These script URLs are stable and send
`Cache-Control: public, max-age=300, must-revalidate, no-transform` and a
strong `ETag` based on the SHA-256 hash of the response bytes. Five minutes
of freshness keep repeat page views from fetching the script. After that,
the next load revalidates before using the cached copy. The Worker sends a
bodyless 304 when `If-None-Match` matches and the new script when the bytes
have changed. Once this policy is in effect, a cached copy can delay a
release by up to five minutes. Returning visitors get the release on their
first load after the cached copy expires. A CDN in front must honor these
headers, including `no-transform` to preserve the bytes the strong tag
identifies.

With the visitor check on, the requests that cost money or write carry the
visitor session in the body's `session` field: `POST /v1/chat` (model,
embedding and tool calls; it writes the conversation), including a request
continuing a paused answer, and `POST /v1/feedback` (it writes a row). The
config read writes only the Overview's one-time "widget seen" mark and costs
nothing, and the widget must read it before any check may run, so it carries
none.

Checks on every public request, in this order: Origin against the assistant's
`allowed_origins`; the visitor session, when the check is on (and a
configuration refusal when it is half set up); per-IP rate limit; the
assistant's daily spend cap; then, on a new visitor message, the per-visitor
caps. A request that fails one gets a plain error event (or a JSON error) and
costs nothing: no model, embedding or tool call. Error events from the
visitor check and the caps carry a `code` (`check_required`, `check_config`,
`visitor_cap`, `ip_cap`, `conversation_cap`) so the widget can act on them;
older widgets ignore it and show the message.

## Visitor check

Nothing else proves that a chat request comes from a real browser on the
owner's page: a script can set `Origin`, and rotating addresses beats the
per-IP rate limit, so a script could use up an assistant's daily spend cap
and lock real visitors out. When an instance is configured for it, every
visitor's browser passes Cloudflare Turnstile and the engine issues a signed
session that public requests must carry.

**Configuration.** `SOLV_TURNSTILE_SITE_KEY` (a variable) and
`SOLV_TURNSTILE_SECRET` (a secret), read through the optional
`VisitorCheckProvider` seam (below). Neither set: the check is off and the
public chat behaves exactly as before; the admin shows a standing warning
that visitor chat is unprotected. One set, or both without `SOLV_SECRET_KEY`
to sign sessions with: the public chat refuses every request with
`check_config` ("This chat is not set up correctly.") and the admin names
what is missing. There is no per-assistant switch. Turnstile's documented
test keys work and are flagged: the admin warns that they let everyone
through.

**Where the challenge renders.** A Turnstile widget runs only on the
hostnames registered for it (at least one, no wildcards, a registered
hostname covers its subdomains, 10 per widget on the free plan; "Any
Hostname" is Enterprise only:
https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/).
Owners' sites are hostnames the operator does not control, so the challenge
runs in a frame served by the engine's own origin (`/v1/check/frame`): the
operator registers the engine's hostname once, and `siteverify` reports that
hostname, which the engine checks. The documentation does not rule frames
out; the frame's page carries the policy Turnstile documents (`script-src`
and `frame-src` `https://challenges.cloudflare.com`) and `frame-ancestors`
naming the one host origin it was opened for, accepted only when that
origin is in the assistant's allowed websites. The frame posts to that origin
only; the widget accepts a message only when `event.origin` is the engine's
origin and `event.source` is its own frame. Nothing from Turnstile loads on
the host page, so a host site's Content-Security-Policy needs the engine
origin in `script-src`, `connect-src` and `frame-src` and nothing else.

**When it runs.** Turnstile waits for the visitor. The widget creates the
frame when the visitor focuses or types in the message input, picks a
suggested question, uses the keyboard shortcut, or opens the assistant through
a host-page trigger. A message submitted through `send()` also starts the
check. The launcher moves focus to the input without starting
the check. The frame renders Turnstile explicitly, in managed mode
with `appearance: "interaction-only"`, `retry: "never"`, action
`solv-chat` and `cData` set to the frame's binding (64 hex characters: the
SHA-256 of `solv.chat check v1`, the assistant's id and the parent origin,
each on its own line; `cData` allows 255 letters, digits, `_` and `-`), and
posts back the token, an error, or that the challenge needs
the visitor (`before-interactive-callback`). The frame sits in a collapsed
area of the panel, so creating it moves nothing; it opens above the input
only for an interactive challenge, at Turnstile's flexible size (100% wide,
at least 300 px, 65 px high), and is in the tab order only then. Its theme
follows the widget's. A message sent while the check runs waits in the
usual empty "thinking" bubble and is sent once a session arrives. If the
frame says nothing for 15 s, Turnstile says nothing for 30 s without asking
the visitor to act, or it reports an error, the check has failed: the
waiting message's bubble (or, with none waiting, a notice with **Try again**)
says "The security check could not be completed. Check your connection, then
try again." and no request is sent. A continuation after a page action's
navigation uses the stored session and runs the check only if it has
expired; the best-effort "visitor moved on" notice never starts one.

**Session.** As soon as Turnstile issues a token the widget posts it to
`POST /v1/session` (`protocol`, `assistant`, `visitorId`, `token`). In order:
Origin; a configuration refusal; the Limits seam's `config` action (per-IP
rate limit and spend cap: an exchange costs no model call); expired rows of
`visitor_check_tokens` are deleted, then the token's hash is inserted, and a
token already there is refused (Turnstile's own reuse detection is eventually
consistent, so two exchanges seconds apart could both pass it); `siteverify`
with the secret, the token and `cf-connecting-ip`, within 5 s; `success` must
be `true`, `hostname` the engine's own, `action` `solv-chat` and `cdata` the
binding for the assistant the body names and the request's Origin. The
binding is what ties a token to the assistant and page its challenge ran
for: every assistant shares the engine's keys and hostname, so without it a
token collected through one assistant's frame on its page could be
exchanged, with a forged Origin, for another assistant's session. A test
secret always answers `example.com` and no action or `cdata`, which is
accepted only for a test secret, and accepts only the one fixed dummy token,
so a test secret's exchange skips the spent-token record (otherwise the
always-pass keys would issue one session and then refuse every visitor) and
still goes to `siteverify`, so the always-fail and spent-token test secrets
refuse every time;
anything else, including a timeout, a non-200 or a body that is not JSON, is a
refusal (`check_failed`, logged with Turnstile's error codes only); then the
sessions-per-IP cap (`session_cap`). The answer is `{ session, expiresAt }`.

A session is `vs1.<expiry>.<nonce>.<mac>`: an HMAC-SHA-256, under a key
derived from `SOLV_SECRET_KEY` with HKDF under its own label (`solv.chat
visitor session v1`, apart from the admin cookie and stored-credential keys),
over the org, assistant and visitor id, the expiry and the nonce. The org and
assistant are signed, not written, so a session verifies only for the
assistant (and so the org) the engine resolved from the request's public key
and only for the visitor id in the body, and shows a reader nothing else. It
lasts one hour (`VISITOR_SESSION_TTL_MS`): a Turnstile token lasts 300 s and
may be redeemed once, so the session must carry a whole visit (some pages,
several questions) on one check; an hour does, matches the window the
sessions-per-IP cap counts in, and bounds a session copied from a browser.
The widget keeps it in `sessionStorage` per assistant, and in memory as
well, so a page that blocks storage still uses one check for the visit
(both copies are checked against the assistant, visitor id and expiry, and
both are forgotten on `check_required`). It renews it with a
fresh check when it has under a minute left, or after the engine refuses it
(`check_required`). The exchange, response body included, has 15 s
(`CHECK_EXCHANGE_TIMEOUT_MS`: the engine's 5 s for `siteverify` and room for
the network both ways); past that the request is aborted and the check has
failed as above. An exchange that answers after its check has ended is
ignored, so it cannot end a later check.

**Owner surfaces are not challenged.** "Try it", test runs and everything
under `/api/admin/*` use the admin session and are not counted against the
caps.

**Caps.** Turnstile stops scripts, not a person or a driven browser, so
behind the session, the rate limit and the spend cap (which are unchanged),
a new visitor message is refused when:

| Cap                              | Variable                      | Default | Code and message                                                                                                                                  |
| -------------------------------- | ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Messages per visitor per UTC day | `SOLV_VISITOR_DAILY_MESSAGES` | 100     | `visitor_cap`: "You have reached today's limit for questions. Please come back tomorrow."                                                         |
| Messages per IP per UTC day      | `SOLV_IP_DAILY_MESSAGES`      | 500     | `ip_cap`: "Too many questions have come from your network today. Please come back tomorrow."                                                      |
| Messages per conversation        | `SOLV_CONVERSATION_MESSAGES`  | 50      | `conversation_cap`: "This conversation has reached its limit. Your next question starts a new one." (the widget then forgets the conversation id) |
| Sessions per IP per hour         | `SOLV_IP_HOURLY_SESSIONS`     | 30      | `session_cap` on `POST /v1/session`: "Too many security checks have come from your network. Please try again in an hour."                         |

Each is per assistant (so per org), a whole number, `0` for none. The
visitor cap is keyed by the session's visitor id, so renewing a session does
not reset it; a script minting visitor ids is held by the IP caps. The engine
has no usage history to set the defaults from, so they come from the limits
it has: the per-IP rate limit allows 20 questions a minute, and a person
reading answers asks at most about one a minute, so 100 a day is more than an
hour of non-stop questions to one assistant; an IP is often shared (an office,
a school, a carrier), so 500 is five such visitors; the model only sees the
last 6 turns, and 50 questions in one conversation is far past a support
exchange; one session an hour per tab makes 30 an hour thirty people behind
one address.

Counters live in D1, like the rate limit: per new message, when the request
names a conversation, one update that takes a slot of its cap
(`conversations.visitor_messages_reserved`, compared with the higher of it
and the conversation's stored visitor messages, so two simultaneous requests
cannot both take the last slot; one more read when no conversation of this
assistant and visitor has the id, which then starts a new one), and one
batch of one upsert and one read: the upsert adds a hit to both daily
counters only when both are under their caps, judged in the same statement,
so a refused message uses up neither (a visitor past their own cap cannot
use up their network's) and two simultaneous requests cannot both take a
last hit; the read says which cap refused (when a daily cap refuses the
message, its conversation slot is given back);
per session issued, one upsert, plus the spent-token insert and an expired-row
delete. A slot stays taken once a message is admitted, even if its answer
then fails: the question is stored before any answer. The first hit of a new window deletes the org's older windows of that
counter. A session check is CPU only (one HKDF and one HMAC).

**Privacy.** No token, session or IP is stored with conversations; the two
tables above hold a token hash and keyed hashes. Nothing records a refusal
beyond the refused response and, for a refused token, a log line with
Turnstile's error codes. Turnstile processes the visitor's IP address, TLS
fingerprint, user agent, and the site key and origin it runs on (Turnstile
Privacy Addendum, https://www.cloudflare.com/turnstile-privacy-policy/), not
what the visitor types; the Install screen tells owners to mention Cloudflare
Turnstile in their privacy notice and lists the policy allowances.

**Hosted build.** The cloud layer passes `visitorCheck: { required: true,
keys: () => ({ siteKey, secret }) }` in `Seams` to supply its own keys and to
make missing keys a configuration error rather than "unprotected", and
registers its engine hostname on its Turnstile widget. It must set
`SOLV_SECRET_KEY`.

## Ingest API

- `PUT /v1/ingest/:assistantId/documents` — bearer ingest key. Body: a batch of
  documents (external id, url, title, Markdown). Unchanged `content_hash` is a no-op.
- `DELETE /v1/ingest/:assistantId/documents` — by external id, or everything not in
  the pushed set (`prune`).
- Both work on one push source: `sourceId`, the push source named by `source` (a
  label, 1 to 80 characters, created on first push; one per label per assistant),
  or the assistant's default push source when neither is given. A prune never
  touches another source, so two pushers with different `source` labels cannot
  delete each other's documents.
- `GET /v1/ingest/:assistantId/config` — bearer ingest key. Returns the current
  draft config.
- `PUT /v1/ingest/:assistantId/config` — bearer ingest key. Validates and updates
  the draft config only (never publishes, rolls back, or reads history).
- `GET` / `PUT /v1/ingest/:assistantId/mcp-servers` — bearer ingest key. Reads
  or turns off "Send conversation context" on the assistant's MCP servers. `GET`
  returns `{ servers: [{ id, label, origin, sendConversationContext }] }`: the
  origin of each url only, never its path or query, a header name or a
  credential. `PUT` takes
  `{ servers: [{ url, sendConversationContext }], dryRun? }`, matches existing
  servers by url, refuses a url with no server, refuses `true` for a server
  whose setting is off (only a signed-in admin can turn it on), and changes
  nothing unless every entry is valid; servers it does not list keep their
  setting. With `dryRun: true` it validates and returns the would-be `changed`
  count without writing.

Ingest writes the document row, enqueues it, and a Queue consumer chunks, embeds
and upserts vectors. Until the consumer commits, the new content is not
searchable: the admin's Sources list says "Indexing…" for those documents
(content hash differs from the indexed hash), "Failed: reason" when the
consumer recorded an error for the current hash (every failed attempt records
one; a later success or a new push makes it stale), and "Ready" otherwise, and
it re-checks every few seconds while anything is indexing or has a failure
the Queue retries (every code but `too_long`), so a retry that succeeds turns
the row Ready. Content is pushed (CLI, GitHub Action), imported from a sitemap
(once, or again on a schedule; see "Scheduled sitemap sync"), or written by
hand as an entry. There is no crawler that follows links: only the pages a
sitemap lists are ever fetched.

Sitemap import fetches each chosen page through the `PageFetcher` seam (see
"Extension seams"), and the open build's extraction leaves page chrome out
(see "Page text"). The open build's fetcher validates every URL and redirect
hop as `https:` and checks the hostname via DNS-over-HTTPS before fetching,
refusing private, loopback, or link-local addresses. A page with no text is
written as its title alone; a response that is not a page or text (a PDF, an
image) is skipped and counted in the import's `skipped`. Because Workers
`fetch` resolves the hostname separately from that pre-check, a host that
changes its DNS answer between the check and the fetch (DNS rebinding) is not
caught. This is not limited to an action the signed-in owner starts: a
scheduled sync repeats the sitemap and page fetches unattended on every run,
against whatever the owner's URLs resolve to at that moment. It stays an
accepted limitation because the URLs are the owner's own (a sitemap they
added and the pages it lists), every hop is checked again on every run, and a
response is only capped, converted and stored as a document. Closing the gap
would need a fetch that connects to the checked address, which Workers
`fetch` does not offer.

A host that passes its own `fetch` (`createApp`'s `fetch` option) or its own
`PageFetcher` seam is responsible for the address checks. With a host `fetch`
the engine still refuses non-https URLs and literal private addresses, checks
each redirect hop's URL and caps size and time, but it skips the
DNS-over-HTTPS lookup, because it cannot know how that `fetch` resolves
names: refusing hostnames that resolve to private, loopback or link-local
addresses is then the host's job. A host `PageFetcher` replaces the open
build's fetcher for pages entirely, so every check for pages (https only,
each redirect hop, the address check, size cap and timeout) is the host's.

### Page text

A fetched HTML page becomes text without the parts every page repeats
(`extractHtml` in `ingest/htmlToMarkdown.ts`). Navigation, the site header
and footer, sidebars and "related" lists repeat on every page; indexed, they
are short chunks whose heading path is the page's own title, and they
matched every question about that title better than the page's real text
(issue #123).

- The page's own content is used when it marks it: its `main` (or
  `role="main"`), else its only `article`; a page with neither, or with
  several articles, is read whole. A `main` that holds no text (filled by a
  script) falls back to the whole page.
- Landmark regions are left out: `nav`, `footer`, `menu`, `dialog` and
  `template` wherever they are; any element whose `role` is `navigation`,
  `banner`, `contentinfo`, `complementary`, `search`, `menu` or `menubar`;
  an `aside` with no `role` that is not inside an article or section (in the
  body or directly in `main` it is the page's sidebar; inside an article or
  section it is part of that text, such as a note or a requirement); and a
  `header` outside an article, section or `main` (inside one it is that
  content's own header, with its title). Matching is
  nesting-aware, and an element never closed is kept rather than swallowing
  the rest of the page.
- What is left is split into blocks (paragraphs, lists, headings). A block
  with at least two links and at most a tenth of its letters and digits
  outside them is a list of links, not content, and is left out
  (`LINK_BLOCK_MIN_LINKS`, `LINK_BLOCK_MAX_OUTSIDE_SHARE`). A list whose
  items say something besides their link, prose with links, a paragraph that
  is one link (an email address) and a heading that is a link (a permalink)
  stay.

Pushed and written content is Markdown the owner chose and is not
filtered by markup. Pushed pages, like fetched ones, are still checked for
repeated blocks; written answers never are.

### Repeated blocks

The markup rules above miss a site built from plain `div`s with no
landmarks, and chrome that is prose rather than links: a cookie notice, a
newsletter pitch, a "need help?" box, an address. So a page of a push or
sitemap source also loses the blocks of text that repeat across a large
share of its source's pages, however they are marked up (issue #127;
`ingest/repeated.ts`, `ingest/repeatedSource.ts`). Written answers are
never touched. Nothing calls a model.

- **Blocks.** A page's stored Markdown is cut where the conversion cuts it:
  paragraphs, lists and fenced code blocks (each one block), and heading
  lines. Each paragraph, list or code block is one unit, and so is each
  heading together with the blocks up to the next heading; a heading is
  never a unit alone. Units are compared on their text in Unicode NFKC,
  lower case, with whitespace runs as one space. Digits are not folded: a
  site renders its footer the same on every page at one time, so its
  "© 2026" is shared already, and folding digits would make template text
  that differs only in its figures ("Price: $10 a month", "$20") one
  repeated block and lose each page's own figure. Only a 64-bit hash of
  each unit is stored (`document_blocks`; `b…` for a block, `h…` for a
  heading with its body), never the text.
- **Rule.** A unit is repeated when it is on at least 3 pages
  (`REPEATED_MIN_PAGES`) and at least half (`REPEATED_MIN_PERCENT`, 50) of
  the source's indexed pages; a source with fewer than 5 indexed pages
  (`REPEATED_MIN_SOURCE_PAGES`) has none. Chrome comes from the template, so
  it is on (nearly) every page; text reused on purpose (a "needs the Pro
  plan" note, a shared prerequisite) is on the pages it concerns, usually a
  minority, and its meaning depends on the page it is on. Half keeps that
  text, at the cost of missing chrome that only one section of a site
  carries. 3 pages only matters at 5 pages, where half is 2.5. The numbers
  are ours, from that reasoning and the #123 site, not from a measured set
  of sites.
- **What is left out.** A repeated block, unless it is more than half of
  its page's text (`REPEATED_MAX_PAGE_SHARE`: a contact page that is the
  footer's address keeps it); a heading, when the heading with its body is
  repeated and every block of that body is left out. "Overview" over a
  different body on each page is not repeated and stays. When this would
  leave a page no text but headings, nothing is left out of that page.
- **When.** The check runs in the queue consumer, before chunking, against
  the source's stored repeated blocks; the stored text (R2) keeps every
  block, so a page can be rebuilt without fetching it again. The commit
  records the page's hashes and its `repeated_key` in the same guarded
  batch as its chunks, and triggers keep `source_blocks` in step on every
  insert and delete (a commit, a prune, a sync's removals, a deleted
  source). After each commit, and after a push prune or a sync removes
  pages, `reconcileRepeated` works the repeated blocks out again from the
  counts (one statement: the source's page count and the `source_blocks`
  rows over the threshold) and stores them with a compare-and-set on both
  the set and `repeated_pages_rev`, read before counting: a page committed
  or removed while it counted changed the counts, even when it left the set
  as it was, so the run counts again rather than store a set from older
  counts (it tries three times; when every try loses it reports that it did
  not run through, and its message is retried). When they changed, every
  indexed page holding a hash whose status changed is
  queued (an ordinary chunk-and-embed message), and so is the page just
  committed if it was built with an older set. A queued page whose key
  still matches is acknowledged without work. The hashes whose status
  changed are added to `repeated_pending` in the statement that stores the
  new set, and every reconciliation queues the pages holding the pending
  hashes too, then removes them only after all its sends succeeded (and
  only if the set was not stored again meanwhile, by `repeated_rev`). So a
  send that fails after the set is stored, or a run that stops between its
  batches, loses no page: the next reconciliation queues them again, though
  the set itself is unchanged.
- **Determinism.** A page's chunks depend only on its text and which of its
  own hashes are repeated, and the repeated hashes depend only on the set
  of pages' hashes, so once the queue has run the same pages give the same
  chunks in any import order. The first four pages of a new source are
  indexed with their chrome; the fifth commit finds it repeated and queues
  them to be cleaned. Removing pages can bring a block back the same way.
- **Cost.** A block crossing the threshold (or falling back under it)
  re-embeds the pages it is on, once each: a new source pays its first
  four pages twice, and a block that hovers around half the pages can be
  paid for again on each crossing. Pages without the block are not
  touched. A page rebuilt into the very chunks it has (same text, heading
  paths and order, by an ingest version from `EMBEDDINGS_REUSABLE_FROM` on)
  keeps its vectors and costs a D1 write, not an embedding; that write is
  refused unless the document's chunks are still the ones compared (by id),
  and the message is then retried, so a build that replaced them in between
  is never recorded under this build's key. If the counting
  fails after a commit, the page stays committed and its message is retried
  rather than acknowledged; the retry rebuilds the page if it was built with
  an older set, and otherwise reconciles again (as does any message for an
  indexed page while hashes are pending). A removal raises the source's
  `repeated_owed` in the batch that deletes the pages, and a reconciliation
  that read it before counting and ran through records that value as
  `repeated_reconciled` (which only rises), so a removal after that read,
  which raised `repeated_owed` past it, stays owed even when the earlier
  reconciliation finishes after the later one. When the reconciliation after
  a removal fails, at any step, the removal sends a `repeated_source`
  message on the ingest queue, which is retried until a reconciliation runs
  through; any message for one of the source's indexed pages reconciles too
  while it is owed. Only when
  that send fails as well does the removal fail; the pages are gone and
  the obligation stays recorded, and the same request again (or the next
  sync run of the source), with nothing left to remove, reconciles.
- **Owner view.** Sources says on a source's row how many repeated blocks
  (paragraphs, lists and code blocks) are left out, and its documents panel
  lists them, with the first 80 characters of each and on how many pages it
  is, most first (`GET /api/admin/sources/:id/repeated-blocks`). The text is
  read back from the stored text of a few of the source's pages (at most
  five R2 reads), not stored for this. There is no setting.

### Chunks and embeddings

Documents are cut by heading into chunks of at most 1,200 characters
(`ingest/chunk.ts`), each with its heading path.

- **Minimum size.** No chunk has less than `MIN_CHUNK_CHARS` (200) characters
  of text unless it is its document's only chunk. A shorter one is merged
  into a neighbour: one under the same heading path that the two fit
  together within 1,200 characters (the previous, then the next), else the
  previous, else the next; when neither fits, the same-heading one, the
  previous or the next anyway (at most about 1,400 characters). Every merge
  must also reach the model whole: its `section:` line and text within the
  prompt's 2,000 characters per source (`fitsSourceBudget` in
  `chat/prompt.ts`), because the prompt cuts what is over and the cut part
  would be in no other chunk. A short chunk that no neighbour can take on
  those terms (long heading paths that share nothing) is kept as it is. The
  merged chunk keeps the headings the two share as its path and writes the
  others into its text, so no word or heading is lost. 200 is ours, from
  the data in issue #123: the chrome chunks that won were 45 to 74
  characters under heading paths of 40 to 60, so the path was most of what
  was embedded; 200 characters is two or three sentences, over three times
  those, and a sixth of a full chunk.
- **Embedding input** (`embeddingInput` in `ingest/consumer.ts`). A chunk is
  embedded as its heading path, then its text, with the path bounded to half
  the text's length (a third of the input), dropping the broadest headings
  first (the page title, then the next). The path tells the model what a
  section is about, but the page title is shared by every chunk of a page; a
  bounded share means the text always carries the vector, so a near-empty
  chunk cannot score on its title. A written answer, and a document that is
  one chunk, keep the whole path: there it is the subject, not a label
  repeated over other chunks.
- **Written answers' questions.** A written answer (an `entry`) also gets one
  chunk embedded as its question alone, holding the same text as its first
  chunk, so a visitor who asks the owner's question matches it almost
  exactly however long the answer is. Retrieval keeps one of the two (they
  are duplicates).

### Re-indexing

Each document records the ingest version it was built with (`ingest_version`)
and, for a fetched page, the extraction version of its stored text
(`page_version`); the engine's are `INGEST_VERSION` and `PAGE_TEXT_VERSION`
in `ingest/version.ts` (`PAGE_TEXT_VERSION` 3 since issue #128,
`INGEST_VERSION` 3 since issue #127; everything stored before #123 is 1,
and `page_version` NULL). Version 3 adds the repeated-block check, so each
document indexed by version 2 is read once to record its blocks; one whose
chunks come out the same keeps its vectors (see "Repeated blocks"), so
after the upgrade only pages that lose a repeated block are embedded
again. A version is bumped when a change to
its part would make existing documents worse than new ones.

- A document indexed by an older ingest version is rebuilt from its stored
  text: the consumer, given a message for a document whose content is
  indexed but by an older version, chunks and embeds it again and commits it
  with the current version (the commit's guard admits it once, so two
  messages for one document commit once). A push of unchanged text queues
  such a document too, and still counts it as unchanged.
- **Rebuild** (Sources, `POST …/assistants/:id/reindex`) queues every
  document of the assistant whose content is indexed by an older ingest
  version, up to 1,000 per request (`REINDEX_MAX_DOCUMENTS`; the answer
  says how many are left). It asks `Limits` with `{ kind: "ingest" }`
  first, like any ingest, and answers 429 when refused. Nothing is fetched,
  so a page keeps the text its old extraction made until it is fetched
  again. It costs what indexing the same content again costs: the
  embedding of every chunk, metered through `UsageSink` as it is billed.
  Pressing it again before the queue has run queues the same documents
  again; each is still rebuilt once.
- A **scheduled sync** fetches a page whose `page_version` or
  `ingest_version` is older than the engine's in full, once: it is not
  skipped on an unchanged `<lastmod>` and is asked without validators, so
  no 304 keeps the old text. Unchanged text is then queued to be rebuilt
  (and counted as unchanged); changed text is an ordinary update. The run's
  caps, `Limits.checkSync` and the usage seam apply as to any run, so the
  first syncs after an upgrade fetch every page of a source again (up to
  the per-run page cap) and pay for their embeddings once. The one-time
  import records the current `page_version` for the pages it fetched.

### Index lag

Vectorize applies every write asynchronously ("It typically takes a few
seconds for inserted vectors to be available for querying", and the same
for upserts and deletes; a large batched load is visible "within minutes"),
in the order the writes were made (`processedUpToMutation`: "All changes
before this mutation will be reflected in the index state"). The sources
are cited in `ingest/indexLag.ts`. No upper bound is documented. So for a
while after content is imported, rebuilt, updated or deleted, a search
returns vectors whose chunks are gone and not yet the new ones (issue #131).

- **Order of a rebuild.** The consumer writes the new vectors, then commits
  the new chunks, then deletes the old vectors. Since the index applies
  writes in order, a rebuilt page always has vectors in it: the old ones
  until the delete is applied, by then the new ones too. The commit moves
  the old chunks to `retired_chunks` instead of dropping them, and a hit on
  one of their vectors resolves to that text for `RETIRED_CHUNK_KEEP_MS`
  (an hour, ours: the slowest the documentation describes is "at least an
  hour" for unbatched writes), unless a current chunk of the same document
  is among the hits (the new content already shows). When none is, only
  the newest replaced version among the hits is read: after two updates in
  quick succession the index can return vectors of both older versions,
  which may disagree. So a rebuilt or
  updated page is not unsearchable in between, for as long as the index
  takes up to that hour; that is as far as it can be guaranteed, since the
  index promises no bound. Past it, a hit on a leftover vector is stale and
  is handled as below. A deleted document's chunks are not kept: deleting
  content takes it out of answers at once. Expired rows are cleared by the
  org's later commits and skipped by every read.
- **Stale hits.** A hit with no chunk (`not_found`) does not use up the
  candidate pool: see "Answering a message", step 2.
- **Telling the owner.** `GET …/assistants/:id/content-status` answers
  `{ settling, indexing, settlesAt }`: `settling` while documents are
  waiting to be indexed or for `INDEX_SETTLE_MS` (ten minutes, ours: the
  documentation's "within minutes" with room) after `content_changed_at`.
  Sources and Try it then say "Recent changes to your content can take a few
  minutes to appear in answers." and check again every 30 seconds until it
  ends. Visitors see nothing of it.
- **Leftovers.** A test (`test/chat/indexLag.test.ts`) drives a fake index
  that applies writes only when told, through an update, a Rebuild, a
  document and a source deletion, and checks that once it has caught up no
  vector is left without a chunk. An admin count of leftovers is not offered:
  the Workers binding cannot list an index's vectors, only fetch known ids,
  so counting them would mean reading every chunk id. A leftover shows in
  traces as a `not_found` candidate long after the change.

### Scheduled sitemap sync

A sitemap source can stay in step with its sitemap. Its `sync` setting is
`off` (the default, so sources created before this existed do not change),
`daily` or `weekly`. A run:

1. Takes the source's lease (`source_syncs.lease_until`, 6 hours) in one
   statement, so two runs of one source never overlap: a cron firing twice,
   or a host's cron beside the open one, starts one run. A run still
   unfinished when its lease ends is reported as `failed` with
   `interrupted`, and its late queue messages change nothing. That holds for
   a page already being fetched when the lease ends: the run is checked again
   after the fetch, and each write a page makes (the document, its
   validators, the page's state, the run's end) carries the same check in its
   own statement.
2. Asks `Limits.checkSync`. A refusal records the run as failed
   (`limit_refused`) and fetches nothing. The org itself was first passed to
   `AuthProvider.resolveOrg` (`queued_ingest`); an org it refuses is not read.
3. Reads the sitemap (the preview's guards and its 2 MiB cap; up to 50,000
   `<url>` entries with their `<lastmod>`). A sitemap index is not followed:
   the run fails with `sitemap_index` ("This is a sitemap index; use one of
   the sitemaps it lists."), and the admin's preview answers 400 with
   `code: "sitemap_index"` rather than listing the child sitemaps as pages.
   Entries are read from the same reading of the XML that step 4 checks, so a
   commented-out `<url>` or `<loc>` is not a listed page.
4. Guards against a broken sitemap: if it cannot be read (`sitemap_unavailable`),
   is not one complete, well-formed XML document with a `<urlset>` root
   (`sitemap_invalid`: cut short, broken XML, bare `<loc>` lists; the admin's
   preview still reads those), or lists no page (`sitemap_empty`), the run
   removes nothing, fetches nothing, and is recorded as failed. A sitemap with
   more than 50,000 entries removes nothing in that run.
   If the run would remove more than `maxRemovePercent` of the source's
   documents, it changes nothing: no page is added, updated or removed, and
   nothing is fetched. It records how many it would have removed
   (`withheld`) and ends as `failed` with `too_many_removals`. Adding the
   listed pages while keeping the old documents would grow the source until
   the same removals passed the share check on a later run with nobody
   looking, so a wrong sitemap of the same size (a staging host, another
   section of the site) would replace every real document in two runs.
   A scheduled run never lifts the guard; it is refused on every run until
   the owner acts. That includes a whole-site URL change (a trailing slash,
   a new host) and a very small source (one page of one, two of three).
   The owner either raises `maxRemovePercent` or uses the admin's "Sync
   anyway", which sends `POST /api/admin/sources/:id/sync` with
   `{"allowRemovals": n}`, the number it showed the owner: that run alone
   lifts the guard as long as it would remove at most `n` documents, and
   adds, updates and removes in one go; it is refused as usual (with the
   new number) otherwise. `allowRemovals` is accepted only while the
   source's latest run ended `too_many_removals`; otherwise the request is
   answered `409` with `code: "sync_anyway_not_offered"`. The other guards
   stay.
5. Removes the source's documents whose URL is no longer listed (that source
   only; vectors and R2 bodies are cleaned up as for a prune).
6. Skips pages whose sitemap `<lastmod>` equals the one stored at the last
   check, without fetching them, once their current content is indexed (by
   the current versions; see "Re-indexing") and
   while that check (`documents.sync_checked_at`) is less than `recheckDays`
   old (7 days by default); a document whose indexing failed, or whose last
   check is older, is checked again with a conditional request. Without the
   age a page that answered 200 with the wrong content once (a maintenance
   page while the `<lastmod>` moved) would be pinned by a date that never
   changes again. The rest are queued in the order a run last
   queued them (`source_sync_attempts`; never queued first, new pages before
   documents among those), whether or not they could be fetched then, so pages
   that keep failing do not keep the others waiting. Up to the per-run page
   cap (200) and the
   source's document cap (500 documents); pages over a cap are counted as
   `deferred` and come up in a later run. Both caps can be lowered per run by
   `Limits.checkSync` and for every source by `createApp`'s `sync` option.
7. Each page is one message on the ingest queue (`kind: "sync_page"`). The
   consumer fetches it through the `PageFetcher` seam with the stored ETag and
   Last-Modified as `If-None-Match` / `If-Modified-Since`; a 304 is unchanged
   (and queues the chunk-and-embed message again if its content is not yet
   indexed), and a fetched page is written through the same path as a push, so an
   unchanged `content_hash` is a no-op and never re-embedded. A changed page
   queues the usual chunk-and-embed message. One page per message keeps a
   consumer batch of four within Workers Free's 50 external subrequests (each
   page is up to four hops of two DNS-over-HTTPS lookups and a fetch). A page
   that cannot be fetched or is not a page counts as failed (the run then ends
   `partial`, with `pages_failed`); a fault in D1 or R2 is retried, and on the
   third attempt counted as failed.
8. A page leaves `pending` once, so a retried message is not counted twice;
   the run finishes, adding up its counts from the pages, when none is
   pending. Writes are keyed on the document's external id, so nothing is
   duplicated.

A source is due when its schedule is on, no run holds it, and a full interval
less 15 minutes has passed since its last run started (so a cron at the same
minute each day does not miss a day). `app.runDueSyncs(env)` starts up to
three due sources per call, oldest first by the later of their last run
start and their org's last refusal by the auth seam: an org refused at one
tick goes behind every other due source, so however many sources it has, the
next tick reads past them. The Workers `scheduled` handler
calls it (with the answer-review catch-up, "Answer review"; one failing does
not stop the other), and the open build's `wrangler.jsonc` runs it hourly. A host with
its own cron (every 10 minutes, say) calls `runDueSyncs` instead. Finding due
sources (and the catch-up's replies, `reviewCatchUpCandidates`, read org by
org through the `orgs` table) is a query without an org filter: a cron has
no request and so no org, so it reads only org and source ids, and everything after goes
through the org's `Tenant` once the auth seam has vouched for it. A refusal
is recorded in `sync_org_refusals` from the seam's own answer, keyed by the
org; nothing of the org is read.

D1 is the only source of truth for live chunks; readers resolve retrieved vector
ids through D1, so leftover vectors and R2 objects can accumulate after failures.
They cost storage only and never affect an answer. Rebuild (see
"Re-indexing") rebuilds an assistant's chunks from their stored text.

## Admin API

`/api/admin/*`, JSON, always behind the auth seam. Every request that changes
something must carry an `Origin` header equal to the Worker's own origin; the
session cookie alone is not enough. Login attempts are limited per IP (five
failures, then a fifteen-minute wait) and failures are answered with one
identical message. Resources mirror the admin
navigation: assistants, versions (draft, publish, history, rollback), sources and
documents, MCP servers and tools, tests and runs, conversations, gaps, overview
numbers, install snippet.

The Monitor screens read:

- Overview: the four Reports figures for the last 7 UTC days and the 7 before,
  the median time until the answer starts appearing for the same two periods
  (see "Reports"), questions per day, the getting-started checklist (content added, a question
  tried in "Try it" or a test run, published, widget configuration requested
  on an allowed origin or a visitor question received, first visitor question) and what needs
  attention (open gaps, failed tests in the latest run, the configuration
  error, sources with documents that failed to index, reported as soon as the
  failure is recorded, and sources with documents still not indexed 15 minutes
  after they were written, reported separately, and sitemap sources whose
  latest sync failed or was interrupted, `syncFailed`, with the error code;
  a `partial` run is shown on Sources only).
- Conversations: `filter=unanswered,not_helpful,used_tool,could_not_answer,asked_for_person,off_topic`
  (the last three read the answer review's outcome: `declined`,
  `wants_human` and `off_topic`, retrieval misses included), `days=1|7|30|90`,
  `q=` (case-insensitive text in any message) and `question=` (a grouped
  question: conversations where a visitor asked it, matched by its key; what
  question links in Overview and Reports open) and `topic=` (a topic id:
  conversations where a visitor asked a question with that topic; what the
  Reports Topics list opens), with `askedFrom=` and `askedTo=` (inclusive UTC
  days, `YYYY-MM-DD`; only with `question=` or `topic=`) keeping the asks made
  in those days, the period a Reports count is for. `days=` is
  when a conversation started, a separate filter; unknown values are refused.
  The admin keeps all of them in the screen's address.
  `searchPending: true` means older messages are still being prepared for
  search: nothing was searched, `searchRemaining` says how many of the
  assistant's messages are left, and the admin asks again until it is false.
- Conversation: `GET …/conversations/:id/messages/:messageId/trace` is how one
  assistant reply was made (see "Answer traces"); `trace: null` for a reply
  with none, and 404 for a visitor message or a message outside that
  conversation or org; `reviewFailure` is the answer review's reason code
  when it gave no result (null otherwise, and always for a preview).
  `GET …/assistants/:id/preview-traces/:traceId` is the
  same view for a "Try it" answer (the id its `done` event carried) or a test
  run's answer (`traceId` on its result), with `source` `try_it` or
  `test_run` (`visitor` on the first); 404 for any other id, assistant or org.
- Content status: `GET …/assistants/:id/content-status` answers
  `{ settling, indexing, settlesAt }` (see "Index lag"); 404 for an
  assistant of another org.
- Sources: the list (`GET …/assistants/:id/sources`) gives each sitemap
  source a `sync` object: `schedule`, `last` (the current or latest run:
  start and end times, outcome, counts, error code, and while running
  `progress` as pages handled of pages queued) and `nextSyncAt` (the earliest
  time the scheduler takes it up again: a full interval less the 15-minute
  slack after the last run started; already passed means at the next check;
  null while off or running). `GET /api/admin/sources/:id/sync` returns the
  same object for one source. `POST /api/admin/sources/:id/sync` ("Sync now")
  starts a run at once, whatever the schedule, through the same steps as a
  scheduled one (lease, `Limits.checkSync`, guards, caps; the org is the
  signed-in principal's), reads the sitemap in the request and answers `202`
  with the object; a run already holding the source answers `409`; a source
  that is not a sitemap answers `400`. Its body is optional: none (or `{}`)
  for Sync now, `{ "allowRemovals": n }` for "Sync anyway" after a
  `too_many_removals` run (the run's `counts.withheld` is the `n` the admin
  shows); sent when the latest run did not end `too_many_removals`, it is
  answered `409` with `code: "sync_anyway_not_offered"`. The schedule is changed with `PATCH /api/admin/sources/:id` and
  `{ "settings": { "sync": … } }`; `maxRemovePercent` and `recheckDays` the
  same way. `GET …/assistants/:id/reindex` answers `{ outdated }`, how many
  documents were indexed by an older ingest version, and
  `POST …/assistants/:id/reindex` queues them ("Rebuild"; `202` with
  `{ queued, remaining }`; see "Re-indexing"). Each source in the list has
  `repeatedBlockCount`, and `GET /api/admin/sources/:id/repeated-blocks`
  answers `{ blocks: [{ text, truncated, pages }] }`: the source's repeated
  blocks, `text` their first 80 characters (null when none of the pages
  read for the list holds it), most pages first; empty for a written-answer
  source (see "Repeated blocks").
- Gaps: a group's questions are those whose reply was reviewed as `declined`
  (a retrieval miss or not), or, with no outcome (older rows, a review not yet
  run), found nothing above the score floor (`answered = 0`). A reply reviewed
  as `off_topic` or `wants_human` is not a content gap and is never listed.
  Each group carries `noContentTimes` and `declinedTimes` (they add up to `times`), shown
  as "No content found" and "Had content, could not answer" (the second
  usually means the content is unclear). `status=open` leaves out groups with a written answer newer than the
  group's latest ask (asked again after it, a group is open again, as after a
  dismissal). Overview's open gaps and Reports' "Most often unanswered" leave
  out the same groups, and the asks from before a dismissal (not counted, but
  an answer written from one still answers its group). Left out,
  `status` lists every group; any other value is refused;
  `POST …/gaps/dismiss` and `POST …/gaps/restore` take `{ question }`.
- Topics: `GET …/assistants/:id/topics` lists the assistant's topics with
  `reviewAnswers` (the switch); `PATCH …/topics/:topicId` takes `{ name }`
  (checked like a proposed name; 409 when another topic has it);
  `POST …/topics/:topicId/merge` takes `{ into }` (a topic id); `DELETE
  …/topics/:topicId`. A topic of another assistant or org is 404.

## Answering a message

1. Load the published version (or the draft, for the admin "Try it" pane).
2. Retrieve: embed the question, query the retriever for the assistant for 20
   candidates (`CANDIDATE_POOL`; Vectorize returns up to 100 without values or
   metadata). When some hits have no chunk (the index has not caught up; see
   "Index lag") and the index may hold more above the floor (the query came
   back full and its last hit cleared it), it is queried once more, with the
   same org and assistant filters, for 100 (`REFILL_TOP_K`), and the pool is
   the best 20 live candidates of both, resolved together so a current chunk
   of a page leaves out its replaced chunks whichever query returned them.
   Never more than two queries; the cost is one more vector query and one
   more D1 read (of both queries' hits), only on answers that met
   stale hits, and it is counted in the trace's retrieval time. Then give
   the model at most 6 (`TOP_K`) above a score floor
   (0.2), chosen by `selectCandidates` (below). The floor only keeps out
   unrelated content: the model already declines when given content that does
   not hold the answer. Measured with `text-embedding-3-small` against short
   owner-written answers, answerable questions scored 0.25 to 0.43 and unrelated
   ones about 0, so 0.2 sits in the gap (v1's 0.3 refused answerable questions;
   OpenAI documents no absolute threshold). A chunk up to 0.05 under the floor
   is kept too, but only when a chunk of the same document cleared it; when
   nothing clears the floor nothing is kept, so off-topic questions still find
   nothing. An instance may set `SOLV_SCORE_FLOOR` (0 to 0.9); the trace records
   the floor used. Of the chunks that pass the floor, in order:
   - Duplicates: of chunks with the same text under the same title and
     heading path (only runs of whitespace told apart) only the best-scored
     is kept, except that a written answer is kept over a page chunk it
     duplicates. Text that differs in any word is kept, and so is the same
     text about another subject (the same "30 days." answering a refund
     question and a warranty question).
   - The written answer: the best-scoring written answer at or above the
     floor itself is always given, in place of the lowest-scored chunk when
     the set is full.
   - The rest by score, at most 2 from one document
     (`MAX_CHUNKS_PER_DOCUMENT`); when that leaves fewer than 6, the capped
     chunks fill the set, best first.
3. Build the prompt: fixed safety frame, the owner's behaviour fields, retrieved
   chunks with their URLs (capped at 2000 characters each), the last 6 turns.
   The frame depends on "Show sources in answers" (below). Each source is
   numbered (`<<<source n`); one with a page has its `url:` line (a written
   answer has none).
4. Call the model through the provider interface, streaming. If tools are allowed,
   run the MCP loop: the model asks for a tool, the Worker calls the MCP server,
   the result goes back as untrusted data. Each call's output limit is the
   visible answer's allowance (`ANSWER_VISIBLE_TOKENS`, 1024) plus room for
   reasoning (`ANSWER_REASONING_TOKENS`, 4096), never above the model's own
   maximum (`maxOutputTokens` in `models.ts`): visitor answers run with the
   model's default reasoning, and on all three providers reasoning counts
   against the one limit sent, so 1024 alone left the answer less than that
   and cut it mid-sentence. The fixed frame asks for a focused answer that
   finishes in the space it has (lead with the answer, prefer one code
   example, name the page for the rest). Every billed output token,
   reasoning included, is still metered: providers report it in their output
   total.
5. **Cut short.** When the last call stopped at the output limit (`length`),
   an unclosed code fence is closed and one fixed line is added
   (`CUT_SHORT_LINE`, "That answer was cut short. Ask me to continue."),
   streamed as a last token before the citations and stored with the reply,
   the same after a page-action resume. The answer counts as answered as any
   other. A link left unfinished at the cut is reduced to its text first (see
   "Sources in answers"), so no open link is stored or sent.
6. Persist messages, citations, token counts, cost and the two timings; update
   `usage_daily`. After the `done` event, in the same deferred pipeline, write
   the answer's trace.
7. If nothing was retrieved above the floor and no tool answered, say so, use the
   owner's fallback text, and mark the message `answered = false` so it shows
   under Gaps.
8. Once the reply is complete, stored and sent, hand it to the answer review
   (below), which runs as separate deferred work.

## Sources in answers

"Show sources in answers" (`behaviour.sources`) is a behaviour setting like
the others, one of three choices: edited on Behaviour, part of the draft and
the publish diff (the Publish dialog and History name it by the choice's
words), followed by visitors once published and by "Try it" and test runs
from the draft. "List sources under answers" (`behaviour.listSources`, off
by default) is a second one, offered with "Link in the text" only.

- **Link in the text** (`links`, the default). Where an answer relies on a
  page, the words that name it ("the testing guide", "the pricing page", a
  feature's name) are a Markdown link to that page, at most one per source
  per paragraph, never a whole sentence nor "here". The frame
  (`SAFETY_FRAME_LINKS`) has the model refer to a source by its number in
  one form, an inline link, `[the testing guide](2)`, and says it writes no
  reference definition (`[1]: https://…`), no `[words][n]` and no address,
  as a link or as text; the engine (`chat/sourceLinks.ts`) turns each into
  a link to that source's page. Numbers rather than addresses: a number
  cannot be mistyped into another page, and it costs a few output
  characters where an address costs dozens. Inline rather than the
  reference form (`[the testing guide][2]`) this frame used first: that is
  Markdown's reference link, and a deployed check saw the model finish it
  the Markdown way, with definitions numbered its own way after the text,
  so source numbers sent the words to pages they did not name. The engine
  does not rely on the prompt for that. A reference link (`[words][label]`,
  or `[words][]`) goes where the answer's own definition of its label says
  (labels matched as Markdown matches them), never by the sources' numbers
  when the answer defines its labels; with no definition anywhere in the
  answer, a numbered reference can only mean the sources' numbers. Either
  way the address must pass the rule below, or the link is reduced to its
  text. Since a definition usually comes after the text, a reference link
  is held from its "[" until its definition arrives or the stream ends,
  and the rest of the stream with it. Every definition (on a line of its
  own, or run into the text as `page.[1]: https://…[2]: https://…`, or a
  bare `[1]:`) is taken out of what is sent and stored, held while one may
  still be arriving. An address written out in the text is a link
  (`[https://…](https://…)`, as is an autolink, which the widget shows as
  no link) when it is one of the answer's pages, and is otherwise left as
  text; a link whose words are its own address is always kept, however
  often the paragraph links that page. The recorded evaluation
  (`test/fixtures/source-links-eval.json`, 14 questions against two
  documentation corpora, this repository's docs and sqlite.org, replayed by
  a test and re-recorded with `scripts/source-links-eval.mjs --record`)
  answered each question with this frame, with the reference form, and with
  addresses copied: each way linked 13 correctly and 1 (a written answer's)
  linked nothing, none had a link removed, and in 13 of 14 answers a link
  went to the page the question is about (or, for the written answer, no
  link); numbers spent 60 characters on 15 link targets, references 72 on
  18, addresses 559 on 16. Over every recorded answer (three or four to each
  question), the
  reference form wrote `[words][n]` in 51 of 55 answers, the inline form in
  none of 42; neither wrote a definition there (the deployed check saw them
  in 2 of 4 answers to one question). A written answer has no
  public page: text that relies only on it carries no link. A link survives
  only when it goes to a page the answer was given (the pages its citations
  would list, the same rule: not a written answer) or to an address the
  text of one of those sources contains, a section of either (`#…`) included; every other link
  (another site, a made-up page, a relative or `mailto:` address, a
  reference to no source or whose definition goes elsewhere, an image, an
  autolink) and a
  second link to the same page in a paragraph is reduced to its text, in the
  stream and the stored text alike. A link whose words hold another link or
  a pair of brackets (`[see [the guide]](…)`, `[outer [inner](…)](…)`) is
  reduced to its words whatever its target, and the links in those words
  are checked like any other. The rewritten text is read again until that
  changes nothing, so dropping a link's syntax never leaves an unchecked
  link made of the text around it (`[x]![](…)(…)` reads `[x](…)` once the
  image is gone). What was stored before a pause stays as it was, and a
  link it began (`[words]`, `<https://…`) is not finished after the pause:
  the rest of that link is dropped. Code (an inline span, a fenced or
  indented block) and escaped brackets are left alone, found as below.
  Markers (`[1]`) that still appear are then taken out as for "None". A link
  is never sent half-written: from a "[" (or "![", or an autolink's "<")
  that could still become one, the stream is held until it is complete or
  cannot be one, so nothing sent is taken back; at the end of the stream, a
  pause or a cut at the output limit, a link left unfinished is reduced to
  its text. No `citation` event is sent, so the widget shows no sources
  block, unless "List sources under answers" is on: then the events follow
  the text as for "Numbered, with a list".
- **Numbered, with a list** (`numbered`). The frame (`SAFETY_FRAME`) asks for `[n]`
  markers after the sentences they support, the stream is passed on
  untouched, and `citation` events follow the text: the public response is
  exactly what it was before the setting had three values (a test holds it
  byte for byte against `test/fixtures/numbered-answer.json`).
- **None** (`none`). The frame (`SAFETY_FRAME_NO_CITATIONS`) asks for no markers and no
  source list. Markers that still appear are taken out in the engine
  (`chat/citationMarkers.ts`), from the streamed tokens and from the stored
  text, so an API client gets the same as the widget: the end of the stream
  that could still be a marker split across chunks is held back until the
  next chunk (or the end) settles it, however long the unfinished marker is,
  so nothing sent is ever taken back. Only numbers 1 to `TOP_K` are taken,
  anywhere in prose (also straight after a word, "Password[1]") but never
  inside Markdown code, an inline span or a fenced or indented block, also
  one within a list item or a quote (so `items[1]` stays), never a Markdown
  link and never in a link's destination (an inline link's, an image's, an
  autolink's or a reference definition's, so `report[1].pdf` in a link's
  address stays), with the spaces before them. Lines end at LF, CRLF or a
  bare CR alike, as the widget reads them, and keep the endings the model
  wrote. No `citation` event is sent,
  so the widget shows no sources block. Page actions do not depend on
  citations and work as before.
- **Migration.** A version stored before the setting had three values has
  `showSources` instead: on (or absent, its default) reads as "Link in the
  text", off as "None", with "List sources under answers" off, for every
  version (draft, published, archived) alike; the next save of the draft
  writes the new keys. A config file may still give `showSources`; given
  with `sources`, `sources` wins. So an assistant that had sources on now
  links in the text and lists no sources until the owner turns the list on.
- **Kept whatever the setting.** Everything the owner sees: the trace, the stored
  citations, `message_documents` (Reports' "Content used most / never used"
  count the same), and the conversation view, which shows a reply's pages
  under "Used content" instead of "Sources" when the visitor saw no list
  (`citationsShown: false` on the turn). A test run's "cites" check passes
  when the answer links to the page ("Linked to …"), in every mode (with
  "Numbered" and "None" the links as the model wrote them, which the
  visitor gets unchanged), compared on the whole address the link goes to,
  so a test of a page's section (`#fragment`) passes on a link to that
  section. An image (`![…](…)`) is no link, nor is a link written in an
  image's text: the widget shows an image as written, so neither can be
  followed; else,
  with a list shown, when the list has it ("Cited"), and with none, when
  the answer used it ("Used").
- **No talk about sources.** Every frame tells the model never to write about
  its inputs ("Source 1", "(Source 2)", "the sources say", "according to the
  provided content"); with numbered sources the `[n]` marker is the only
  reference, with links the linked words are.
  This rests on the prompt alone: no post-check rewrites such wording, because
  a site's own text can say "source" ("Source 2" may be a product), and the
  sentence around it cannot be cut out without changing what it says.

## Answer review

`answered` only says retrieval found content. A model given content can still
decline ("I could not find that"), so each completed visitor reply is reviewed
after it is sent, and the outcome is stored on the message: `answered`,
`partial` (some of it, or hedged), `declined` (does not know, cannot help, or
the fallback), `off_topic` (not about this site's subject) or `wants_human`
(asked for a person, a call back, or to complain).

- **Where it runs.** `ctx.waitUntil`, as its own promise, registered after the
  `done` event and the trace write; the answer's stream closes without waiting
  for it. Not the Queue: one short call per answer needs no durable retry, the
  open engine's only queue is the ingest queue (whose consumer is built for
  documents), and the visitor is never waiting either way. Each attempt has a
  10-second timeout (`REVIEW_TIMEOUT_MS`); a failure, a timeout or an
  unusable label is retried once. For a reply with content, a failed or
  skipped review leaves the outcome NULL (a retrieval miss differs, below)
  and records why in the answer's trace; deferred work that is cut off
  records nothing, and the scheduled catch-up (below) takes it up.
- **Why a review gave nothing.** Once its attempts are used up, the reason is
  stored on the answer's trace (`message_traces.detail`, `review.failed`) as
  a fixed code (`REVIEW_FAILURES` in `@solvchat/core`): `review_timeout`,
  `review_provider_error` (the provider refused or failed the call, or no
  reviewer could be built, a missing key say), `review_empty` (no reply
  text at all: the model reasoned and used up its output allowance, say),
  `review_unparseable` (text, but no label in it),
  `review_skipped_spend_cap`, or `review_error` (the
  spend limit could not be read, or the outcome not saved). Never the
  provider's response text or anything the visitor wrote, in the trace or
  in a log line: logs carry the code and error names only. The reason is
  recorded for a retrieval miss too, though its `declined` is still stored.
  A message whose own trace write failed gets a trace holding only the note
  (`parts` empty); `boundTrace` leaves room for the note
  (`TRACE_REVIEW_RESERVE_BYTES`). A trace stored before it did may fill the
  whole 32 KiB; when the note does not fit, that trace is cut down by
  `boundTrace` with the note in it (the first answer and the latest request
  stay, marked `truncated`) and written back only if no other write changed
  it since it was read, a claim only while there is still no note. The
  admin's answer trace returns it as `reviewFailure` and says it in plain
  words under "Answer check" ("Not checked. It failed after a retry: the
  last try took too long." and so on: only the last attempt's reason is
  kept, so the words name that one).
- **Catch-up.** The Workers `scheduled` handler (the same cron as the
  sitemap sync; `app.runReviewCatchUp(env)` for a host with its own cron)
  reviews, each tick, up to `MAX_REVIEW_CATCH_UP_PER_TICK` (10) visitor
  replies first written in the last 24 hours (`REVIEW_CATCH_UP_WINDOW_MS`)
  and completed at least 5 minutes ago (`REVIEW_CATCH_UP_MIN_AGE_MS`, so it
  never races the live review) that are complete (not paused), have no
  outcome and no review note on their trace, oldest first. A reply that
  paused for page actions counts from the continuation that completed it
  (`messages.resumed_at`, written in the same update as its text), since that
  is when its live review starts; any other from when it was written. Each org is checked with the auth seam
  first (`queued_ingest`, as a scheduled sync's is). Replies are read in
  pages of 50, up to `REVIEW_CATCH_UP_MAX_PAGES` (5) a tick; each later page
  leaves out the orgs the seam refused so far and starts past the last row
  read, so a refused org's backlog never keeps other orgs' replies from
  being reached. Before anything is spent
  the reply is claimed on its trace (`review.catchUp`, a conditional write),
  so each is attempted at most once by the catch-up, even with two ticks at
  once or a tick cut off. A read that fails after the claim records
  `review_error` on the trace, so a claimed reply that was not reviewed
  still says why. The claim also keeps its time (`review.claimedAt`), so a
  run cut off before it can record anything (during the provider call, say)
  needs no help from that run: the admin reports a claim still open after
  `REVIEW_CLAIM_EXPIRY_MS` (5 minutes, well past a claimed review's two
  10-second calls) on a reply with no outcome as `review_error`. A recorded
  failure replaces the claim; a run that ends without one closes it
  (`releaseReviewCatchUp`, only while the note is still that claim), so a
  reply left unreviewed on purpose ("Review answers" off) is not called cut
  off. It is then reviewed exactly as the live path does
  it: the same spend cap (`Limits`, `{ kind: "review" }`), key, provider and
  "Review answers" switch (off: no call; only a retrieval miss is stored, as
  `declined`), retry and reason codes, topic rules and metering. "Try it"
  and test-run answers store no message, so they are never taken.
- **What is reviewed.** Completed replies to visitors (`POST /v1/chat`),
  including a paused reply once its continuation completes (never while
  paused). "Try it" previews and test runs are not reviewed.
- **Retrieval misses.** A reply that is the fixed fallback text because nothing
  cleared the floor is reviewed too, with the same frame (the question and the
  fallback reply), and the request says the assistant found nothing on the
  site, so the label is judged from the question and the site's subject, not
  from the reply: the question alone tells an off-topic question or a request
  for a person from a real content gap. The frame states the rule: `off_topic`
  when a visitor could not reasonably expect this site's assistant to answer
  it (general knowledge, trivia, art, sport, news, another organisation's
  business), however sensible the question; `declined` when it is about
  something the site could cover (its business, what it offers, prices,
  orders, opening hours, policies, people or content), and when unsure. Only `declined`, `off_topic` or
  `wants_human` is accepted (`MISS_OUTCOMES`); any other label (a fallback
  reply cannot have answered, even partly), no label, a failure, a timeout,
  the spend cap being reached, or "Review answers" off stores `declined`
  (with no model call in the last two), so a miss is never left empty and
  never counts as answered. Cost, cap, timeout and retry are as for any
  review. `answered` stays 0 whatever the outcome.
- **The site's subject.** `off_topic` needs to know what the site is about,
  so the request also carries, as tagged data like the rest, the assistant's
  name, its widget title, the greeting and the persona of its published
  version (owner-written; the persona already goes to the answering model;
  the start of each, `REVIEW_MAX_SUBJECT_ABOUT_CHARS`, 400 characters, left
  out when blank) and up to 20 titles of its content (pages, pushed
  documents, written answers; `REVIEW_MAX_SUBJECT_TITLES`, each cut to 120
  characters), read in the deferred review. There is no separate "site
  description" field; the greeting and persona are the owner's own words
  about the assistant. Nothing about the visitor is added: the question and
  the reply are the only visitor data the review gets. With no content title (a new
  assistant, say) the subject is unknown: the request says so and that
  off_topic must not be used, and a retrieval miss reviewed as `off_topic`
  anyway is stored as `declined`, so a real content gap is never dropped from
  Gaps on the question and the fixed fallback alone.
- **The reviewer.** One small interface, `AnswerReviewer` in
  `chat/review.ts`: question, reply, the site's subject and the assistant's topic names in,
  `{ outcome, confidence, topic }` out (`topic` is described under "Topics")
  (`confidence` 0-1, or null when the backend cannot give one; stored as
  `outcome_confidence`). Callers (the answer path, Gaps, the reports) depend on
  the interface only. Its one implementation is a call to the fast tier of the
  organisation's configured answering provider (`ANTHROPIC_MODELS.fast`,
  `OPENAI_MODELS.fast`; on OpenRouter, which has no tiers, the configured
  model), with the same key, through the normal provider layer. It cannot
  give a confidence. There is no per-assistant reviewer prompt and no model
  picker. The call asks for no reasoning (`reasoning: "off"`, under
  "Providers"): reasoning counts against its 64 output tokens, and with
  thinking left at its default Claude Haiku 5.5 often spent them all on
  thinking and wrote no label.
- **Untrusted input.** The reviewer's system prompt is a fixed frame
  (`REVIEW_FRAME`). The question and the reply travel in the user turn as data,
  each between start and end lines carrying a random tag per call, so text
  inside them cannot close its block; so do the site's subject (owner and
  site text) and the assistant's topic list, whose names came from a model
  that read visitor text.
- **Evaluation.** The unit tests drive the review with scripted reviewers, so
  they check the rules around it, not how well a model classifies.
  `test/fixtures/review-eval.json` is a small set of realistic questions and
  replies, refusals, misses with and without a known subject, and injected
  instructions; a test checks every case against the rules, and
  `scripts/review-eval.mjs` runs the set against the real fast-tier model
  (opt-in, needs a provider key, never in CI; exits 1 when an injected case
  is mishandled). The output is parsed
  as two fields, each on its own: the reply, less surrounding whitespace and
  blank lines, must be at most two lines, each read on its own as
  `outcome: <label>` or `topic: <name>` (field names in any case, either
  order). A label that is not exactly one of the five is no outcome (the
  topic still stands); a missing, malformed or refused topic is no topic, or
  "Other" (the outcome still stands). A line that is neither field gives
  nothing and costs the other field nothing; a field given twice is not
  taken. Longer output (a third line, a code fence, prose around the
  fields) is neither.
- **Cost.** The call's tokens and cost are recorded through `UsageSink` like
  any model use (`messages: 0`), so they count toward `usage_daily` and the
  daily spend cap. Before each attempt the review asks `Limits` with
  `{ kind: "review" }` and is skipped when the cap is reached (the open
  `basicLimits` applies only the spend cap to it, no rate limit); a check
  that fails is not retried. At most 64
  output tokens (the label and a topic of at most 40 characters in any
  script); the reply is cut to its first 6000 characters.
- **Metering.** The usage counter a host bills on (`messages`) does not change.
  Each reviewer call that the provider reports usage for (every call that
  reached it: each provider reports once per call) is one usage event, so a
  retry and a catch-up call are metered like the first; the answered-message
  event (`messages: 1`) is never sent again. When an outcome is stored, the
  seam also receives an event that counts
  nothing (`messages`, tokens and cost all 0) and carries
  `review: { messageId, outcome, confidence }`, so a host can apply its own
  rule later. The open `usageDaily` writes nothing for such an event. It is
  sent once per message: a second write of an outcome (the catch-up after a
  live review that did store one) changes nothing and sends nothing.
- **Answered share** (Overview and Reports): over the range's replies less
  those reviewed as `off_topic` (an assistant that rightly refuses a question
  about something else has not failed), a reviewed reply counts 1 for
  `answered`, one half for `partial` and 0 for `declined` and `wants_human`;
  a reply with no outcome counts as before (1 when retrieval found content).
  Both screens' hint says a partial answer counts as half and off-topic
  questions are not counted. The
  thumbs-down share and the reply count still count every reply. Old data
  reads exactly as it did.
- **Gaps** and Reports' "Most often unanswered" list questions with a reply
  reviewed as `declined`, or unreviewed with no content found; never
  `off_topic` or `wants_human` (see "Admin API").
- **Conversations** shows the outcome as a badge on each reviewed assistant
  reply ("Answered", "Partly answered", "Could not answer", "Off topic",
  "Asked for a person"); a retrieval miss reviewed as `declined` keeps its
  "Unanswered" badge. The list badges a conversation the same way
  (`hasUnanswered`, `hasOffTopic`, `hasAskedForPerson`): "Unanswered" for a
  miss that is unreviewed or `declined`, and "Off topic" or "Asked for a
  person" for a reply with that outcome, as the filters of those names find
  it, never "Unanswered" for it. A reply that Gaps would list offers "Write an answer
  for this"; one reviewed as `off_topic` or `wants_human` does not. The
  "Could not answer", "Asked for a person" and "Off topic" filters read the
  outcome, so "Asked for a person" finds a visitor who asked for one even
  when retrieval missed.
- **Switch.** Settings → Providers → "Review answers", per organisation, on by
  default (`reviewAnswers` on `PUT /api/admin/providers`; `null` restores the
  default). Off means no model call and no outcome for a reply with content;
  a retrieval miss is still stored as `declined` (with its outcome event), so
  Gaps, the answered share and the filters read as they did before review
  existed.

## Topics

Top questions are grouped by their exact lowercased text, so "when are you
open" and "opening hours?" are separate rows. Topics group them by what they
are about.

- **Who names them.** The answer review, in the same call (one call, not
  two): it is given the assistant's current topic names and must pick one or
  propose a new short label (2-4 words, at most 40 characters, in the language
  of the question). The topic is stored on the visitor's question (the `user`
  message), not the reply: it describes what was asked, the Topics list
  counts questions, and the Conversations filter finds where it was asked. A
  retrieval miss's question gets one too (its topic stands even when its label
  is replaced by `declined`). An `off_topic` question gets no topic and never
  creates one: it is not about the site, so it would only fill the Topics
  list and the topic filter; the "Off topic" filter is how the owner finds
  these. Migration 0031 cleared the topic of questions tagged before this
  (it keeps every topic: the schema cannot tell an owner-renamed topic from
  one the review named, so one left with no questions stays until the owner
  deletes it). When an answer is stored as `off_topic`, its question's topic
  is cleared first (unless the answer already has another outcome): an
  earlier run may have stored the topic and been cut off before the outcome,
  and the catch-up then finds the question tagged. A question is tagged
  once; nothing re-tags it.
  There is no manual tagging of a message.
- **The cap.** At most 40 topics per assistant (`MAX_TOPICS_PER_ASSISTANT`),
  not counting "Other", which is always available. When the list is full the
  request says new topics are not allowed, and the reviewer must pick the
  closest topic or "Other"; a new name proposed anyway is stored as "Other".
  The cap is checked inside the insert statement, so two reviews at 39 topics
  cannot make 41. Renaming "Other" to another name would make it an ordinary
  topic, so it is refused (409) while there are already 40; that check is in
  the rename statement too.
- **Concurrency.** `name_key` is unique per assistant; a new topic is
  inserted with `ON CONFLICT DO NOTHING` and read back by key, so two reviews
  proposing the same new topic at once end with one topic.
- **Untrusted names.** A proposed name is data from a model that read
  untrusted text (`checkTopicName` in `@solvchat/core`): tags, markup
  characters, control and format characters are removed; the rest is
  NFKC-normalised and trimmed, must be 1-40 characters and at most 4 words of
  letters, marks, digits, spaces and `- ' & / ,`, and must start with a letter
  or digit (never a spreadsheet formula). Anything that looks like a web or
  email address, a street address or postcode, or holds a number longer than
  6 digits (separators ignored) is refused, so a topic never captures personal
  data. A refused name becomes "Other". An owner's rename passes the same
  checks and is refused with the reason. Names are rendered as text
  everywhere, and the CSV guards them like every other field.
- **Switch.** With "Review answers" off no topic is assigned (no call is
  made), and the Topics list says why it is empty.
- **Isolation.** Topics are per assistant and per org: every statement is
  bound to the org and names the assistant, and a question can only be tagged
  with a topic of its own conversation's assistant.
- **Managing.** Reports → "Manage topics" (a small dialog, offered also when
  the period has nothing to report): rename a topic,
  merge one into another (all its questions move to it, in one transaction),
  or delete one (its questions become untagged).

## Answer traces

Every assistant reply to a visitor (`POST /v1/chat`) records how it was made,
so an owner can tell missing content from a retrieval miss from a model that
ignored what it was given. A small recorder (`answerRecorder` in
`chat/trace.ts`) is threaded through the answer path and is the only clock
the trace reads.

- Retrieval: the candidate pool (at most 20; `TOP_K` of them at most reach
  the model) and the hits that had no chunk, at most 40 in all
  (`MAX_TRACE_CANDIDATES`; over it, the lowest unused rows go first), best
  first, with `stale` (how many hits had no chunk, across both queries) and
  `searchedAgain` (whether the second query ran); each candidate with
  chunk id, document id, similarity score (four decimal places), and whether
  it was passed to the model or dropped: `below_floor` (under the score floor
  this answer used, which is recorded too; a chunk kept in the same-document
  margin is marked passed), `not_found` (the vector matched but its chunk is
  no longer in D1), `duplicate` (the same text, title and heading path as a better chunk),
  `document_cap` (its document had given its share and others filled the
  set) or `rank` (`TOP_K` better chunks filled the set). The admin shows each
  candidate's heading path beside its title, read from the chunk when the
  view is read, like its text.
- The version that answered (its id, and `published` for a visitor, `draft`
  for "Try it" and a test run).
- The provider and model id actually called, or none when nothing relevant
  was found and no model was asked, and where the model key came from:
  `stored` (Settings → Providers), `environment` (Worker secret) or `managed`
  (`KeyProvider.managed`). Never any key material.
- Timing in milliseconds: retrieval (embedding, vector query and D1 lookup),
  first token sent to the visitor, total; tool rounds run and their total time.
- Stop reason, the same for every provider: `complete`, `length` (the model
  hit its output limit and the answer was cut short), `tool` (it still asked
  for a tool when none was allowed), `refused` (the model or the provider's
  filter declined: Anthropic `refusal`, OpenAI and OpenRouter
  `content_filter`), `spend_cap`, `error`, or `paused` (waiting for page
  actions). Each adapter maps its own values (`anthropicStopReason`,
  `openaiIncompleteReason`, `openrouterFinishReason`). The open
  engine refuses an over-cap request before answering and stores no reply for
  a failed one, so `spend_cap` never appears on its own replies and `error`
  only on a paused reply whose continuation failed.
- A paused reply's continuations are appended as further parts (at most 8 per
  message: the first answer and the newest resumes).

The answer review adds its note to the same document when it gave no
result: a fixed reason code and whether the catch-up took the answer, with
the time of an open catch-up claim (see "Answer review"), never text.

The trace holds references, never copies: no prompt, question, chunk text,
tool or action output. It is written after the reply is complete and sent, in
the deferred step that persisted the message; a failed write is logged (the
error message only) and swallowed, and never delays or fails the answer.
One message's stored JSON is capped at 32 KiB (`MAX_TRACE_BYTES`): ids are
clipped and candidates and older resumes dropped to fit, marked `truncated`,
and the table refuses a longer row.

The key source is read after `done`, in the trace write, so no trace work is
done before the first token.

"Try it" answers and test-run answers store no message (see "Answer tests"),
so their traces go to `preview_traces` instead, the same document marked
with where it came from (`try_it`, or `test_run` with the run and test), with
the answer's tokens and cost beside it. No report, Gaps or Conversations
reads that table, so they never count as visitor answers. The Try it pane
offers "How this answer was made" under each reply, and the Tests screen
under each result that has one (`traceId`), labelled "The draft (Try it)" or
"The draft (test run)".

The admin's Conversation screen shows it under each assistant reply as "How
this answer was made", closed and loaded on first open: the content it was
given, ranked, with scores and a plain label for what was not used; the
settings version with a link to History; the model; the three timings; how
it stopped ("Cut short at the length limit" for a `length` stop); tokens and
cost. Reports do not count cut answers. Chunk ids are resolved to the document's current title and text when
the view is read, and a chunk that no longer exists says "This content has
since changed or been removed." Replies from before traces say "No details
were recorded for this answer."

## Privacy and retention

- Conversations and their messages are kept until they are deleted; the open
  engine has no automatic expiry. Deleting a conversation (or its assistant)
  deletes its messages, and with them their feedback, linked gap answers and
  answer traces, by foreign-key cascade.
- A trace adds no visitor or owner text to what is stored: ids, scores,
  timings, a model id and a key source. It is read only by the signed-in
  owner of the org (`/api/admin/*`, org from the auth seam).
- The answer review sends the visitor's question, the assistant's reply, the
  assistant's name, widget title and up to 20 content titles, and the
  assistant's topic names, and nothing else (no conversation history, content
  text, persona, page or visitor id), to
  the same provider that produced the answer, with the same key: the fast
  tier of the organisation's configured answering provider. It stores only
  the label (and a confidence when one is given) and a checked topic name
  (see "Topics"), never the rest of the reviewer's text.
- There is no export of conversations today. Whatever export or deletion path
  is added for messages must cover `message_traces` with them.
- `preview_traces` holds the same ids and numbers for the owner's own "Try
  it" and test-run answers: the newest 200 per assistant, deleted with it.
- The visitor check stores no Turnstile token, session or IP with
  conversations: `visitor_check_tokens` holds token hashes for five minutes
  and `visitor_counters` keyed hashes of visitor ids and IPs for about a day
  (see "Visitor check").

## Providers

`LlmProvider` has three implementations: Anthropic, OpenAI and OpenRouter. `Embedder` has two:
OpenAI embeddings (default) and OpenRouter embeddings (`SOLV_EMBEDDINGS_PROVIDER=openrouter`,
fixed to `openai/text-embedding-3-small` at 1536 dimensions). `Retriever` has one: Vectorize; the interface exists so
Cloudflare AI Search can be added as a second backend.

A request may ask for `reasoning: "off"` (the answer review does; visitor
answers do not, and send no reasoning field: only their output limit
leaves room for reasoning, under "Answering a message"). Each provider sends its
own switch: Anthropic `thinking: {type: "disabled"}`, or `{type:
"between_tools"}` on Claude Sonnet 5.5, and nothing on models whose thinking
is always on (Opus 5.5, Fable, Mythos); OpenAI and OpenRouter `reasoning:
{effort: "none"}`. A model that refuses the switch (HTTP 400) is asked once
more without it and with an output limit of at least
`REASONING_FALLBACK_MIN_OUTPUT_TOKENS`, since on every provider reasoning
counts against the output limit; the provider instance then skips the switch
(`providers/reasoning.ts`). A reply that reasoned and then wrote no text and
called no tool is not a successful empty answer: the provider reports its
usage and throws `EmptyReplyError` (a retryable `ProviderError`).

Model IDs, prices and limits live in one file, `packages/engine/src/models.ts`.
Every value in that file is taken from the provider's current documentation and
carries a comment with the source URL and the date checked. Never fill it from
memory.

The admin does not expose model or temperature pickers per assistant. The
instance picks a provider and a model tier in configuration via plain Worker
environment variables (`vars` in `wrangler.jsonc`):

- `SOLV_LLM_PROVIDER` — `anthropic`, `openai` or `openrouter` (default `anthropic`).
- `SOLV_LLM_TIER` — `fast` or `balanced` (default `fast`).

An unrecognised value falls back to its default and is logged once.

### Provider settings

An owner can also configure the instance's answering provider, tier or OpenRouter
model id, embeddings provider, and API keys per organisation in the admin under
**Settings → Providers** (there is still no per-assistant model picker, and no
custom base URL or endpoint field).

- **Precedence**: stored setting beats environment variable beats built-in
  default; stored key beats Worker secret. Removing a stored value falls back.
- **Keys**: stored keys are sealed with `SOLV_SECRET_KEY` (`secretBox`),
  write-only (never returned by any API or logged), and opened only at call
  time inside the Worker. Storing a key without `SOLV_SECRET_KEY` is refused.
  If a stored key cannot be opened (for example, `SOLV_SECRET_KEY` was
  rotated), answering fails with the configuration-error path, the admin says
  which key must be re-entered, and the Worker secret is not silently used
  instead.
- **Embeddings**: switching between `openai` and `openrouter` uses the same
  model (`text-embedding-3-small`, 1536 dimensions) and does not invalidate the
  index.
- **Key test**: an owner-only, rate-limited test action checks the effective
  key with one minimal provider request and reports success or the error
  category without echoing the provider's response body.
- **Managed keys**: when `KeyProvider.managed` is true (in the cloud layer),
  the admin says "Included with your plan: no key needed" and refuses key
  entry. A host that sets `KeyProvider.ownKeysAllowed` as well lets the owner
  store their own keys behind "Use my own key"; its `modelKey` must then
  prefer a stored key.
- **Wording**: the admin names where each value comes from as "Using the
  default", "Set in this screen" (stored) or "Set on the server" (environment
  variable or Worker secret).

### OpenRouter

A third `LlmProvider`, `openrouter`, lets an instance answer with any chat model
OpenRouter offers. It is for self-hosters who want a model outside the two
built-in providers; the tiers above stay the default.

- `SOLV_LLM_PROVIDER=openrouter`, `SOLV_LLM_MODEL=<OpenRouter model id>` (for
  example a `vendor/model` slug), and the secret `SOLV_OPENROUTER_KEY`.
  `SOLV_LLM_TIER` is ignored for this provider. A missing model id or key is a
  configuration error shown in the admin, not a silent fallback.
- The model id is not validated against a list in the code: OpenRouter's
  catalogue changes, so `models.ts` holds no table for it.
- Cost: prices are not hard-coded. The provider takes the cost of each request
  from what OpenRouter reports for that request, so the daily spend cap and
  `usage_daily` keep working for any model. If a response carries no cost, the
  message is stored with cost unknown and the admin says so; the spend cap then
  cannot protect that instance, and the admin states this next to the cap.
- Embeddings stay on the `Embedder` (OpenAI) unless OpenRouter's current
  documentation shows an embeddings endpoint that can serve the same model and
  dimensions; that is checked when the provider is built, not assumed.
- Tool calling (phase 2) depends on the chosen model. If the model does not
  support tools, tools and page actions are switched off for the instance and
  the admin says why.

## MCP tools

Owners add an MCP server by URL (Streamable HTTP). The Worker lists its tools and
stores them with `allowed = false`. Nothing is callable until the owner switches
a tool on (`allowed = true`) **and** publishes a version whose `allowedTools`
includes it (the "Try it" pane uses the draft's `allowedTools`).

By default a tool runs with the owner's configured auth (`none` or a static
header). The admin recommends a read-only token for a shared key. Both owner
keys and optional test keys are encrypted with `SOLV_SECRET_KEY` (AES-GCM),
decrypted inside the Worker at call time, and only shown as set or unset.

A server may opt in to a key from the host page. The version's
`pageToolServers` entries carry the server ID, HTTPS URL and header name
(default `Authorization`). Draft edits reach visitors on Publish. The URL
must match the server row exactly, including the origin and path. These are
public addresses without user info, queries or fragments. A change to the
server address invalidates older entries and clears the stored test key.
`Authorization` receives `Bearer <token>` (case-insensitive header name).
Other headers receive the raw token. MCP requests refuse redirects.

`setToolCredential(url, token)` holds the token in the widget instance's
memory. Replacement, `null`, and disconnection remove the previous value.
The widget sends credentials only for URLs in the published public config
and refuses redirects on credential-bearing chat requests. The MCP runner
binds a request's token to the matching version entry and server row. The
server’s tools are omitted for that turn if its token is absent. Direct
echoes of the token in tool output are redacted before the model receives it.

Listing tools on add or Refresh, Try it, and answer tests use the draft and
the server’s separate encrypted test key. The tenant-scoped MCP target read
resolves the test ciphertext alongside the matching endpoint. With no saved
test key, listing uses an optional one-time key only for that discovery.
Try it and answer tests omit those tools until a test key is saved.

- Tools are off by default, per tool.
- Tool results are untrusted input. They are passed to the model as data, never
  concatenated into the system prompt, and are capped in size.
- Per-conversation caps on the number of tool calls and on wall time.
- Server URLs must be https and must not resolve to private or loopback ranges.

### Conversation context headers

When every call carries the same credential, a server needs a separate way
to track each visitor’s share of a common budget.
Each server has a "Send conversation context" setting (`sendConversationContext`
in the admin API and `solv.config.json`, `send_conversation_context` in D1),
off for existing and new servers. It belongs to the server, not to a version:
it takes effect when saved and Publish does not gate it. When it is on, every
request the engine makes to that server for a chat turn (`initialize`,
`notifications/initialized`, `tools/list` when listed, and `tools/call`)
carries:

| Header                 | Value                                               |
| ---------------------- | --------------------------------------------------- |
| `Solv-Conversation-Id` | the conversation id, when a conversation row exists |
| `Solv-Visitor-Id`      | the widget's visitor id stored on that conversation |
| `Solv-Assistant-Id`    | the assistant id                                    |

- Values are existing opaque ids only. An id matching `[A-Za-z0-9_-]{1,128}`
  that does not start with `h_` (in any case) is sent as is; any other id (the
  widget's visitor id is any 1 to 128 characters) is sent as `h_` followed by
  the first 32 hex characters of its SHA-256, never raw. Because a raw id that
  starts with `h_` is hashed too, a hashed value and a raw id can never be
  equal: a visitor cannot send another visitor's hashed value as their own id.
  Nothing else (IP address, page URL, message text) is ever sent in them.
- The ids come from the stored conversation, never from the model's tool call.
- The names are fixed. An owner's static auth header may not use any of them
  (any case): creating or saving such a server is refused with a message
  naming them, whether or not the setting is on. A row stored before this rule
  keeps its credential and drops the clashing context header. Turning the
  setting on for such a row is refused until the header is renamed; disabling
  it, removing its credential and turning the setting off still work.
- Requests with no visitor conversation send `Solv-Assistant-Id` only: listing
  tools when a server is added or refreshed, the admin "Try it" pane, and answer
  tests run from the admin (Tests, Publish) or `solv test`. Previews and tests
  store no conversation row, so they never send `Solv-Conversation-Id` or
  `Solv-Visitor-Id` (the preview's made-up conversation id is not sent). A
  visitor's chat, including one that resumes after page actions, sends all three.
- The ids are opaque, but they let a third-party server correlate one visitor's
  conversations. The admin says so next to the switch ("These ids let that
  server link one visitor's conversations, so turn this on only for a server
  you run or trust."), and the setting is for servers the owner controls or
  trusts.
- The ingest key (`GET`/`PUT /v1/ingest/:assistantId/mcp-servers`, used by
  `solv apply`) is a CI credential, so it sees and does less than the admin. A
  `GET` returns each server's id, label, setting and the origin of its URL
  only, never the path or query (which may carry a token) or the credential. A
  `PUT` can turn the setting off but not on: turning it on needs a signed-in
  admin, and an entry asking for on where a server is off is refused with a
  message naming that server. An entry asking for on where it already is on is
  accepted and changes nothing. `dryRun: true` checks a `PUT` and reports what
  would change without changing it; `solv apply` runs it before writing the
  draft, the tests or any server, so a refused `mcpServers` entry changes
  nothing.

#### What a receiving server may rely on

- Trust the headers only on requests that carry the server's static
  credential. A server with no auth cannot tell the engine's requests from
  anyone else's, so anyone can forge them.
- `Solv-Conversation-Id` is issued by the engine; a visitor cannot choose it.
  A visitor can start any number of conversations, though, so a new id is
  cheap.
- `Solv-Visitor-Id` comes from the visitor's browser. It is an unauthenticated
  hint: a visitor can rotate it or copy someone else's.
- So keep a per-assistant or global ceiling behind any per-conversation or
  per-visitor limit.

Phase 2 note on OpenAI: the phase 1 provider called Chat Completions. Per the
model pages checked on 2026-11-15 (https://developers.openai.com/api/docs/models),
both `gpt-6.1-sol` and `gpt-6-luna` support tool calling through the Responses
API (`/v1/responses`), so `openaiProvider` uses the Responses API.

The MCP client loop is provider-independent. A provider-native MCP connector may
be added later behind the same interface.

## Page actions

The assistant can act inside the page the visitor is on, not only answer. Asked
"how do I change my plan?", it can take the visitor to the billing section and
point at the control; asked to "book a demo for Tuesday", it can fill the form
and leave the visitor to press Submit.

Actions run in the visitor's browser, with the visitor's own session. No owner
credential is involved, which makes them safer than MCP tools.

Built in:

- `navigate` — go to a URL on the same site (same origin, or an origin the owner
  listed), optionally to a section:
  - Same-document target (only the fragment differs, or the current URL with a
    section): scrolls to the section and continues the conversation in place.
  - Same-origin target: persists the pending continuation in per-origin
    `sessionStorage` and calls `location.assign`; the next page's widget resumes
    the conversation on connect (dropped as "the visitor moved on" if the
    visitor sends a new message first or after 2 minutes).
  - Listed other origin: keeps the conversation on the current page and renders
    a button ("Open <host> in a new tab") that opens the owner's URL with
    `target="_blank"` and `rel="noopener noreferrer"` on click, without passing
    any transcript, ids, or extra parameters.
  - Any other origin: refused.
- `highlight` — scroll to an element and point at it with a short note.
- `fill` — put values into form fields the owner has marked as fillable. It never
  submits.

The owner marks what the built-ins may touch with two attributes:
`data-solv-target="<name>"` on anything `highlight` may point at, and
`data-solv-fill="<name>"` on each field `fill` may set; `data-solv-no-fill` on
a form or any ancestor takes everything inside it out of scope. The model is
given these names, never a selector, so what it can reach is exactly what the
markup offers. Password, payment and one-time-code fields are refused even
when marked.

Custom: the site registers its own actions in code,

```js
solv.actions.register({
  name: "open_invoice",
  description: "Open one of the visitor's invoices",
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  confirm: false,
  run: async ({ id }) => {
    router.push(`/invoices/${id}`);
    return { opened: id };
  },
});
```

and the widget sends the list of available actions (name, description, input
schema) with each chat request. The model sees them as tools. When it calls
one, the server emits an `action` event; the widget validates the input against
the schema, runs it, and posts the result back so the answer can continue.

Rules:

- Only actions the page registered, or the built-ins the owner enabled, can run.
  The model cannot run arbitrary script, pick arbitrary selectors or reach
  another origin.
- The widget says what it is about to do. Anything marked `confirm`, and every
  `fill`, waits for the visitor to accept. Nothing is submitted, bought, sent or
  deleted without the visitor's own click.
- Fields of type password, payment and one-time code are never filled or read.
- Action results and page content are untrusted input to the model, like tool
  results.
- Every action call is stored on the message, so the owner sees in
  Conversations what the assistant did.

The owner enables built-ins and sets allowed origins on the Widget screen; a
plain-language list of what the assistant may do on the page is shown there.

Page actions are phase 2. Phase 1 builds what they stand on: a conversation that
survives a page change, and a chat protocol whose event stream and request body
are versioned so `action` events and action results can be added without
breaking installed widgets.

## Answer tests

An owner writes down questions the assistant must keep getting right. A test is
a question plus one expectation: the answer cites a given URL, contains a
phrase, does not contain a phrase, or declines (uses the fallback). "Cites" passes when
the answer links to the URL in its text, or the URL is in its list of sources
(when one is shown) or among the pages it used (when none is), whatever "Show
sources in answers" is (see "Sources in answers").

- Tests run against the draft, through the same pipeline as "Try it": no
  conversation is stored and usage is metered. Each answer's trace is kept in
  `preview_traces`, marked with the run and test, and its id is on the
  result (`traceId`; see "Answer traces").
- Publish runs them first. If any fail, the owner sees which and why, and can
  fix the draft or publish anyway; the choice is recorded on the run.
- `solv test` runs them from CI with the ingest key and exits non-zero on a
  failure. Tests can be declared in `solv.config.json`.
- Conversations and Gaps offer "Add to tests" on any exchange.
- A run is capped (number of tests, wall time) so one click cannot spend
  without limit.

## Reports

The Reports screen answers "is it working?" over a date range the owner picks
(7, 30 or 90 days): questions asked, share answered, share with a thumbs down,
cost, response time, the topics, the most asked questions, the most frequent
unanswered questions, and the content used most and never. Everything is
computed from stored rows; the table can be downloaded as CSV.

"Content used most" and "Content never used" count by document id: a reply
used a document when it was given it to answer from (the same chunks its
citations come from), recorded in `message_documents`. Written answers count
as pages do; one is listed by its question, with a link to Sources instead of
an address (the CSV gives its Sources address and the type "Written answer").
A reply counts a document once. Only visitor answers count; "Try it" and test
runs store no message. Replies written before migration 0029 have no record:
for them the URLs in their citations are matched to the assistant's
documents, as before, so older periods count pages but not written answers
(and list a written answer used then as never used). A deleted document is in
neither list, for any period.

The Topics list is the period's visitor questions grouped by topic, most
asked first: each topic, its questions, and the share that could not be
answered (the reply reviewed as `declined`, or unreviewed with no content
found, as Gaps counts one). Each opens Conversations filtered to the topic
for the period. "Most often unanswered" shows each question's topic (that of
its latest tagged ask in the period) as a label. Both are in the CSV.

Response time is three figures over the period, each against the period of
the same length before it: the median and 90th percentile of the time until
the answer starts appearing (`first_token_ms`), and the median time until it
is complete (`total_ms`). Percentiles interpolate linearly between the two
nearest ranks (a spreadsheet's PERCENTILE.INC; an even count's median is the
mean of the middle two) and are rounded to whole milliseconds. They are
computed in SQL by one statement per period (`replyTiming` in
`db/reports.ts`), over the period's assistant replies found through the
`(org_id, role, created_at)` index and the conversation's key, so the cost
follows the period's traffic, not the assistant's history; there is no
rollup. Only visitor answers count; "Try it" and test runs store no message.
Replies that found nothing to answer from (the fixed fallback, `answered = 0`,
sent with no model call) are left out of every figure and the majority rule
too, and counted on their own (`noContentAnswers`, which the screens state):
they are near-instant and would pull the medians down for an assistant with
many misses.
Replies without timings (written before migration 0026) are left out, and
when they are more than half of the period's answers the figure has no number
(`status: "mostly_untimed"`) and the screen says why; `no_answers` is a
period with no answer at all. Replies that used a page action are left out
of every figure and the majority rule, and counted on their own
(`pageActionAnswers`, which the screens state): such a reply is stored when it
pauses with the first request's timings, which its continuations keep, so its
total is not the time to the complete answer, and an action-only first
request has no first token. It is known by a `kind: "action"` entry in its
stored tool calls (kept after the call resolves) or a completed resume
(`resume_revision > 0`). A period whose only answers used page actions has no
number (`page_actions_only`). The open engine sends no email; scheduled
digests belong to the cloud layer.

## Widget

A custom element, `<solv-chat assistant="pk_...">`, loaded with one script tag.
No framework, no dependencies, Shadow DOM, one file, under 30 kB gzipped.
Streams tokens, renders citations as links, restores the open conversation after a
page change or reload (conversation id, transcript and open state in sessionStorage,
so it ends with the tab), thumbs up and down, keyboard and
screen-reader usable, respects `prefers-reduced-motion` and `prefers-color-scheme`.
It sets no cookies and loads nothing from third parties into the host page:
with the visitor check on, Turnstile runs inside a frame served by the
engine's origin, created only after a visitor interaction (see "Visitor
check").

**First paint.** When the shortcut is unknown, the widget requests the
public configuration at load. This covers fresh embeds without
`launcher-shortcut` and lets the first eligible keypress open the chat, even
if the response is still pending when the visitor presses it. If the embed
declares the shortcut or the tab has a fresh copy, the first pointer enter,
focus, touch, or click on the launcher or a marked host trigger starts the
request. An accepted `open()`, `toggle()` or `send()` can also start it. All these
paths share the same request. Loading a fresh embed creates no visitor session
and writes no conversation or tab configuration.

An open while configuration is pending shows “Loading chat…” with neutral
colours and disabled input. The frame uses the opening layout when known
from the embed, the caller's requested mode or the tab. When the layout is
unknown, a compact loading frame keeps the host page in place. The layout,
title, greeting, colour and suggestions are applied together before the
first content paint. A failed request uses the existing defaults and chat
error handling. After a three-second wait on open, the fallback also lets
the visitor continue while a stalled request runs. Late settings can update
that fallback. A late `opensAs` value can take effect on the next open.

A successful response is kept in sessionStorage once the panel is open,
scoped to the engine and assistant on the embedding origin. The widget can
use it for up to two minutes after saving it. This covers ordinary
page-to-page navigation while limiting how long a tab can start from old
settings. An already-open panel restores that copy in its first frame and
revalidates in the background. A closed panel starts revalidation on the next launcher or
host-trigger interaction. Only changed settings update the view. A panel
left open on one page does not poll for updates.

Links in an answer's text (http and https only) open as the source links
under an answer do: `target="_blank"`, `rel="noopener noreferrer"`, and a
link to a page on the host site is no different, also with page help on
(the widget never handles the click; only the `navigate` action moves the
visitor's own page).

**Panel size.** On a viewport 640px wide or more the panel is
`min(460px, 100vw − 32px)` by `min(720px, 100vh − 96px)`; narrower, it keeps
`min(380px, 100vw − 32px)` by `min(560px, 100vh − 96px)`. 460px fits about 44
characters of a code line (34 at 380px), so a code block scrolls sideways less
than before for the same content, and 720px shows a five-step list with a
short code block without scrolling.

**Side panel.** With the owner's "Allow expanding to a side panel" on (the
default; `widget.allowExpand` in the version config and the public config),
the panel header has an expand control and, once expanded, a collapse control
in its place. Off, neither is in the panel at all, and a remembered expanded
state is not applied. Expanded on a viewport 900px wide or more, the chat is a
460px column on the widget's side, the full viewport height (`100dvh` where
supported), and the host page is narrowed to make room (below 900px the page
would keep less than a phone's width, so expand fills the screen instead and
leaves the page alone). The launcher is hidden while expanded.

Making room is three inline properties on the host's root element
(`document.documentElement`): `margin-right` (or `margin-left`) of 460px, added
to an inline margin the host already set (`calc(<host value> + 460px)`); a
`max-width` of the viewport less the margins, kept within a maximum the host
set, so a root sized `width: 100%` narrows too; and the custom property
`--solv-chat-panel-width: 460px`. The margin and `max-width` are `!important`
so a host stylesheet cannot undo them. Before setting them the widget records
the root's `style` attribute and each property's own value and priority; on
collapse, close, a viewport becoming too narrow, or the element being removed
it puts each property back as it was (value and `!important`), and, when the
host changed nothing else meanwhile, the attribute byte for byte (no `style`
attribute if there was none). Content in normal flow reflows into the
narrower page; elements the host fixed to that edge (`position: fixed` or
`sticky` bars) are not moved and may sit under the column unless the host
offsets them with the custom property (see the embedding notes in
`docs/self-hosting.md`).

**Docked first paint.** The optional inline head script reads the tab's
`sessionStorage` entry `solv-dock:1:<assistant public key>`. The key identifies
the assistant and format version. The JSON value is
`[side, width, placeholderCss, title, tabId]`. Width is a CSS pixel length such as `"460px"`. The CSS string contains only
literal placeholder declarations, including the panel surface, header, text,
and border colours. It contains no conversation data. The widget writes it
while open alongside the page and removes it on collapse, close, or a switch
to full-screen. The record lives in the tab on the embedding origin.
The conversation entry separately keeps the input draft, transcript scroll
offset (omitted when pinned to the latest message), and whether the input had
focus. The widget snapshots the current view and streamed transcript on
`pagehide`. A page action that navigates already saves its continuation and
action note before leaving.

The head script applies the same root properties as the widget and inserts
an inert placeholder with the stored appearance. It skips fresh tabs, narrow
viewports, copied records from an opener, and unreadable records. It makes no
requests. The widget claims the root reservation and replaces the placeholder
in a single task without rewriting the root style. If the placeholder is
still there after three seconds, the script removes it and restores the root
style. The placeholder and the dock use `view-transition-name: solv-chat-dock`
for hosts that opt in to cross-document view transitions.

**Opening and restoring.** A fresh tab starts with a closed assistant.
Conversation state is first saved when the visitor opens the panel or the
host submits a message through `send()`. The open layout and any choice
made with the expand or collapse controls are
saved with the conversation in sessionStorage, so an open panel reopens in
the same layout on navigation in the tab.

The owner's "Opens as" setting (`widget.opensAs`) defaults to Floating panel
(`panel`). Side panel (`side`) opens directly beside the page from 900px wide
when expanding is allowed. At smaller widths the assistant opens as a floating
panel. The visitor's choice with the expand or collapse control takes precedence
on later opens in the tab. Manually expanding on a small screen still opens
the full-screen view.

Page actions (`navigate`, `highlight`, `fill`) work the same while expanded.
Both controls are buttons with a name ("Expand to a side panel", "Collapse
to a small window"), `aria-controls` on the panel and `aria-expanded` (false, true);
toggling moves focus to the other control, which takes the same place, so
focus stays in the panel. Escape closes the panel as before (and gives the
page its width back). The appearing animation is off under
`prefers-reduced-motion: reduce`.

**Launcher and shortcut.** "Launcher label" (`widget.launcherLabel`) is 1–24
characters of plain text and defaults to "Chat". A fresh tab copy supplies
the first label and badge, or the embed can supply them with `launcher-label`
and `launcher-shortcut`. If the label is unknown, the launcher uses a chat
icon until configuration arrives. The embed can also supply
`launcher-position`, `launcher-accent-color` and `opens-as` (`panel` or
`side`, when side panels are enabled) for the loading view. Published
settings take over once available, and the accessible name includes the
label and the assistant title when they differ. "Keyboard shortcut"
(`widget.keyboardShortcut`) can be None (`none`, the default), `/`, or Ctrl/⌘ K
(`mod-k`). The embed accepts the same shortcut values. The widget displays
the badge outside touch-only layouts. A handled key or a key in an editable
field is left to the host page. While the shortcut is unknown the widget
records candidate keys without cancelling their browser action, then opens
only if a candidate matches the published shortcut. The shortcut opens the
assistant, focuses its input and starts the visitor check when enabled.

**Host-page API.** Once `solv-chat` is defined, `open({ mode?, focus? })`,
`close()` and `toggle()` return promises that resolve when the requested
action finishes. An accepted open shows the loading frame immediately
when settings are pending. `mode` accepts `panel` or `side`, and omitting it
uses the visitor's layout preference
or the owner's opening setting. `focus` defaults to true. A delegated click listener handles
`data-solv-chat-open` on host elements, including elements added later, with an
optional `side` or `panel` value. Call `open()` or a `toggle()` that opens from
a real visitor gesture. An accepted API or declarative open counts as
interaction for the visitor check.

```html
<button type="button" data-solv-chat-open>Ask</button>
<button type="button" id="ask-in-side-panel" data-solv-chat-open="side">Ask in the side panel</button>
<script>
  customElements.whenDefined("solv-chat").then(() => {
    const chat = document.querySelector("solv-chat");
    document.querySelector("#ask-in-side-panel").addEventListener("click", (event) => {
      event.preventDefault();
      chat.open({ mode: "side", focus: true });
    });
  });
</script>
```

`send(text: string, options?: { open?: boolean }): Promise<{ text: string }>`
submits a visitor message to the current conversation. It loads settings and
uses the same visitor check, caps, and page-action flow as the message box.
The panel stays in its current state by default and the exchange is saved.
`open: true` opens it before submitting. A confirmation or an interactive
visitor check opens a closed panel so the visitor can respond. The promise
returns the accumulated reply text after the final stream completion,
including any page-action continuations. It rejects with a displayable
`Error` if a turn is already in progress, the message is blank, too long or
refused, the assistant is unavailable, or the reply is interrupted.
If a page action navigates to another page on the same origin, the widget
on that page resumes the conversation. The promise belongs to the original
page.

The element emits `solv-chat:open` and `solv-chat:close` when visibility changes,
and `solv-chat:expand` and `solv-chat:collapse` when it enters or leaves the
expanded layout while open. Opening directly expanded emits open then expand.
All four events bubble, cross shadow boundaries, and carry no conversation
content.

**Progress while an answer is written.** From the moment a message is sent,
through the visitor check, and again while a tool or page action runs, the
answer's bubble shows a typing indicator: three CSS-animated dots (still under
reduced motion), `aria-hidden`, and the first time for that answer a visually
hidden "Writing an answer" inside the messages' `role="log"` live region, so
it is announced once. The indicator is never re-inserted with that label (a
node moved within a live region is announced again): moved below a page
action's note, the dots move alone. It goes when the first text is painted.

Each `token` event is added to the answer at once, and painted on the next
animation frame, so a fast stream lays out once a frame. While the answer is
still arriving the end of the text that could still become a Markdown
construct (an unclosed link or image, `*` / `**` emphasis, a code span, a
fence line, a list marker with nothing after it, a table row, a table header
without its delimiter row) is held back (`streaming.ts`), at most 600ms per
construct; an open code block is shown as a growing code block. At the end of
the stream the whole text is rendered as at rest, so the final view is exactly
the one-shot rendering. The same renderer and its rules apply (DOM nodes and
`textContent` only, no raw HTML). The view stays at the newest text only while
the visitor has not scrolled up more than 32px; sending a message brings it
back down.

The route writes each event as the answer pipeline yields it, and the tool
loop passes text deltas straight on. In "Link in the text" mode, the pipeline
holds possible links while it checks and rewrites them (see "Sources in
answers"). In "None" mode the marker filter holds only a tail that could
still be a citation marker. The cut-short line is appended after the last
delta. The stream is sent with `cache-control: no-cache, no-transform` to
prevent compression or regrouping along the way. A measurement through the
real route and provider parser in workerd is
`packages/engine/test/chat/streamTiming.test.ts`. The typing indicator covers
the wait for visible text, including time the model spends reasoning.

The element's `preview(config, showPanel)` method (same shape as the public
config response, with `showPanel` defaulting to true) shows the panel or the
launcher and makes no requests. The narrow preview frame shows the Side panel
setting as a full-height panel. For the admin's live preview, the real
`/widget.js` runs in a frame sandboxed with `allow-scripts` only (no
same-origin, no assistant key) and receives the unsaved form values by
`postMessage`. The frame loads `/admin/preview.html`, a static page with its
script and stylesheet in separate files (`preview.js`, `preview.css`), because
the admin's policy (`script-src 'self'; style-src 'self'`, no nonce) allows no
inline script or style. The admin policy adds `frame-src 'self'` for it. The
page's own policy (`ADMIN_PREVIEW_CSP` in `@solvchat/core`, sent as a header
and repeated in a `<meta>` tag) allows only scripts and styles from this origin
and has no `connect-src`, so nothing in the frame can make a request.

## Admin

React, served by the Worker. One screen per item:

```
[assistant switcher]
Overview · Reports · Conversations · Gaps
Sources · Tools · Behaviour · Widget · Tests
Install
```

- A "Try it" pane is always available and talks to the draft.
- Draft and Publish: edits change the draft; Publish runs the tests and promotes
  it; History lists versions with rollback.
- What changed: Publish (the header button and the screens' own) first asks,
  with "What will change": the saved draft compared with the published version,
  each changed setting by its on-screen label with what it was and is now,
  grouped by screen. Long text shows a word-level diff (removed words struck
  through, added words underlined, both named for screen readers). "Nothing has
  changed" leaves Publish disabled; with nothing published yet there is nothing
  to compare. Confirming sends the shown draft's id and revision
  (`GET …/draft` returns `revision`, the hash test runs use) as `expected` on
  `POST …/publish`, and only that draft is published: if another tab saved
  since, the engine answers 409 `draft_changed` (checked before the tests run,
  again after them, and in the promoting batch), and the admin shows the new
  comparison and asks again. Each History row has a one-line summary ("3 changes: greeting,
  tone, accent colour") and expands to its changes: a published version against
  the one published before it, the draft against the live version. Restore shows
  the changes from the live version to the one being restored before it asks.
  The diff is one pure function in `@solvchat/core` (`diffVersionConfigs`)
  driven by a field table (`VERSION_DIFF_FIELDS`: path, label, screen, kind
  `text` / `longText` / `list` / `colour` / `boolean` / `secret`); a test walks
  the version schema and fails for a setting with no entry. A `secret` setting
  only ever reads "Credential replaced" (or added, removed). Tool keys stay
  on the tool server. The page-supplied mode and header are
  versioned and appear in the Tools changes.
  Origins and tool names are shown in full. A list whose kept items change
  order shows its full old and new order, also when items were added or
  removed. Publish reads the draft from the draft endpoint, not from History.
  The versions list is the newest 100 by when each was published (the draft:
  when it was created), so the published versions in it are one unbroken run
  and each is compared with the one actually published before it. The draft
  and the live version are added whenever those are older than that, so the
  live version is always there to compare with. Tests are stored per assistant, not
  per version, so they are not part of a version's diff; the daily spend cap,
  which no screen edits, is grouped under "Spending".
- Gaps and Conversations offer one-click fixes: "Write an answer" on Gaps (creates
  an entry source and removes the gap; Conversations' "Write an answer for this"
  opens it on Gaps, filled in), "Dismiss" with undo on Gaps, "Add to tests" on both.
- Plain words on every control. No model, temperature or chunking settings.
- Sources and Try it say "Recent changes to your content can take a few
  minutes to appear in answers." while the content status is `settling`
  (see "Index lag"). The answer trace says how many matches were for
  content that has since changed, and whether it searched again.
- Sources offers "Rebuild" while some of the assistant's content was indexed
  by an older ingest version, saying what it does and what it costs before
  it starts (see "Re-indexing").
- Sources says on a source's row how many repeated parts of its pages are
  left out ("3 repeated parts left out"); choosing it opens the source's
  documents with the start of each (see "Repeated blocks").
- Sources gives a sitemap source a Sync column: how often it syncs (Off,
  Every day, Every week), when it last synced with the outcome and counts or
  the last error in plain words, when it next syncs, and "Sync now". A
  running sync shows in Status the way "Indexing…" does, and the list is
  checked again until it ends. A source's first sync (Sync now or turning a
  schedule on) asks first, because it brings in every page the sitemap lists,
  not only the ones chosen at import. Push and entry sources show no Sync
  column; with none to sync, the column is left out.
- Leaving a screen (a link, the browser's Back or Forward, or switching
  assistant) with unsaved edits on Behaviour or Widget asks first; "Stay here"
  keeps the screen and puts the address back. A move made while a save is
  running waits for that save: it goes ahead once the edits are saved, and asks
  first if the save failed, so the edits and the error stay. Closing the tab triggers the
  browser's own question while edits are unsaved or a save is still running.
- Install shows three steps: the websites that may show the chat (the
  Widget screen's list, read-only), the snippet with notes for plain HTML,
  WordPress, Shopify and Next.js, and whether the widget has been seen, taken
  from the page of the newest conversation (`lastSeen` on the install
  response; a load with no message is not counted). Under the snippet it lists
  the Content-Security-Policy lines a host site needs (`hostPolicy` on the
  install response: the engine origin in `script-src`, `connect-src` and,
  with the visitor check on, `frame-src`, plus the boot script hash in
  `script-src`) and, with the check on, what Turnstile receives and that the owner's privacy notice should mention it.
  The ingest key and CLI sit in a collapsed "For developers" section. Every
  screen shows a standing warning while the visitor check is off, on test
  keys or half set up (`visitorCheck` on the assistants list).

### Extending the admin

`@solvchat/admin` publishes both the prebuilt static app (`dist/`, served by the
open engine) and an ESM library entry (`mountAdmin(root, options)`). The open
static entry imports the stylesheet for you; the library entry does not import
CSS, so a consumer embedding `mountAdmin` must also import
`@solvchat/admin/styles.css`:

```tsx
import "@solvchat/admin/styles.css";
import { mountAdmin } from "@solvchat/admin";

const root = document.getElementById("root");
if (root) {
  mountAdmin(root, {
    extraNavItems: [
      { id: "billing", label: "Billing", path: "/admin/billing", section: "Account" },
    ],
    extraScreens: {
      billing: ({ assistant }) => <p>Billing for {assistant?.name ?? "assistant"}</p>,
    },
  });
}
```

The Widget screen's preview frame loads `/admin/preview.html`, which loads
`/admin/preview.js`, `/admin/preview.css` and `/widget.js` from the same origin.
A consumer serves the three preview files from the package's `dist/`
(exported as `@solvchat/admin/preview.html`, `preview.js` and `preview.css`)
at those paths. The admin page's policy needs `frame-src 'self'`; the preview
page's policy must allow framing by the admin (`frame-ancestors 'self'`, no
`X-Frame-Options: DENY`).

Options accepted by `mountAdmin`:

- `extraNavItems` — items appended to the sidebar (`id`, `label`, `path` under
  `/admin/…`, an optional `section` heading and an optional decorative `icon`).
  Built-in screens are grouped as _Monitor_ (Overview, Reports, Conversations,
  Gaps), _Build_ (Sources, Behaviour, Tools, Widget, Tests), _Go live_ (Install)
  and _Settings_ (Providers); an item naming one of those joins it, other
  sections follow the built-in ones.
- `extraScreens` — map from those ids to React components rendered in the main
  area with `{ assistant, assistantId, api }` (the same-origin API helpers used
  by built-in screens).
- `signIn` — optional component replacing the built-in password form when the API
  answers `401`.
- `onSignOut` — optional sign-out handler replacing the default `/api/admin/logout`
  request.
- `hideScreens` — built-in screen ids to omit from navigation and routing (for
  example, when keys are fully managed). Screens never link to a hidden screen:
  the link's text stays, without the link. With Gaps hidden, "Write an answer
  for this" on a conversation opens the answer editor in place.
- `headerStart` / `headerEnd` — optional components rendered in the top bar after
  the product name and before the Sign out button, with `{ api }`. Below 900px
  `headerEnd` moves with Sign out to the bottom of the navigation drawer.
- `assistantScoped` (on an extra nav item, default `true`) — `false` hides the
  assistant switcher, "New assistant" and the Try it pane on that screen, and
  renders it even when no assistant exists.
- `defaultScreen` — the screen `/admin/` and unknown admin paths land on (a
  visible built-in id or an extra nav item id; default Overview). Unknown or
  hidden ids throw at mount time.

The shell shows the selected assistant's publish state next to the switcher:
"Live" (the saved draft is what visitors get), "Unpublished changes" or "Not
published yet", worked out by comparing the draft and published configs from
the versions list. On Build screens it offers Publish (the same flow as the
screens: tests run first, failures can be overridden) and "Discard changes",
which saves the published config as the draft. The Try it pane is a toggle:
closed by default on Monitor screens and open elsewhere, remembered per browser
in `localStorage`; on narrow screens it is a sheet. Its transcript survives
closing it. The package entry also exports the shared components the screens
use (page header, empty state, status badge, dialogs, toasts, table, row menu,
copy button, skeleton, the list of changes between versions) and the date formatters.

With no assistant, every built-in screen except Providers shows one first-run
state: what an assistant is, the "New assistant" form inline, and the next steps
(add sources, try it, install the snippet). Creating one opens its Sources screen.

This extension point is for **adding** screens and replacing sign-in, not for
changing or shadowing engine screens. Built-in ids and routes cannot be
overridden: any clash throws synchronously at mount time, and extra screens
receive no capabilities beyond the same-origin API helpers (no remote code
loading).

## Config as code

`solv.config.json` in a site's repository describes an assistant's behaviour,
widget and tests. `solv apply` writes the draft with the ingest key
(`SOLV_INGEST_KEY`); publishing always happens in the admin. `solv push` sends
content; `solv test` runs the tests. The admin and the file edit the same draft.
A `tests` array in `solv.config.json` **replaces** the assistant's stored tests
rather than merging with them. An `mcpServers` array
(`[{ "url", "sendConversationContext" }]`) sets "Send conversation context" on
servers already added in the admin, matched by url; the file cannot add a
server, because its credential has no place in a repository. Through the ingest
key it can turn the setting off but not on (see "Conversation context
headers"), and `solv apply` checks `mcpServers` with a dry run before writing
anything, so a refused entry leaves the draft, tests and servers unchanged.
Because an ingest key can change an assistant's draft behaviour as well as its
content, it must be kept as a secret.

## Extension seams

The cloud layer replaces these and nothing else:

- `AuthProvider` — resolves a request to `{ orgId, userId, role }`. The open
  build ships a single-owner provider: an admin password set as a Worker secret,
  exchanged for a signed, HttpOnly session cookie.
- `KeyProvider` — returns the model and embedding keys for an org. The open build
  reads stored keys (sealed with `SOLV_SECRET_KEY`), then Worker secrets; when
  `managed` is true, the admin hides key-entry fields unless `ownKeysAllowed`
  is also true.
- `UsageSink` — receives usage events. The open build writes `usage_daily`.
  An event may carry `review` (a reviewed answer's outcome, on an event that
  counts nothing; see "Answer review").
- `Limits` — answers "may this org do this?". The open build enforces only the
  per-assistant spend cap and rate limits. `{ kind: "review" }` asks whether
  an answer review may spend; an implementation must answer it (the open one
  applies the spend cap only).
  The optional
  `checkSync(orgId, assistantId, { sourceId })` is asked before every
  scheduled sync run and answers `{ ok: true, maxPages?, maxDocuments? }`
  (caps that can only lower the engine's) or
  `{ ok: false, reason: "suspended" | "plan_limit" }`. Left out, every run may
  go ahead, so hosts written before it compile unchanged. A host keeps a
  suspended org from syncing by refusing here (or in `resolveOrg`).
- `VisitorCheckProvider` (optional, `seams.visitorCheck`) — supplies the
  Turnstile keys (`keys()` returns `{ siteKey, secret }`) and whether the
  check is `required`. Left out, the keys come from `SOLV_TURNSTILE_SITE_KEY`
  and `SOLV_TURNSTILE_SECRET` and the check is not required, so a host
  written before it compiles unchanged. With `required`, missing keys refuse
  the public chat instead of running it unprotected.
- `PageFetcher` — turns one https URL into
  `{ finalUrl, status, markdown, title, etag, lastModified, notModified }`.
  `fetchPage(url, { etag, lastModified })` sends those validators as
  `If-None-Match` / `If-Modified-Since`; a 304 comes back as
  `kind: "not_modified"`. A response that is not HTML, Markdown or plain text,
  or a page whose extraction leaves no text, comes back as
  `kind: "no_content"` (`reason: "not_html" | "empty"`) and is never indexed as
  an empty document. An implementation throws when it refuses or cannot fetch
  a page, and must keep the open build's protections on every request and
  redirect hop: https only, no private, loopback or link-local address, a size
  cap and a timeout. The engine does not wrap a host's fetcher in its own
  checks, so those are the host's responsibility, on scheduled syncs as much
  as on an owner's import. The type uses no Cloudflare types, so a host can implement
  it over a REST API (a headless browser, say). The open build's
  `plainPageFetcher` uses Workers `fetch` and the HTML-to-Markdown extraction
  the sitemap import has always used (10 s, 1 MiB, 3 redirects). The field is
  optional: when a host passes none, `createApp` applies `plainPageFetcher`, so
  `createApp` itself imports it from `src/ingest/` rather than `seams/open/`.

`createApp(seams, options)` returns `fetch`, `queue`, `scheduled` (the Workers
cron handler) and `runDueSyncs(env)` (the same work, for a host's own cron).

`packages/engine` exports `createApp(seams)` and the open seam implementations
(`passwordAuth`, `PasswordAuthEnv`, `SINGLE_ORG_ID`, `secretKeys`, `SecretKeyEnv`,
`usageDaily`, `basicLimits`, `CapMicrosResolver`, `DEFAULT_DAILY_CAP_MICROS`,
`plainPageFetcher`, `PlainPageFetcherOptions`), the visitor check's types and
constants (`VisitorCheckProvider`, `VisitorCheckKeys`, `VisitorCheckEnv`,
`VisitorCheckStatus`, `VisitorCheckMissing`, `VisitorCaps`,
`DEFAULT_VISITOR_CAPS`, `VISITOR_SESSION_TTL_MS`, `SITEVERIFY_URL`,
`SITEVERIFY_TIMEOUT_MS`, `TURNSTILE_ACTION`, `TURNSTILE_TOKEN_TTL_MS`) and the `PageFetcher` types
(`PageFetcher`, `PageFetchResult`, `PageContent`, `PageNotModified`,
`PageNoContent`, `PageValidators`), the sync types (`SyncLimitDecision`,
`SyncLimitRequest`, `SourceSyncState`, `SyncCounts`, `SyncOutcome`,
`SyncErrorCode`, `SyncCaps`, `DueSyncsResult`, `RunDueSyncsOptions`) and caps,
along with `./migrations/*` and `./package.json` so an embedder can apply
migrations from the installed package:

```ts
import {
  basicLimits,
  createApp,
  passwordAuth,
  plainPageFetcher,
  secretKeys,
  usageDaily,
} from "@solvchat/engine";

const app = createApp({
  auth: passwordAuth(env, env.DB),
  keys: secretKeys(env, env.DB),
  usage: usageDaily(env.DB),
  limits: basicLimits(env.DB),
  // Optional; this is what createApp applies when it is left out.
  pages: plainPageFetcher(),
});
```

An embedder replaces one or more fields of `seams` (such as `auth`) and keeps
the defaults for the rest. Its own `src/worker.ts` calls `createApp` with the
open implementations.

## Phases

1. Done. Engine, widget and admin without tools: sources, behaviour, widget,
   draft and publish, conversations, gaps. First install: propr.dev.
2. Done. MCP tools, page actions, answer tests, reports. Second install:
   mcptest.io.
3. Cloud layer in the closed repo.
