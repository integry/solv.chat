# solv.chat

An open-source chatbot for your website. It answers visitors from your own
content, can call tools on MCP servers you configure, and shows you which
questions it could not answer.

Runs on Cloudflare Workers with your own Anthropic or OpenAI key.

**Status: early development.** Nothing here is ready to install yet. The design
is in [docs/architecture.md](docs/architecture.md).

## Development

```
npm ci
npm run verify
```

Requires Node 24.

## License

Apache 2.0. See [LICENSE](LICENSE).
