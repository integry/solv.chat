# Self-hosting solv.chat

You need a Cloudflare account, Node 24, an OpenAI key (always needed for embeddings), and an Anthropic key when answers come from Anthropic (the default).

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

Four secrets. Run `npx wrangler secret put <name>` inside `packages/engine` for each one:

| Secret                | What it is                                                                    | Where it comes from                                              |
| --------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `SOLV_ADMIN_PASSWORD` | The one password that signs you in to `/admin`.                               | You choose it (or generate one with `openssl rand -base64 24`).  |
| `SOLV_SECRET_KEY`     | Signs session cookies and encrypts stored credentials.                        | `openssl rand -base64 32`. Changing it signs you out everywhere. |
| `SOLV_ANTHROPIC_KEY`  | Your Anthropic key, if the instance uses Anthropic.                           | console.anthropic.com                                            |
| `SOLV_OPENAI_KEY`     | Your OpenAI key. Needed for embeddings even when answers come from Anthropic. | platform.openai.com                                              |

By default, `packages/engine/wrangler.jsonc` sets `SOLV_LLM_PROVIDER` to `"anthropic"` and `SOLV_LLM_TIER` to `"fast"`. To answer with OpenAI or switch tiers (`"fast"` or `"balanced"`), edit those two values under `vars` in `packages/engine/wrangler.jsonc`.

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

5. In `/admin`, open **Behaviour** (or **Widget**) and click **Publish** so the assistant goes live.
6. Open **Install**, copy the `<script>` tag, paste it into your site, and ask a question.

## Rotating a secret

- `SOLV_SECRET_KEY` — every session is signed out; sign in again.

Signing out clears the session cookie in that browser only. The engine keeps no list of sessions, so a copy of the cookie stays valid until it expires after 30 days. If you think a session cookie was copied, rotate `SOLV_SECRET_KEY`.

- An ingest key — rotate it on the **Install** screen in `/admin` and replace it in CI; the old one stops working at once.
- A provider key — takes effect on the next request; nothing else changes.

## Not here yet

MCP tools, answer tests and reports are phase 2, so the admin has no Tools or Tests screen.
