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
