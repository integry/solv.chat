import { defaultVersionConfig, type VersionConfig } from "@solvchat/core";

/**
 * The default version config with "Show sources in answers" set to Numbered,
 * with a list: `[n]` markers, citation events and the numbered safety frame.
 * The suites that test those use it, because the default is now links in the
 * text (`test/chat/showSources.test.ts` covers that one).
 */
export function numberedConfig(): VersionConfig {
  const config = defaultVersionConfig();
  config.behaviour.sources = "numbered";
  return config;
}
