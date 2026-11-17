import axe from "axe-core";
import { expect } from "vitest";

/**
 * Fails the test on any serious or critical axe-core violation inside `root`.
 *
 * Colour contrast is left to the Chromium layout test: happy-dom computes no
 * layout or cascaded colours, so axe cannot measure contrast here. The page's
 * `<title>` and `<html lang>` belong to the host page (`index.html` sets both),
 * not to the components under test.
 */
export async function expectNoSeriousA11yViolations(
  root: Element | Document = document,
): Promise<void> {
  const results = await axe.run(root as Element, {
    resultTypes: ["violations"],
    rules: {
      "color-contrast": { enabled: false },
      "document-title": { enabled: false },
      "html-has-lang": { enabled: false },
    },
  });
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  const report = serious.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n${v.nodes
        .map((n) => `  ${n.target.join(" ")} — ${n.failureSummary ?? ""}`)
        .join("\n")}`,
  );
  expect(report).toEqual([]);
}
