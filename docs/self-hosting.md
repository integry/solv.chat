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

| Secret                | What it is                                                                                   | Where it comes from                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `SOLV_ADMIN_PASSWORD` | The one password that signs you in to `/admin`.                                              | You choose it (or generate one with `openssl rand -base64 24`).                                              |
| `SOLV_SECRET_KEY`     | Signs session cookies and encrypts stored MCP server credentials and provider API keys.      | `openssl rand -base64 32`. Changing it signs you out everywhere and makes stored credentials and keys unreadable. |
| `SOLV_ANTHROPIC_KEY`  | Your Anthropic key, if the instance uses Anthropic (or enter in **Settings → Providers**).   | console.anthropic.com                                                                                        |
| `SOLV_OPENAI_KEY`     | Your OpenAI key. Needed for embeddings by default (or enter in **Settings → Providers**).    | platform.openai.com                                                                                          |
| `SOLV_OPENROUTER_KEY` | Your OpenRouter key, if `SOLV_LLM_PROVIDER` or `SOLV_EMBEDDINGS_PROVIDER` is `"openrouter"`. | openrouter.ai                                                                                                |

By default, `packages/engine/wrangler.jsonc` sets `SOLV_LLM_PROVIDER` to `"anthropic"` and `SOLV_LLM_TIER` to `"fast"`. To answer with OpenAI or switch tiers (`"fast"` or `"balanced"`), edit those two values under `vars` in `packages/engine/wrangler.jsonc`.

To answer with any model on OpenRouter instead, set `SOLV_LLM_PROVIDER` to `"openrouter"` and `SOLV_LLM_MODEL` to the OpenRouter model slug (`SOLV_LLM_TIER` is ignored). You can also set `SOLV_EMBEDDINGS_PROVIDER` to `"openrouter"` to embed with `openai/text-embedding-3-small` (1536 dimensions) using `SOLV_OPENROUTER_KEY` so no OpenAI key is needed:

```jsonc
"vars": {
  "SOLV_LLM_PROVIDER": "openrouter",
  "SOLV_LLM_MODEL": "anthropic/claude-sonnet-4",
  "SOLV_EMBEDDINGS_PROVIDER": "openrouter"
}
```

For OpenRouter, the daily spend cap is counted in OpenRouter credits.

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

5. In `/admin`, open **Behaviour** (or **Widget**) and click **Publish** so the assistant goes live.
6. Open **Install**, copy the `<script>` tag, paste it into your site, and ask a question.

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

## Not here yet

MCP tools, answer tests and reports are phase 2, so the admin has no Tools or Tests screen.
