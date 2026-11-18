# Self-hosting solv.chat

You need a Cloudflare account, Node 24, and keys for the providers you configure: by default, an Anthropic key for answers and an OpenAI key for embeddings (or a single OpenRouter key when both `SOLV_LLM_PROVIDER` and `SOLV_EMBEDDINGS_PROVIDER` are set to `"openrouter"`).

## 1. Clone, create Cloudflare resources, and migrate

```sh
git clone https://github.com/integry/solv.chat && cd solv.chat
npm ci
npx wrangler login

# Create the resources. Copy the database_id from `d1 create` into packages/engine/wrangler.jsonc.
npx wrangler d1 create solvchat
npx wrangler vectorize create solvchat-chunks --dimensions 1536 --metric cosine
npx wrangler vectorize create-metadata-index solvchat-chunks --property-name=org_id --type=string
npx wrangler vectorize create-metadata-index solvchat-chunks --property-name=assistant_id --type=string
npx wrangler r2 bucket create solvchat-docs
npx wrangler queues create solvchat-ingest
npx wrangler queues create solvchat-ingest-dlq

npm run migrations:apply -w @solvchat/engine
```

The metadata indexes (`org_id` and `assistant_id`) must exist before the first `solv push`; any content pushed earlier has to be pushed again after creating them.

## 2. Set secrets

Two secrets are required for the admin and encrypted storage, plus keys for the providers you use. Provider keys and provider/model choices can also be entered in `/admin` under **Settings → Providers** instead of setting provider secrets and `vars` (stored settings and keys take precedence over environment variables and secrets; `SOLV_SECRET_KEY` is required to store keys in the admin).

Run `npx wrangler secret put <name>` inside `packages/engine` for each secret you set via Worker secrets:

| Secret                | What it is                                                                                   | Where it comes from                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `SOLV_ADMIN_PASSWORD` | The one password that signs you in to `/admin`.                                              | You choose it (or generate one with `openssl rand -base64 24`).                                                   |
| `SOLV_SECRET_KEY`     | Signs session cookies and encrypts stored MCP server credentials and provider API keys.      | `openssl rand -base64 32`. Changing it signs you out everywhere and makes stored credentials and keys unreadable. |
| `SOLV_ANTHROPIC_KEY`  | Your Anthropic key, if the instance uses Anthropic (or enter in **Settings → Providers**).   | console.anthropic.com                                                                                             |
| `SOLV_OPENAI_KEY`     | Your OpenAI key. Needed for embeddings by default (or enter in **Settings → Providers**).    | platform.openai.com                                                                                               |
| `SOLV_OPENROUTER_KEY` | Your OpenRouter key, if `SOLV_LLM_PROVIDER` or `SOLV_EMBEDDINGS_PROVIDER` is `"openrouter"`. | openrouter.ai                                                                                                     |

### Provider settings in the admin and OpenRouter

You can configure the answering provider (`anthropic`, `openai`, or `openrouter`), tier or OpenRouter model ID, embeddings provider (`openai` or `openrouter`), and API keys in `/admin` under **Settings → Providers** (and test the effective key from that screen):

- **Precedence**: stored settings beat `vars` in `wrangler.jsonc`, which beat built-in defaults; stored keys beat Worker secrets. Removing a stored value falls back to the environment variable or default.
- **Encrypted keys**: keys entered in **Settings → Providers** are encrypted with `SOLV_SECRET_KEY`, write-only, and never returned by any API. `SOLV_SECRET_KEY` must be set before storing a key in the admin. If a stored key cannot be decrypted (for example after rotating `SOLV_SECRET_KEY`), answering fails rather than silently falling back to a Worker secret.

By default, `packages/engine/wrangler.jsonc` sets `SOLV_LLM_PROVIDER` to `"anthropic"` and `SOLV_LLM_TIER` to `"fast"`. To answer with OpenAI or switch tiers (`"fast"` or `"balanced"`), edit those two values under `vars` in `packages/engine/wrangler.jsonc` (or choose them in **Settings → Providers**). Built-in model IDs, prices and token limits are listed in `packages/engine/src/models.ts`.

To answer with any model on OpenRouter instead, set `SOLV_LLM_PROVIDER` to `"openrouter"` and `SOLV_LLM_MODEL` to the OpenRouter model slug (`SOLV_LLM_TIER` is ignored). You can also set `SOLV_EMBEDDINGS_PROVIDER` to `"openrouter"` to embed with `openai/text-embedding-3-small` (1536 dimensions) using `SOLV_OPENROUTER_KEY` so no OpenAI key is needed:

```jsonc
"vars": {
  "SOLV_LLM_PROVIDER": "openrouter",
  "SOLV_LLM_MODEL": "anthropic/claude-sonnet-4",
  "SOLV_EMBEDDINGS_PROVIDER": "openrouter"
}
```

For OpenRouter, the daily spend cap is counted in OpenRouter credits (if OpenRouter omits cost on a response, cost is stored as unknown and the spend cap cannot protect the instance). Tool calling and page actions depend on whether the chosen OpenRouter model supports tools.

## 3. Build and deploy

From the repository root:

```sh
npm run build
cd packages/engine && npx wrangler deploy
```

## 4. First run

1. Open `https://<your-worker>/admin` and sign in with `SOLV_ADMIN_PASSWORD`.
2. Click **New assistant**, enter a name and your website's origin (for example `https://example.com`), and create it.
3. Copy the assistant ID (`ast_…`) and the ingest key — the ingest key is shown once.
4. From the repository root, push your Markdown content:

```sh
SOLV_INGEST_KEY=<the key> npx solv push ./content \
  --endpoint https://<your-worker> --assistant ast_… --base-url https://example.com
```

`solv push` sends 10 documents per request so each request fits the Workers Free limit of 50 subrequests (calls to R2 and D1 count; see [Cloudflare's limits page](https://developers.cloudflare.com/workers/platform/limits/)). If you call the ingest API yourself, keep batches that small on Free; batches up to the API's cap of 100 need the Paid plan.

`solv push` reads `.md`, `.markdown` and `.mdx` files. A few options shape what it sends:

- `--include <glob>` and `--exclude <glob>` choose files, relative to the folder. Both can be given more than once. `*` matches within one folder, `**` across folders, and `{md,mdx}` either. For example, `--exclude "drafts/**"` leaves out a drafts folder.
- `--file <path>=<url>` also pushes one file from outside the folder, with its own URL, for example `--file README.md=https://example.com/ --file CHANGELOG.md=https://example.com/changelog`. With only `--file`, no folder or `--base-url` is needed.
- `--source <name>` names the content. Use it when more than one repository pushes into the same assistant: each name is its own source under **Sources**, and `--prune` then deletes only documents pushed under the same name. Without `--source`, everything goes to the assistant's one default source, as before. Use the same name on every push: a renamed source starts empty, and the old one keeps its documents.

If the folder is a Docusaurus docs folder, `solv push` finds that from the files themselves: an `.mdx` file, a Docusaurus front matter key such as `sidebar_position` or `sidebar_label`, an admonition (`:::note`), or an import from `@theme/`, `@site/` or `@docusaurus/`. Then, for every file in the folder:

- URLs follow Docusaurus: `slug` and `id` front matter are honoured, number prefixes (`01-intro.md`, `02-guides/`) are dropped, and `index.md`, `README.md` or a file named like its folder gives the folder's URL. Point `--base-url` at your docs root, for example `https://example.com/docs`.
- The title is the front matter `title`, else `sidebar_label`, else the first heading. The front matter `description` is put at the top of the document.
- Admonitions (`note`, `tip`, `info`, `warning`, `danger`, `caution`, `important`, `success`, `secondary`) become plain labelled paragraphs (`**Tip:** …`, or the admonition's own title), `import`/`export` lines are dropped, and components such as `<Tabs>` are replaced by the text inside them (or dropped when there is none). Only a tag that closes itself or has a matching closing tag is a component, so placeholders such as `<YOUR_TOKEN>` stay. Code blocks are kept exactly.
- Files and folders whose name starts with `_` (partials) and pages with `draft: true` or `unlisted: true` in their front matter are left out: Docusaurus gives them no public page. Push one anyway with `--file`.

Other folders are pushed as they always were. Run with `--dry-run` to see each document's URL before pushing.

5. In `/admin`, open **Behaviour** (or **Widget**) and click **Publish** so the assistant goes live (Publish promotes your draft — behaviour, widget settings, and any enabled tools — to visitors).
6. Open **Install**, copy the `<script>` tag, paste it into your site, and ask a question.

## Keeping a sitemap source in sync (optional)

A source imported from a sitemap can be read again on a schedule: on **Sources**, set its **Sync** to **Every day** or **Every week** (it is **Off** by default, so nothing changes until you turn it on), or choose **Sync now** to run it at once. The first sync asks before it starts, because it brings in every page the sitemap lists, not only the ones you chose when importing. Each run reads the sitemap again, adds pages that are new, re-fetches pages that may have changed, and removes documents whose page is no longer in the sitemap. Only the pages the sitemap lists are fetched; links are not followed.

- **Cheap when nothing changed**: a page whose sitemap `<lastmod>` is the same as last time is not fetched, for up to 7 days after it was last checked (the `recheckDays` setting, 1 to 365, default `7`); after that it is checked again even if its `<lastmod>` has not changed, so a page that was briefly wrong (a "Down for maintenance" page served as a normal page) is put right. Pages are asked for with `If-None-Match` / `If-Modified-Since`, so an unchanged page costs little, and a page whose text has not changed is never embedded again.
- **Safe against a broken sitemap**: if the sitemap cannot be loaded, is cut short or is not valid XML, or lists no pages, the run changes nothing and is recorded as failed. A sitemap index (a sitemap that lists other sitemaps) is not followed: the run fails with "This is a sitemap index; use one of the sitemaps it lists.", and the one-time import's preview says the same. Use one of the sitemaps it lists as the source's address.
- **A limit on removals**: a run that would remove more than half of the source's documents (the `maxRemovePercent` setting, 1 to 100, default `50`) changes nothing: it adds, updates and removes no page. The run is recorded as failed, and it is refused again on every later run, scheduled or not, until you step in. **Sources** offers **Sync anyway**, which says how many documents will be removed and, once you confirm, runs one sync with the limit lifted for that run only: it adds, updates and removes in one go (if by then more would go, it is refused again with the new number). You will need it after a whole-site address change, such as every URL gaining a trailing slash or moving to a new host (every old document is "not listed"), and on very small sources: removing the only page of a one-page source, or 2 pages of 3, is more than half. Check the sitemap first: a sitemap pointing at a staging host or another section of the site trips the limit the same way, and **Sync anyway** would replace your documents with those pages. To allow more for a source, set `maxRemovePercent` with `PATCH /api/admin/sources/<id>` and a body such as `{"settings": {"maxRemovePercent": 100}}`.
- **Caps**: at most 200 pages are fetched per run and a source holds at most 500 documents; the rest are counted as deferred and come up in later runs, ahead of pages that were tried more recently, even if those failed.
- **Sources** shows each sitemap source's schedule, when it last synced, the outcome with its counts (added, updated, unchanged, removed, failed, deferred, and kept when removals waited), when it will next sync, and the last error in plain words; **Overview** lists a source whose last sync failed under "Needs attention".

The schedule is driven by the cron trigger in `packages/engine/wrangler.jsonc` (`"triggers": { "crons": ["17 * * * *"] }`, hourly; each tick starts at most three due sources). It is deployed with `wrangler deploy`; Workers Free allows 5 cron triggers per account. A daily source runs about once a day, at the first tick a day after its previous run.

## 5. Tools (optional)

Open **Tools** and add an MCP server by URL (Streamable HTTP over `https:`). Every tool on a newly added server starts off, because every tool call runs with the credential you give — a visitor asking a question is what triggers it. **Use a token that can only read.**

A tool runs for visitors only when both are true: you switched it on under **Tools**, **and** you clicked **Publish** afterwards. Switching a tool on updates your draft (so you can try it in the "Try it" pane); **Publish** is what reaches visitors.

If the server needs a key, enter the header name it expects and the key value. It is stored encrypted with `SOLV_SECRET_KEY` and never shown again, so keep your own copy. If you rotate `SOLV_SECRET_KEY`, stored tool credentials become unreadable until you re-enter them on the **Tools** screen.

### Send conversation context

Every tool call comes from your Worker, so a tool server sees all your visitors as one caller. If the server limits or tracks work per visitor, switch on **Send conversation context** on that server's card under **Tools** (it is off for every server until you do, and takes effect at once; it is not part of Publish). Each request the engine then makes to that server for a visitor's chat (`initialize`, `tools/list` and `tools/call`) carries three headers:

| Header                 | Value                                                         |
| ---------------------- | ------------------------------------------------------------- |
| `Solv-Conversation-Id` | the conversation id (`cnv_…`)                                 |
| `Solv-Visitor-Id`      | the random id the widget keeps for the visitor in the browser |
| `Solv-Assistant-Id`    | the assistant id (`ast_…`)                                    |

Values are the engine's own opaque ids: an id of 1 to 128 letters, digits, `_` or `-` that does not start with `h_` is sent as it is, and any other id as `h_` followed by the first 32 hex characters of its SHA-256. Because an id that starts with `h_` is always hashed, a hashed value can never equal a raw id, so a visitor cannot pass off another visitor's hashed value as their own. Nothing else is sent in these headers: no IP address, page address or message text.

Requests from the admin and from CI belong to no visitor, so they carry `Solv-Assistant-Id` only: listing a server's tools when you add it or press **Refresh**, the "Try it" pane, and answer tests run from **Tests**, **Publish** or `solv test`. None of these stores a conversation, so none sends `Solv-Conversation-Id` or `Solv-Visitor-Id`.

The ids say nothing about who a visitor is, but they let the server link all of one visitor's conversations (in the same browser). **Turn this on only for a server you run or trust.** The three header names are reserved: you cannot add a server, or rename its key header, to one of them (in any case). A server saved with such a key header before this rule keeps working and can still be edited, disabled, have its key removed or keep the setting off; only turning **Send conversation context** on is refused until you rename the header.

#### What your tool server may rely on

- Trust these headers only on requests that carry the server's key. A server with no key cannot tell the engine's requests from anyone else's, so anyone can forge them.
- `Solv-Conversation-Id` is issued by the engine; a visitor cannot choose it. But a visitor can start as many conversations as they like.
- `Solv-Visitor-Id` comes from the visitor's browser. It is a hint, not proof: a visitor can change it or copy someone else's.
- So keep a limit per assistant, or for everyone, behind any limit per conversation or per visitor.

#### From `solv.config.json`

`solv apply` changes servers already added in the admin, matched by address, and leaves the rest alone:

```json
{ "mcpServers": [{ "url": "https://tools.example.com/mcp", "sendConversationContext": false }] }
```

The ingest key is a CI credential, so it can do less here than you can in the admin:

- It can turn **Send conversation context** off, but not on. Turn it on under **Tools** in the admin. If the file asks for on where a server is off, `solv apply` names that server, changes nothing and fails; if the server is already on, that entry is fine and changes nothing.
- Reading the servers with it shows each server's name, setting and the start of its address (for example `https://tools.example.com`), never the rest of the address or its key.

`solv apply` checks `mcpServers` with the engine before it writes anything, so if any entry would be refused, the draft, tests and servers are all left as they were.

Tool runs are capped at 4 iterations per turn, 20 tool calls per conversation, 15 seconds of wall time per answer, 10 seconds per MCP request, and 8192 bytes per tool result.

## 6. Page actions (optional)

Open **Widget**, turn on **Let the assistant help on the page**, and click **Publish** to enable the three built-in actions (`navigate`, `highlight`, and `fill`).

Mark what the assistant may touch in your HTML with two attributes:

- `data-solv-fill="<name>"` on form fields `fill` may set
- `data-solv-target="<name>"` on elements `highlight` may point at
- `data-solv-no-fill` on a form or any ancestor to take everything inside it out of scope

`fill` always asks the visitor to accept before changing a field and never submits. Password, payment and one-time-code fields are never filled or read, even if marked.

**Other sites it may send visitors to** is a different list from **Allowed origins**: the first lists extra origins `navigate` may open in a new tab, while the second lists which sites may embed and chat with the assistant at all. At most 16 page actions are sent per chat request.

A page action times out after 5 seconds so it does not hold the answer indefinitely. Timing out does not cancel the underlying call, so an action that timed out may still complete in the page.

## 7. Tests (optional)

Open **Tests** to write questions your assistant must keep getting right (up to 25 tests per assistant). Each test is a question plus one expectation: `cites` a URL, `contains` a phrase, `notContains` a phrase, or `declines` (uses the fallback).

Clicking **Publish** runs the tests against the draft first (at most 25 tests per run, within 60 seconds). If any fail, you are shown which and why, and can fix the draft or click **Publish anyway**.

From CI, run tests with the same ingest key you use for content:

```sh
SOLV_INGEST_KEY=<the key> npx solv test \
  --endpoint https://<your-worker> --assistant ast_…
```

`solv test` exits non-zero if any test fails or does not run. If you declare a `tests` array in `solv.config.json` (and pass `--file solv.config.json` to `solv test`, or run `solv apply`), it **replaces** the assistant's stored tests, including any you added in the admin; `solv test --dry-run` previews what would change first.

## 8. Reports

Open **Reports** and pick **7**, **30**, or **90** days to see questions asked, share answered, share marked unhelpful (thumbs down), cost, most asked questions, most frequent unanswered questions, and which sources were cited most and never. Click **Download CSV** to save the report on screen.

## Rotating a secret

- `SOLV_SECRET_KEY` — every session is signed out, so sign in again, and every
  MCP server credential and provider API key stored with the old key can no
  longer be read. Open **Tools** to re-enter MCP server credentials, and open
  **Settings → Providers** to re-enter any stored provider keys; until you do,
  those servers' tools cannot be called and answering with a stored provider key
  will fail rather than falling back to a Worker secret.

Signing out clears the session cookie in that browser only. The engine keeps no list of sessions, so a copy of the cookie stays valid until it expires after 30 days. If you think a session cookie was copied, rotate `SOLV_SECRET_KEY`.

- An ingest key — rotate it on the **Install** screen in `/admin` and replace it in CI; the old one stops working at once.
- A provider key — takes effect on the next request; nothing else changes.

## Upgrading an existing instance

From the repository root, apply the new D1 migrations, rebuild, and redeploy:

```sh
npm ci
npm run migrations:apply -w @solvchat/engine
npm run build
cd packages/engine && npx wrangler deploy
```

No environment variable needs to change. The scheduled sitemap sync adds a cron trigger to `wrangler.jsonc`; `wrangler deploy` installs it, and no source syncs until you set its schedule. Upgrading to this version signs existing admin sessions out once because session cookies are now signed with a key derived from `SOLV_SECRET_KEY`; sign in again after deploying.

## Not here yet

- The cloud layer: public sign-up, teams and roles, billing, managed model keys, and scheduled email digests. Those live in a separate, closed repository; nothing here needs them.
- A crawler that follows links. Content is pushed with `solv push`, imported from a sitemap (once, or again daily or weekly; see "Keeping a sitemap source in sync"), or written by hand under **Sources**. Only pages a sitemap lists are ever fetched.
