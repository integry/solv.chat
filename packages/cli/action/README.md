# solv.chat GitHub Action

Pushes a folder of Markdown files and/or applies `solv.config.json` to an assistant's draft using `@solvchat/cli`.

## Inputs

| Input       | Required | Default   | Description                                                                                                                 |
| ----------- | -------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`  | Yes\*    | —         | The Worker's base URL (e.g. `https://chat.example.com`)                                                                     |
| `assistant` | Yes\*    | —         | The assistant ID (`ast_...`)                                                                                                |
| `base-url`  | No       | —         | The site URL that document paths are joined to (required when `content` is set)                                             |
| `content`   | No       | —         | Folder of Markdown files to push                                                                                            |
| `include`   | No       | —         | Push only files in `content` that match these globs, one per line                                                           |
| `exclude`   | No       | —         | Leave out files in `content` that match these globs, one per line                                                           |
| `files`     | No       | —         | Extra files to push with their own URLs, one per line as `path=url` (e.g. `README.md=https://docs.example.com/`)            |
| `source`    | No       | —         | Name of this content; `prune` then deletes only documents pushed under the same name                                        |
| `prune`     | No       | `"false"` | Set to `"true"` to delete documents removed from the folder                                                                 |
| `config`    | No       | —         | Path to `solv.config.json` to apply to the assistant's draft                                                                |
| `test`      | No       | `"false"` | Set to `"true"` to run the assistant's answer tests after pushing and applying (at most 25 tests per assistant and per run) |

Provide at least one of `content`, `files`, `config`, or `test: "true"`. `include` and `exclude` need `content`. Blank lines in the list inputs are ignored. The options behave as they do in [`solv push`](../README.md#solv-push).

\* When `endpoint`, `assistant` or `SOLV_INGEST_KEY` is empty, the action does nothing and succeeds with a notice that names what is missing. Forks and repositories that have not set the action up yet do not fail.

## Environment

Pass `SOLV_INGEST_KEY` via `env:` from a GitHub secret. One key authenticates `push`, `apply`, and `test`. It is intentionally not an action input so it never appears in workflow run inputs.

`solv apply` updates the assistant's draft only; publishing always happens in the admin. Because an ingest key can change draft behaviour as well as content, treat `SOLV_INGEST_KEY` as a secret.

## Tool servers in `solv.config.json`

An `mcpServers` array (`[{ "url": "https://tools.example.com/mcp", "sendConversationContext": false }]`) sets **Send conversation context** on tool servers already added in the admin, matched by address. The ingest key is a CI credential, so it is limited here:

- It can turn the setting **off but not on**. Sending visitor ids to a server needs a signed-in admin: turn it on under **Tools**. If the file asks for on where a server is off, `solv apply` prints which server to turn on in the admin and exits non-zero. If the server is already on, that entry is accepted and changes nothing.
- It never sees a server's key, and sees only the origin of its address (for example `https://tools.example.com`), never the path or query.

`solv apply` checks `mcpServers` with the engine before it writes anything. If any entry would be refused, nothing changes: not the draft, the tests or any server.

## Example: a Docusaurus site

Pushes the `docs` folder, `README.md` and `CHANGELOG.md` on every push to the default branch. Save it as `.github/workflows/solv.yml`, then in the repository's **Settings → Secrets and variables → Actions** add:

- the secret `SOLV_INGEST_KEY`,
- the variables `SOLV_ENDPOINT` (e.g. `https://chat.example.com`) and `SOLV_ASSISTANT` (e.g. `ast_0123456789abcdef`).

Until all three are set, the job succeeds with a notice and pushes nothing.

```yaml
name: Sync docs to solv.chat

on:
  push:
    branches: [main] # your default branch

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: integry/solv.chat/packages/cli/action@main
        env:
          SOLV_INGEST_KEY: ${{ secrets.SOLV_INGEST_KEY }}
        with:
          endpoint: ${{ vars.SOLV_ENDPOINT }}
          assistant: ${{ vars.SOLV_ASSISTANT }}
          content: docs
          base-url: https://docs.example.com/docs
          exclude: |
            **/_*
          files: |
            README.md=https://docs.example.com/
            CHANGELOG.md=https://docs.example.com/changelog
          source: docs
          prune: "true"
```

Replace `https://docs.example.com` with your site's URL. `base-url` is where the docs folder is served (Docusaurus serves it under `/docs` by default); `exclude: "**/_*"` leaves out `_` files in any folder; in a Docusaurus folder `solv push` already leaves out files and folders starting with `_`, and pages with `draft: true` or `unlisted: true`. The `files` paths are relative to the repository root, which is where the action runs, so their document IDs stay the same on every push. With `source: docs` and `prune: "true"`, a page deleted from the folder is deleted from the assistant too, and nothing pushed under another name is touched.

## All inputs

The action installs dependencies and builds `@solvchat/cli` from its own checkout before running `solv push`, `solv apply` and/or `solv test`:

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
    include: |
      guides/**
      *.md
    exclude: |
      **/_*
    files: |
      README.md=https://docs.example.com/
    source: docs
    prune: "true"
    config: solv.config.json
    test: "true"
```
