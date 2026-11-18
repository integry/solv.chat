import { parseArgs } from "node:util";
import type { ApplyOptions } from "./apply.js";
import { CliError } from "./http.js";
import type { PushOptions } from "./push.js";
import type { TestOptions } from "./test.js";

export type ParsedCommand =
  | { kind: "help"; topic: "root" | "push" | "apply" | "test" }
  | { kind: "push"; options: PushOptions }
  | { kind: "apply"; options: ApplyOptions }
  | { kind: "test"; options: TestOptions };

export const ROOT_HELP = `Usage: solv <command> [options]

Commands:
  push   Push a folder of Markdown files or a JSON batch to an assistant
  apply  Apply solv.config.json to an assistant's draft configuration
  test   Run the assistant's answer tests and fail if any do not pass

Environment variables:
  SOLV_INGEST_KEY   Bearer key for solv push, solv apply, and solv test

Run 'solv <command> --help' for command-specific options.`;

export const PUSH_HELP = `Usage: solv push [dir] [options]

Options:
  --endpoint <url>    Worker base URL (required)
  --assistant <id>    Assistant ID, e.g. ast_... (required)
  --base-url <url>    Site URL that document paths are joined to
  --json <file>       Push a prepared JSON batch instead of a Markdown folder
  --source-id <id>    Target pushed-content source ID (optional)
  --prune             Delete documents not in the pushed set
  --dry-run           Print what would be pushed without sending requests
  -h, --help          Show this help message

Environment variables:
  SOLV_INGEST_KEY     Bearer key used to authenticate ingest requests`;

export const APPLY_HELP = `Usage: solv apply [file] [options]

Arguments:
  file                Config file path (default: solv.config.json)

Options:
  --endpoint <url>    Worker base URL (required)
  --assistant <id>    Assistant ID, e.g. ast_... (required)
  -h, --help          Show this help message

A "tests" array replaces the assistant's tests. An "mcpServers" array of
{ "url", "sendConversationContext" } sets that switch on tool servers already
added in the admin. The ingest key can turn it off but not on; turn it on in
the admin. Nothing is changed if any part of the file would be refused.

Environment variables:
  SOLV_INGEST_KEY     Bearer key used to authenticate ingest requests`;

export const TEST_HELP = `Usage: solv test [file] [options]

Arguments:
  file                Config file whose "tests" replace the assistant's tests
                      (optional; without it, the stored tests are run)

Options:
  --endpoint <url>    Worker base URL (required)
  --assistant <id>    Assistant ID, e.g. ast_... (required)
  --dry-run           Print what would run without sending anything
  -h, --help          Show this help message

Environment variables:
  SOLV_INGEST_KEY     Bearer key used to authenticate ingest requests

Exits non-zero if any test fails or does not run. A "tests" array in the file
replaces the assistant's tests, including any added in the admin. At most 25
tests may be declared and run per assistant.`;

function readString(
  values: Record<string, string | boolean | (string | boolean)[] | undefined>,
  name: string,
): string | undefined {
  const val = values[name];
  return typeof val === "string" ? val : undefined;
}

function readBoolean(
  values: Record<string, string | boolean | (string | boolean)[] | undefined>,
  name: string,
): boolean {
  return values[name] === true;
}

function requireOption(value: string | undefined, flag: string): string {
  if (!value || value.trim().length === 0) {
    throw new CliError(`Missing required option ${flag}`);
  }
  return value.trim();
}

function rejectExtraPositionals(positionals: string[]): void {
  if (positionals.length > 1) {
    throw new CliError(`Unexpected positional argument: ${positionals[1]}`);
  }
}

function parsePushArgs(args: string[], env: Record<string, string | undefined>): ParsedCommand {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        endpoint: { type: "string" },
        assistant: { type: "string" },
        "base-url": { type: "string" },
        json: { type: "string" },
        "source-id": { type: "string" },
        prune: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  if (readBoolean(parsed.values, "help")) {
    return { kind: "help", topic: "push" };
  }

  rejectExtraPositionals(parsed.positionals);

  const endpoint = requireOption(readString(parsed.values, "endpoint"), "--endpoint");
  const assistant = requireOption(readString(parsed.values, "assistant"), "--assistant");
  const json = readString(parsed.values, "json");
  const baseUrl = readString(parsed.values, "base-url");
  const sourceId = readString(parsed.values, "source-id");
  const dir = parsed.positionals[0];

  if (json !== undefined && dir !== undefined) {
    throw new CliError("Specify either a content directory or --json, not both");
  }
  if (json === undefined && dir === undefined) {
    throw new CliError("Provide a content directory or --json <file>");
  }

  const options: PushOptions = {
    endpoint,
    assistant,
    prune: readBoolean(parsed.values, "prune"),
    dryRun: readBoolean(parsed.values, "dry-run"),
  };
  if (dir !== undefined) options.dir = dir;
  if (json !== undefined) options.json = json;
  if (baseUrl !== undefined) options.baseUrl = baseUrl;
  if (sourceId !== undefined) options.sourceId = sourceId;
  if (env.SOLV_INGEST_KEY !== undefined) options.ingestKey = env.SOLV_INGEST_KEY;

  return { kind: "push", options };
}

function parseApplyArgs(args: string[], env: Record<string, string | undefined>): ParsedCommand {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        endpoint: { type: "string" },
        assistant: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  if (readBoolean(parsed.values, "help")) {
    return { kind: "help", topic: "apply" };
  }

  rejectExtraPositionals(parsed.positionals);

  const endpoint = requireOption(readString(parsed.values, "endpoint"), "--endpoint");
  const assistant = requireOption(readString(parsed.values, "assistant"), "--assistant");
  const file = parsed.positionals[0] ?? "solv.config.json";

  const options: ApplyOptions = {
    file,
    endpoint,
    assistant,
  };
  if (env.SOLV_INGEST_KEY !== undefined) options.ingestKey = env.SOLV_INGEST_KEY;

  return { kind: "apply", options };
}

function parseTestArgs(args: string[], env: Record<string, string | undefined>): ParsedCommand {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        endpoint: { type: "string" },
        assistant: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  if (readBoolean(parsed.values, "help")) {
    return { kind: "help", topic: "test" };
  }

  rejectExtraPositionals(parsed.positionals);

  const endpoint = requireOption(readString(parsed.values, "endpoint"), "--endpoint");
  const assistant = requireOption(readString(parsed.values, "assistant"), "--assistant");
  const file = parsed.positionals[0];

  const options: TestOptions = {
    endpoint,
    assistant,
    dryRun: readBoolean(parsed.values, "dry-run"),
  };
  if (file !== undefined) options.file = file;
  if (env.SOLV_INGEST_KEY !== undefined) options.ingestKey = env.SOLV_INGEST_KEY;

  return { kind: "test", options };
}

/**
 * Parses CLI arguments using `node:util` `parseArgs` and reads credentials from
 * environment variables without exposing them as flags.
 */
export function parseCliArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): ParsedCommand {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    return { kind: "help", topic: "root" };
  }
  if (command === "push") {
    return parsePushArgs(rest, env);
  }
  if (command === "apply") {
    return parseApplyArgs(rest, env);
  }
  if (command === "test") {
    return parseTestArgs(rest, env);
  }
  throw new CliError(`Unknown command: ${command}. Run 'solv --help' for usage.`);
}
