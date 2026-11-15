# solv.chat

An open-source chatbot for your website. It answers visitors from your own
content, can call tools on MCP servers you configure, and shows you which
questions it could not answer.

Runs on Cloudflare Workers with your own Anthropic or OpenAI key.

**Status: early development.** The chat engine, widget and admin work; MCP
tools, answer tests and reports are not built yet. To run your own, follow
[docs/self-hosting.md](docs/self-hosting.md). The design is in
[docs/architecture.md](docs/architecture.md).

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

Required Worker secrets (set with `wrangler secret put` or `.dev.vars` locally):

- `SOLV_ADMIN_PASSWORD` — admin sign-in password
- `SOLV_SECRET_KEY` — HMAC signing key for session cookies and secret encryption
- `SOLV_ANTHROPIC_KEY` — Anthropic API key
- `SOLV_OPENAI_KEY` — OpenAI API key (models and embeddings)

## License

Apache 2.0. See [LICENSE](LICENSE).
