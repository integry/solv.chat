import { apply } from "./apply.js";
import { APPLY_HELP, PUSH_HELP, parseCliArgs, ROOT_HELP } from "./args.js";
import { CliError } from "./http.js";
import { push } from "./push.js";

export { type ApplyOptions, apply, diffConfig } from "./apply.js";
export { APPLY_HELP, type ParsedCommand, PUSH_HELP, parseCliArgs, ROOT_HELP } from "./args.js";
export { CliError, formatApiError, normalizeEndpoint, requestJson } from "./http.js";
export { externalIdFor, firstHeading, markdownFiles, splitFrontMatter } from "./markdown.js";
export { BATCH_SIZE, type CliDeps, type PushDocument, type PushOptions, push } from "./push.js";

export interface RunCliDeps {
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  env?: Record<string, string | undefined>;
}

/**
 * Executes the `solv` CLI with the given arguments and injectable I/O,
 * returning the process exit code.
 */
export async function runCli(argv: string[], deps: RunCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;

  try {
    const command = parseCliArgs(argv, env);
    if (command.kind === "help") {
      if (command.topic === "push") log(PUSH_HELP);
      else if (command.topic === "apply") log(APPLY_HELP);
      else log(ROOT_HELP);
      return 0;
    }

    if (command.kind === "push") {
      await push(command.options, { fetchImpl, log });
      return 0;
    }

    await apply(command.options, { fetchImpl, log });
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      errorLog(err.message);
      return err.exitCode;
    }
    errorLog(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
