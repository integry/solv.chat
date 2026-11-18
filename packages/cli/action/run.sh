#!/usr/bin/env bash
# Runs solv push, solv apply and solv test for the GitHub Action.
#
# Every value arrives in an environment variable (INPUT_*, SOLV_INGEST_KEY)
# and is passed to the CLI as its own argument, never pasted into shell code.
# The ingest key is only checked for presence here; the CLI reads it itself.
set -euo pipefail

# Appends "<flag> <line>" to args for each non-empty, trimmed line of a
# multi-line input. Plain loops, not mapfile, so macOS's bash 3.2 works too.
add_lines() {
  local flag="$1" line
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    if [ -n "$line" ]; then
      args+=("$flag" "$line")
    fi
  done <<<"${2:-}"
}

# True when a multi-line input has at least one non-blank line.
has_lines() {
  case "${1:-}" in *[![:space:]]*) return 0 ;; *) return 1 ;; esac
}

# Forks and repositories that have not set the action up yet have no ingest
# key, and often no endpoint or assistant either. Skip with a notice instead of
# failing their workflow.
missing=()
if [ -z "${INPUT_ENDPOINT:-}" ]; then missing+=("endpoint"); fi
if [ -z "${INPUT_ASSISTANT:-}" ]; then missing+=("assistant"); fi
if [ -z "${SOLV_INGEST_KEY:-}" ]; then missing+=("SOLV_INGEST_KEY"); fi
if [ "${#missing[@]}" -gt 0 ]; then
  joined="$(printf '%s, ' "${missing[@]}")"
  echo "::notice title=solv.chat sync skipped::Not set: ${joined%, }. Nothing was pushed."
  exit 0
fi

content="${INPUT_CONTENT:-}"
push=false
if [ -n "$content" ] || has_lines "${INPUT_FILES:-}"; then push=true; fi

if [ "$push" = false ] && [ -z "${INPUT_CONFIG:-}" ] && [ "${INPUT_TEST:-}" != "true" ]; then
  echo "Provide at least one of 'content', 'files', 'config', or 'test: true'." >&2
  exit 1
fi
if [ -n "$content" ] && [ -z "${INPUT_BASE_URL:-}" ]; then
  echo "'base-url' is required when 'content' is set." >&2
  exit 1
fi
if [ -z "$content" ] && { has_lines "${INPUT_INCLUDE:-}" || has_lines "${INPUT_EXCLUDE:-}"; }; then
  echo "'include' and 'exclude' choose files in 'content'; set 'content' too." >&2
  exit 1
fi

action_repo="$(cd "$ACTION_PATH/../../.." && pwd)"
if [ ! -d "$action_repo/node_modules" ] || [ ! -f "$action_repo/packages/cli/dist/index.js" ]; then
  npm ci --prefix "$action_repo" --no-audit --no-fund
  npm run build --prefix "$action_repo" -w @solvchat/cli
fi
solv="$action_repo/packages/cli/bin/solv.js"

if [ "$push" = true ]; then
  args=(--endpoint "$INPUT_ENDPOINT" --assistant "$INPUT_ASSISTANT")
  if [ -n "${INPUT_BASE_URL:-}" ]; then args+=(--base-url "$INPUT_BASE_URL"); fi
  if [ -n "${INPUT_SOURCE:-}" ]; then args+=(--source "$INPUT_SOURCE"); fi
  add_lines --include "${INPUT_INCLUDE:-}"
  add_lines --exclude "${INPUT_EXCLUDE:-}"
  add_lines --file "${INPUT_FILES:-}"
  if [ "${INPUT_PRUNE:-}" = "true" ]; then args+=(--prune); fi
  # The folder goes last so that a folder name starting with "-" is still read
  # as the folder: parseArgs takes every non-option after the options.
  if [ -n "$content" ]; then args+=(-- "$content"); fi
  node "$solv" push "${args[@]}"
fi
if [ -n "${INPUT_CONFIG:-}" ]; then
  node "$solv" apply "$INPUT_CONFIG" --endpoint "$INPUT_ENDPOINT" --assistant "$INPUT_ASSISTANT"
fi
# After apply, so the tests that run are the ones the file declares.
if [ "${INPUT_TEST:-}" = "true" ]; then
  node "$solv" test --endpoint "$INPUT_ENDPOINT" --assistant "$INPUT_ASSISTANT"
fi
