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
  tried_at and widget_seen_at (first "Try it" question and first widget load on an
  allowed origin; set once, for the Overview checklist).
- `assistant_versions` — id, assistant_id, state (`draft` | `published` | `archived`),
  config JSON (behaviour, widget, tool allowlist), created_at, published_at.
  Exactly one draft and at most one published version per assistant. Publishing
  promotes the draft row itself to `published` (it keeps its id, so a "Try it"
  conversation started against the draft still resolves), archives the previous
  published version, and inserts a fresh draft with the same config; rollback
  republishes an archived version.
- `sources` — id, assistant_id, kind (`push` | `sitemap` | `entry`), label, settings.
  A sitemap source's settings are `url` (the sitemap), `sync` (`off` | `daily` |
  `weekly`; left out means `off`) and `maxRemovePercent` (1–100, default 50); see
  "Scheduled sitemap sync".
- `documents` — id, source_id, external_id, url, title, content_hash, updated_at,
  indexed_hash (the content last made searchable), index_error and
  index_error_hash (a short code saying why the content with that hash could
  not be indexed: `too_long`, `missing_body` or `embedding_failed`; never a
  provider message), and for sitemap sync: etag, last_modified and
  sitemap_lastmod (validators from the last check) and sync_checked_at (when
  a check last succeeded).
- `source_syncs` — org_id, source_id, run_id, lease_until (set while a run
  holds the source), started_at, finished_at, outcome (`running` |
  `succeeded` | `partial` | `failed`), counts (added, updated, unchanged,
  removed, failed, deferred) and error (a short code). One row per source: the
  current or latest run.
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
  keyed by chunk id, with `org_id` and `assistant_id` as metadata filters.
- `conversations` — id, assistant_id, visitor_id (random, cookie-less; stored in
  the widget's localStorage), started_at, page_url, last_message_at (when the
  newest message was written, `started_at` while there is none; kept by
  triggers, and the order of the Conversations list).
- `messages` — id, conversation_id, role, content, citations JSON, tool_calls JSON,
  tokens_in, tokens_out, answered (boolean: did retrieval find support),
  search_text (content in Unicode lowercase, NFC, final sigma "ς" as "σ",
  whitespace runs collapsed like the question key, for the Conversations search. For rows written before it
  existed, the migration fills it for ASCII text and the engine folds the rest
  of the searched assistant's messages before it runs a search, a bounded
  share per request; until none are left a search answers `searchPending: true`
  with no results instead of searching).
- `feedback` — message_id, value (`up` | `down`), note.
- `mcp_servers` — id, assistant_id, label, url, auth_kind (`none` | `static_header`),
  secret_ciphertext, enabled.
- `mcp_tools` — server_id, name, description, input_schema, allowed (default false).
- `tests` — id, assistant_id, question, expectation (must-cite URL, must-contain,
  must-not-contain, or must-decline).
- `test_runs` — id, version_id, started_at, results JSON, passed.
- `usage_daily` — org_id, assistant_id, day, messages, tokens_in, tokens_out, cost_micros.
- `gap_dismissals` — org_id, assistant_id, question_key, dismissed_at. A dismissed gap
  group is hidden until the question is asked again after `dismissed_at`.

Migrations are plain SQL files under `packages/engine/migrations`, applied with
`wrangler d1 migrations`.

## Public API (called by the widget)

- `POST /v1/chat` — body: assistant public key, conversation id (optional), message.
  The body also carries a protocol version; the engine refuses a version it does
  not support with an `error` event, and clients ignore event types they do not
  know. Responds with server-sent events: `token`, `citation`, `tool`, `done`,
  `error` (and `action` from phase 2).

  An answer that needs a page action pauses rather than waiting on the open
  stream: the engine emits `action` events and then `done` with
  `awaitingActions`, and the widget runs them and sends a second request with
  the same conversation id, `resumeMessageId` and `actionResults`, and no
  `message`. A held-open stream would not survive `navigate`, which replaces
  the page the stream belongs to.
- `POST /v1/feedback` — thumbs up or down on a message.
- `GET /v1/assistants/:publicKey` — published widget config (title, colours, greeting,
  suggested questions). No secrets, no prompts.
- `GET /widget.js` — the widget bundle.

Checks on every public request, in this order: Origin against the assistant's
`allowed_origins`; per-IP rate limit; the assistant's daily spend cap. A request
that fails one gets a plain error event and costs nothing.

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
"Extension seams"). The open build's fetcher validates every URL and redirect
hop as `https:` and checks the hostname via DNS-over-HTTPS before fetching,
refusing private, loopback, or link-local addresses. A page with no text is
written as its title alone; a response that is not a page or text (a PDF, an
image) is skipped and counted in the import's `skipped`. Because Workers
`fetch` resolves the hostname separately from that pre-check, a host that
changes its DNS answer between the check and the fetch is not caught; that is
an accepted limitation for an action only the signed-in owner can trigger.

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
   `<url>` entries with their `<lastmod>`; a sitemap index is not followed).
   Entries are read from the same reading of the XML that step 4 checks, so a
   commented-out `<url>` or `<loc>` is not a listed page.
4. Guards against a broken sitemap: if it cannot be read (`sitemap_unavailable`),
   is not one complete, well-formed XML document with a `<urlset>` root
   (`sitemap_invalid`: cut short, broken XML, bare `<loc>` lists; the admin's
   preview still reads those), lists no page (`sitemap_empty`), or would
   remove more than
   `maxRemovePercent` of the source's documents (`too_many_removals`), the run
   removes nothing, fetches nothing, and is recorded as failed. A sitemap with
   more than 50,000 entries removes nothing in that run.
5. Removes the source's documents whose URL is no longer listed (that source
   only; vectors and R2 bodies are cleaned up as for a prune).
6. Skips pages whose sitemap `<lastmod>` equals the one stored at the last
   check, without fetching them, once their current content is indexed; a
   document whose indexing failed is checked again. The rest are queued in the order a run last
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
calls it, and the open build's `wrangler.jsonc` runs it hourly. A host with
its own cron (every 10 minutes, say) calls `runDueSyncs` instead. Finding due
sources is the one query without an org filter: a cron has no request and so
no org, so it reads only org and source ids, and everything after goes
through the org's `Tenant` once the auth seam has vouched for it. A refusal
is recorded in `sync_org_refusals` from the seam's own answer, keyed by the
org; nothing of the org is read.

D1 is the only source of truth for live chunks; readers resolve retrieved vector
ids through D1, so leftover vectors and R2 objects can accumulate after failures.
They cost storage only and never affect an answer. A later task adds a reindex
command that rebuilds an assistant's index from D1.

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
  questions per day, the getting-started checklist (content added, a question
  tried in "Try it" or a test run, published, widget loaded on an allowed
  origin or a visitor question received, first visitor question) and what needs
  attention (open gaps, failed tests in the latest run, the configuration
  error, sources with documents that failed to index, reported as soon as the
  failure is recorded, and sources with documents still not indexed 15 minutes
  after they were written, reported separately, and sitemap sources whose
  latest sync failed or was interrupted, `syncFailed`, with the error code;
  a `partial` run is shown on Sources only).
- Conversations: `filter=unanswered,not_helpful,used_tool`, `days=1|7|30|90`,
  `q=` (case-insensitive text in any message) and `question=` (a grouped
  question: conversations where a visitor asked it, matched by its key; what
  question links in Overview and Reports open), with `askedFrom=` and
  `askedTo=` (inclusive UTC days, `YYYY-MM-DD`; only with `question=`) keeping
  the asks made in those days, the period a Reports count is for. `days=` is
  when a conversation started, a separate filter; unknown values are refused.
  The admin keeps all of them in the screen's address.
  `searchPending: true` means older messages are still being prepared for
  search: nothing was searched, `searchRemaining` says how many of the
  assistant's messages are left, and the admin asks again until it is false.
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
  that is not a sitemap answers `400`. The schedule is changed with `PATCH
  /api/admin/sources/:id` and `{ "settings": { "sync": … } }`.
- Gaps: `status=open` leaves out groups with a written answer newer than the
  group's latest ask (asked again after it, a group is open again, as after a
  dismissal). Overview's open gaps and Reports' "Most often unanswered" leave
  out the same groups, and the asks from before a dismissal (not counted, but
  an answer written from one still answers its group). Left out,
  `status` lists every group; any other value is refused;
  `POST …/gaps/dismiss` and `POST …/gaps/restore` take `{ question }`.

## Answering a message

1. Load the published version (or the draft, for the admin "Try it" pane).
2. Retrieve: embed the question, query the retriever for the assistant, keep the
   top chunks above a score floor (top 6, floor 0.3; chosen for v1, not tuned).
3. Build the prompt: fixed safety frame, the owner's behaviour fields, retrieved
   chunks with their URLs (capped at 2000 characters each), the last 6 turns.
4. Call the model through the provider interface, streaming. If tools are allowed,
   run the MCP loop: the model asks for a tool, the Worker calls the MCP server,
   the result goes back as untrusted data.
5. Persist messages, citations, token counts, cost; update `usage_daily`.
6. If nothing was retrieved above the floor and no tool answered, say so, use the
   owner's fallback text, and mark the message `answered = false` so it shows
   under Gaps.

## Providers

`LlmProvider` has three implementations: Anthropic, OpenAI and OpenRouter. `Embedder` has two:
OpenAI embeddings (default) and OpenRouter embeddings (`SOLV_EMBEDDINGS_PROVIDER=openrouter`,
fixed to `openai/text-embedding-3-small` at 1536 dimensions). `Retriever` has one: Vectorize; the interface exists so
Cloudflare AI Search can be added as a second backend.

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

Every visitor is anonymous, and every tool call runs with the owner's
credential. The rules that follow from that:

- Tools are off by default, per tool.
- The admin shows a standing warning that visitors act with this credential and
  recommends a read-only token.
- v1 auth is `none` or a static header. The secret is encrypted with a key from
  a Worker secret (`SOLV_SECRET_KEY`, AES-GCM), decrypted only inside the Worker at
  call time, and never returned by any API — the admin shows "set" or "not set".
- Tool results are untrusted input. They are passed to the model as data, never
  concatenated into the system prompt, and are capped in size.
- Per-conversation caps on the number of tool calls and on wall time.
- Server URLs must be https and must not resolve to private or loopback ranges.

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
phrase, does not contain a phrase, or declines (uses the fallback).

- Tests run against the draft, through the same pipeline as "Try it": no
  conversation is stored and usage is metered.
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
cost, the most asked questions, the most frequent unanswered questions, and the
sources cited most and never. Everything is computed from stored rows; the
table can be downloaded as CSV. The open engine sends no email; scheduled
digests belong to the cloud layer.

## Widget

A custom element, `<solv-chat assistant="pk_...">`, loaded with one script tag.
No framework, no dependencies, Shadow DOM, one file, under 30 kB gzipped.
Streams tokens, renders citations as links, restores the open conversation after a
page change or reload (conversation id, transcript and open state in sessionStorage,
so it ends with the tab), thumbs up and down, keyboard and
screen-reader usable, respects `prefers-reduced-motion` and `prefers-color-scheme`.
It sets no cookies and loads nothing from third parties.

The element's `preview(config)` method (same shape as the public config
response) shows a config with the panel open and from then on makes no
requests. The admin's Widget screen uses it for a live preview: the real
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
- Gaps and Conversations offer one-click fixes: "Write an answer" on Gaps (creates
  an entry source and removes the gap; Conversations' "Write an answer for this"
  opens it on Gaps, filled in), "Dismiss" with undo on Gaps, "Add to tests" on both.
- Plain words on every control. No model, temperature or chunking settings.
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
  response; a load with no message is not counted). The ingest key and CLI
  sit in a collapsed "For developers" section.

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
copy button, skeleton) and the date formatters.

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
rather than merging with them.
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
- `Limits` — answers "may this org do this?". The open build enforces only the
  per-assistant spend cap and rate limits. The optional
  `checkSync(orgId, assistantId, { sourceId })` is asked before every
  scheduled sync run and answers `{ ok: true, maxPages?, maxDocuments? }`
  (caps that can only lower the engine's) or
  `{ ok: false, reason: "suspended" | "plan_limit" }`. Left out, every run may
  go ahead, so hosts written before it compile unchanged. A host keeps a
  suspended org from syncing by refusing here (or in `resolveOrg`).
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
  cap and a timeout. The type uses no Cloudflare types, so a host can implement
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
`plainPageFetcher`, `PlainPageFetcherOptions`) and the `PageFetcher` types
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
