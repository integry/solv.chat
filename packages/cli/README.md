# @solvchat/cli

The `solv` command pushes content to a solv.chat assistant, applies `solv.config.json` to its draft, and runs its answer tests. Every command reads the assistant's ingest key from `SOLV_INGEST_KEY`; it is never a flag.

```sh
SOLV_INGEST_KEY=<the key> npx solv push ./docs \
  --endpoint https://chat.example.com --assistant ast_… --base-url https://example.com/docs
```

Run `solv --help` or `solv <command> --help` for every option. To run it from GitHub Actions, see [the action](action/README.md).

## solv push

Pushes a folder of `.md`, `.markdown` and `.mdx` files, or a prepared JSON batch (`--json <file>`).

| Option                | What it does                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `--endpoint <url>`    | Your Worker's URL (required)                                                              |
| `--assistant <id>`    | The assistant ID, `ast_…` (required)                                                      |
| `--base-url <url>`    | The site URL each page's path is joined to (required with a folder)                       |
| `--include <glob>`    | Push only files matching the glob, relative to the folder. Can be given more than once    |
| `--exclude <glob>`    | Leave out files matching the glob. Can be given more than once                            |
| `--file <path>=<url>` | Also push one file from outside the folder, with its own URL. Can be given more than once |
| `--source <name>`     | Name this content; `--prune` then deletes only documents pushed under the same name       |
| `--source-id <id>`    | Push into an existing push source by ID instead                                           |
| `--prune`             | Delete documents that were not in this push                                               |
| `--dry-run`           | Print each document's ID and URL without sending anything                                 |

### Choosing files

Globs match the path relative to the folder, with `/` between folders: `*` matches within one folder, `**` across any number of folders, `?` one character, `[0-9]` one of a set and `{md,mdx}` either alternative.

```sh
solv push ./docs --base-url https://example.com/docs \
  --exclude "**/_*" --exclude "drafts/**" \
  --file README.md=https://example.com/ \
  --file CHANGELOG.md=https://example.com/changelog \
  --endpoint … --assistant …
```

A `--file` document's ID is its path relative to the directory you run `solv` from, so run it from the same place every time (in CI, the repository root). With only `--file`, no folder or `--base-url` is needed.

### Two repositories, one assistant

Without `--source`, every push goes to the assistant's one default source, and `--prune` deletes whatever that push did not include. If two repositories push into the same assistant, give each its own name:

```sh
solv push ./docs --source docs --prune …   # in the docs repository
solv push ./guides --source sdk --prune …  # in the SDK repository
```

Each name is its own source under **Sources**, and each prune only deletes documents pushed under its own name. Keep the name the same on every push: a new name starts a new, empty source, and the old one keeps its documents.

### Docusaurus

When the folder is a Docusaurus docs folder, `solv push` notices from the files themselves; there is no flag. It looks for an `.mdx` file, a Docusaurus front matter key (`sidebar_position`, `sidebar_label`, `hide_title`, `pagination_next` and the like), an admonition such as `:::note`, or an import from `@theme/`, `@site/` or `@docusaurus/`. One such file is enough, and the choice covers every file in the folder, whatever `--include` selects.

For a Docusaurus folder, point `--base-url` at the docs root (for example `https://example.com/docs`). Then:

- **URLs.** `slug` front matter wins: `/path` is taken from the docs root, anything else from the page's folder. Without it, the front matter `id` replaces the file name. Number prefixes (`01-intro.md`, `02-guides/`) are dropped, but not dates or versions (`2024-01-notes.md`, `7.0-notes.md`). A file named `index`, `README` (any case) or like its folder (`guides/guides.md`) gives the folder's URL, `…/guides/`.
- **Titles.** The front matter `title`, else `sidebar_label`, else the first heading, else the file name. The front matter `description` is put at the top of the document, under its first heading.
- **Cleanup.** Admonitions (`:::note`, `:::tip`, `:::info`, `:::warning`, `:::danger`, nested or not) become plain paragraphs labelled with their title, or with their type when they have none: `**Tip:** Pin the version in CI.` `import` and `export` lines are dropped. Components such as `<Tabs>` and `<TabItem>` are replaced by the text inside them; ones with no text inside, such as `<Diagram />`, are dropped. Lower-case HTML is kept. Code blocks and inline code are never changed.

Files starting with `_` are partials in Docusaurus, not pages; leave them out with `--exclude "**/_*"`. Each `--file` is checked on its own, so a plain `README.md` is pushed as written.

Folders without any of these signs are pushed exactly as before: the path without its extension is both the document ID and the URL path, the title comes from the front matter `title` or the first heading, and the content is sent unchanged.

## solv apply

Applies `solv.config.json` (or the file you name) to the assistant's draft. Publishing always happens in the admin.

## solv test

Runs the assistant's answer tests and exits non-zero if any fails or does not run. A `tests` array in the file you name replaces the stored tests.
