# solv.chat GitHub Action

Pushes a folder of Markdown files and/or applies `solv.config.json` to an assistant's draft using `@solvchat/cli`.

## Inputs

| Input       | Required | Default   | Description                                                                                                                 |
| ----------- | -------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`  | Yes      | —         | The Worker's base URL (e.g. `https://chat.example.com`)                                                                     |
| `assistant` | Yes      | —         | The assistant ID (`ast_...`)                                                                                                |
| `base-url`  | No       | —         | The site URL that document paths are joined to (required when `content` is set)                                             |
| `content`   | No       | —         | Folder of Markdown files to push                                                                                            |
| `prune`     | No       | `"false"` | Set to `"true"` to delete documents removed from the folder                                                                 |
| `config`    | No       | —         | Path to `solv.config.json` to apply to the assistant's draft                                                                |
| `test`      | No       | `"false"` | Set to `"true"` to run the assistant's answer tests after pushing and applying (at most 25 tests per assistant and per run) |

Provide at least one of `content`, `config`, or `test: "true"`.

## Environment

Pass `SOLV_INGEST_KEY` via `env:` from a GitHub secret. One key authenticates `push`, `apply`, and `test`. It is intentionally not an action input so it never appears in workflow run inputs.

`solv apply` updates the assistant's draft only; publishing always happens in the admin. Because an ingest key can change draft behaviour as well as content, treat `SOLV_INGEST_KEY` as a secret.

## Tool servers in `solv.config.json`

An `mcpServers` array (`[{ "url": "https://tools.example.com/mcp", "sendConversationContext": false }]`) sets **Send conversation context** on tool servers already added in the admin, matched by address. The ingest key is a CI credential, so it is limited here:

- It can turn the setting **off but not on**. Sending visitor ids to a server needs a signed-in admin: turn it on under **Tools**. If the file asks for on where a server is off, `solv apply` prints which server to turn on in the admin and exits non-zero. If the server is already on, that entry is accepted and changes nothing.
- It never sees a server's key, and sees only the origin of its address (for example `https://tools.example.com`), never the path or query.

`solv apply` checks `mcpServers` with the engine before it writes anything. If any entry would be refused, nothing changes: not the draft, the tests or any server.

## Usage

The action installs dependencies and builds `@solvchat/cli` from its own checkout before running `solv push` and/or `solv apply`:

```yaml
- uses: actions/checkout@v4
- uses: integry/solv.chat/packages/cli/action@main
  env:
    SOLV_INGEST_KEY: ${{ secrets.SOLV_INGEST_KEY }}
  with:
    endpoint: https://chat.example.com
    assistant: ast_0123456789abcdef
    base-url: https://docs.example.com
    content: docs
    prune: "true"
    config: solv.config.json
    test: "true"
```
