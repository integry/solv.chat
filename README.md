# solv.chat

An open-source chatbot for your website. It answers visitors from your own
content, can call tools on MCP servers you configure, and shows you which
questions it could not answer.

Runs on Cloudflare Workers with your own Anthropic, OpenAI, or OpenRouter key.

**Status: self-hostable.** The chat engine, widget, admin, MCP tools, page
actions, answer tests and reports work. The cloud layer — sign-up, teams,
billing, managed keys, email — is phase 3 and not in this repository; it is not
needed to run your own. There is no crawler: content is pushed, imported once
from a sitemap, or written by hand.

To run your own, follow [docs/self-hosting.md](docs/self-hosting.md). The
design is in [docs/architecture.md](docs/architecture.md).

## Development

```
npm ci
npm run verify
```

Requires Node 24.

### Engine (`packages/engine`)

```
npm run typecheck -w @solvchat/engine
npm run test -w @solvchat/engine
npm run build -w @solvchat/engine
```

Required Worker secrets (set with `wrangler secret put` or `.dev.vars` locally; provider keys can also be entered in the admin under **Settings → Providers** when `SOLV_SECRET_KEY` is set):

- `SOLV_ADMIN_PASSWORD` — admin sign-in password
- `SOLV_SECRET_KEY` — signs session cookies and encrypts stored MCP tool credentials and stored provider API keys. Changing it signs everyone out **and** makes stored credentials and keys unreadable until you enter them again.
- `SOLV_ANTHROPIC_KEY` — Anthropic API key (optional if entered in **Settings → Providers**)
- `SOLV_OPENAI_KEY` — OpenAI API key (optional if entered in **Settings → Providers**)
- `SOLV_OPENROUTER_KEY` — OpenRouter API key (optional if entered in **Settings → Providers**)

## Page actions

Your assistant can act inside the page a visitor is on. Register your own
actions and it will use them while it answers:

```js
solv.actions.register({
  name: "open_invoice",
  description: "Open one of the visitor's invoices",
  input: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  confirm: false,
  run: async ({ id }) => {
    router.push(`/invoices/${id}`);
    return { opened: id };
  },
});
```

Three actions are built in and off until you turn them on under **Widget**:
`navigate` moves a visitor around your site, `highlight` points at a control,
and `fill` puts values into fields you marked. Mark them in your HTML:

```html
<input data-solv-fill="email" name="email" />
<button data-solv-target="save">Save changes</button>
<form data-solv-no-fill>...</form>
```

Anything marked `confirm`, and every `fill`, waits for the visitor to accept.
Nothing is submitted, bought, sent or deleted without their own click. Password,
payment and one-time-code fields are never filled or read, even if marked.

## License

Apache 2.0. See [LICENSE](LICENSE).
