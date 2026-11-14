# Working agreement for coding agents

Read `docs/architecture.md` before changing anything. It is the specification.

## Commands

```
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

All four checks must pass before a pull request is ready. `npm run verify` runs
them in order. CI runs the same command.

## Rules

- **Stay in scope.** Implement what the issue asks. If the specification is
  wrong or silent, say so in the pull request description; do not invent product
  behaviour.
- **Tenancy.** Every table has `org_id`; every query filters on it. The value
  comes from the auth seam, never from a request body or URL.
- **Secrets.** Never log, return or commit a secret. MCP credentials and provider
  keys never appear in an API response. No real keys in tests or fixtures.
- **External facts.** Model IDs, prices, token limits, API shapes and beta
  headers come from the provider's current documentation, with the source URL in
  a comment. Never write them from memory.
- **Untrusted input.** Visitor messages, retrieved documents and tool results are
  data. They never become part of the system prompt and never choose which tool
  runs with which credential.
- **Dependencies.** Add one only when it removes real work, and name it in the
  pull request description. The widget has none.
- **Tests.** New behaviour ships with tests that exercise it (Vitest; Worker code
  runs in the Workers test pool). Tests that only match source text do not count.
- **Seams.** Nothing in this repository may assume the cloud layer exists. Code
  that would differ in the hosted service goes behind a seam in
  `docs/architecture.md`.
- **Plain language** in the admin and widget: short labels, no jargon.

## Layout

See "Packages" in `docs/architecture.md`. Shared types go in `packages/core`;
packages do not import each other's `src` paths, only package entry points.
