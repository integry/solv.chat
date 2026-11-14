# solv.chat GitHub Action

Pushes a folder of Markdown files to a solv.chat assistant using `@solvchat/cli`.

## Inputs

| Input       | Required | Default   | Description                                                 |
| ----------- | -------- | --------- | ----------------------------------------------------------- |
| `endpoint`  | Yes      | —         | The Worker's base URL (e.g. `https://chat.example.com`)     |
| `assistant` | Yes      | —         | The assistant ID (`ast_...`)                                |
| `base-url`  | Yes      | —         | The site URL that document paths are joined to              |
| `content`   | Yes      | —         | Folder of Markdown files to push                            |
| `prune`     | No       | `"false"` | Set to `"true"` to delete documents removed from the folder |

## Environment

Pass `SOLV_INGEST_KEY` via `env:` from a GitHub secret. It is intentionally not an action input so it never appears in workflow run inputs.

## Usage

The action installs dependencies and builds `@solvchat/cli` from its own checkout before pushing your content folder:

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
```
