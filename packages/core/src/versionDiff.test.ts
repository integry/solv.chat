import { describe, expect, it } from "vitest";
import {
  type ConfigChange,
  type DiffField,
  defaultVersionConfig,
  diffVersionConfigs,
  diffWords,
  groupChanges,
  summarizeChanges,
  VERSION_DIFF_FIELDS,
  type VersionConfig,
} from "./index.js";

/** Every leaf path of a config; arrays are one setting, not one per item. */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      leafPaths(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

function config(edit: (c: VersionConfig) => void): VersionConfig {
  const c = defaultVersionConfig();
  edit(c);
  return c;
}

function only(changes: ConfigChange[]): ConfigChange {
  expect(changes).toHaveLength(1);
  return changes[0] as ConfigChange;
}

describe("version diff field table", () => {
  it("has exactly one entry for every setting a version stores", () => {
    const schemaPaths = leafPaths(defaultVersionConfig()).sort();
    const tablePaths = VERSION_DIFF_FIELDS.map((f) => f.path).sort();
    expect(tablePaths).toEqual(schemaPaths);
  });

  it("fails the walk when a setting has no entry", () => {
    // What a new, unlisted setting looks like to the test above.
    const withNew = {
      ...defaultVersionConfig(),
      widget: { ...defaultVersionConfig().widget, x: 1 },
    };
    expect(leafPaths(withNew)).toContain("widget.x");
    expect(VERSION_DIFF_FIELDS.map((f) => f.path)).not.toContain("widget.x");
  });

  it("notices a change to every listed setting", () => {
    const changed = config((c) => {
      c.behaviour.greeting = "Hi there";
      c.behaviour.persona = "Warm and brief.";
      c.behaviour.fallbackText = "Sorry, no idea.";
      c.behaviour.suggestedQuestions = ["Price?"];
      c.behaviour.showSources = false;
      c.widget.title = "Help";
      c.widget.accentColor = "#ff0000";
      c.widget.position = "left";
      c.actions.builtins = true;
      c.actions.allowedOrigins = ["https://shop.example.com"];
      c.allowedTools = ["search"];
      c.limits.dailyCostCapMicros = 5_000_000;
    });
    const changes = diffVersionConfigs(defaultVersionConfig(), changed);
    expect(changes.map((c) => c.path)).toEqual(VERSION_DIFF_FIELDS.map((f) => f.path));
  });

  it("uses plain, sentence-case labels", () => {
    for (const field of VERSION_DIFF_FIELDS) {
      expect(field.label).toMatch(/^[A-Z][a-z ]+$/);
    }
  });
});

describe("diffVersionConfigs", () => {
  it("returns nothing for equal configs", () => {
    expect(diffVersionConfigs(defaultVersionConfig(), defaultVersionConfig())).toEqual([]);
    expect(summarizeChanges([])).toBe("No changes");
    expect(groupChanges([])).toEqual([]);
  });

  it("shows short text old and new", () => {
    const change = only(
      diffVersionConfigs(
        defaultVersionConfig(),
        config((c) => {
          c.widget.title = "Help desk";
        }),
      ),
    );
    expect(change).toEqual({
      path: "widget.title",
      label: "Title",
      screen: "Widget",
      kind: "text",
      before: "Ask a question",
      after: "Help desk",
    });
  });

  it("words coded values the way the screen does", () => {
    const changes = diffVersionConfigs(
      defaultVersionConfig(),
      config((c) => {
        c.widget.position = "left";
        c.limits.dailyCostCapMicros = 0;
      }),
    );
    expect(changes.map((c) => ("before" in c ? [c.before, c.after] : null))).toEqual([
      ["Bottom right", "Bottom left"],
      ["$2.00 a day", "No cap"],
    ]);
  });

  it("shows colours as their hex value", () => {
    const change = only(
      diffVersionConfigs(
        defaultVersionConfig(),
        config((c) => {
          c.widget.accentColor = "#112233";
        }),
      ),
    );
    expect(change).toMatchObject({ kind: "colour", before: "#2563eb", after: "#112233" });
  });

  it("shows booleans as On and Off", () => {
    const change = only(
      diffVersionConfigs(
        defaultVersionConfig(),
        config((c) => {
          c.actions.builtins = true;
        }),
      ),
    );
    expect(change).toMatchObject({ kind: "boolean", before: "Off", after: "On" });
  });

  it("names Show sources in answers on Behaviour when it is turned off", () => {
    const change = only(
      diffVersionConfigs(
        defaultVersionConfig(),
        config((c) => {
          c.behaviour.showSources = false;
        }),
      ),
    );
    expect(change).toMatchObject({
      path: "behaviour.showSources",
      label: "Show sources in answers",
      screen: "Behaviour",
      kind: "boolean",
      before: "On",
      after: "Off",
    });
    expect(summarizeChanges([change])).toBe("1 change: show sources in answers");
  });

  it("lists items added and removed, origins in full", () => {
    const before = config((c) => {
      c.actions.allowedOrigins = ["https://a.example.com", "https://b.example.com"];
    });
    const after = config((c) => {
      c.actions.allowedOrigins = ["https://b.example.com", "https://c.example.com:8443"];
    });
    const change = only(diffVersionConfigs(before, after));
    expect(change).toMatchObject({
      kind: "list",
      added: ["https://c.example.com:8443"],
      removed: ["https://a.example.com"],
      reordered: false,
    });
  });

  it("notices a list whose only change is the order", () => {
    const before = config((c) => {
      c.behaviour.suggestedQuestions = ["One?", "Two?"];
    });
    const after = config((c) => {
      c.behaviour.suggestedQuestions = ["Two?", "One?"];
    });
    expect(only(diffVersionConfigs(before, after))).toMatchObject({
      kind: "list",
      added: [],
      removed: [],
      reordered: true,
    });
  });

  it("notices kept items changing order alongside an addition", () => {
    const before = config((c) => {
      c.behaviour.suggestedQuestions = ["One?", "Two?"];
    });
    const after = config((c) => {
      c.behaviour.suggestedQuestions = ["Two?", "One?", "Three?"];
    });
    expect(only(diffVersionConfigs(before, after))).toMatchObject({
      kind: "list",
      before: ["One?", "Two?"],
      after: ["Two?", "One?", "Three?"],
      added: ["Three?"],
      removed: [],
      reordered: true,
    });
  });

  it("does not call a list reordered when only additions or removals moved items", () => {
    const before = config((c) => {
      c.behaviour.suggestedQuestions = ["One?", "Two?", "Three?"];
    });
    const after = config((c) => {
      c.behaviour.suggestedQuestions = ["Zero?", "One?", "Three?"];
    });
    expect(only(diffVersionConfigs(before, after))).toMatchObject({
      added: ["Zero?"],
      removed: ["Two?"],
      reordered: false,
    });
  });

  it("gives long text a word-level diff", () => {
    const before = config((c) => {
      c.behaviour.persona = "Friendly and concise.";
    });
    const after = config((c) => {
      c.behaviour.persona = "Friendly, warm and concise.";
    });
    const change = only(diffVersionConfigs(before, after));
    expect(change.kind).toBe("longText");
    if (change.kind !== "longText") return;
    expect(change.words).toEqual([
      { type: "removed", text: "Friendly" },
      { type: "added", text: "Friendly, warm" },
      { type: "same", text: " and concise." },
    ]);
  });

  it("never puts a secret's value in the diff", () => {
    const fields: DiffField[] = [
      { path: "tool.credential", label: "Credential", screen: "Tools", kind: "secret" },
    ];
    const before = { tool: { credential: "sk-old-value-1234" } } as unknown as VersionConfig;
    const after = { tool: { credential: "sk-new-value-5678" } } as unknown as VersionConfig;
    const changes = diffVersionConfigs(before, after, fields);
    expect(changes).toEqual([
      {
        path: "tool.credential",
        label: "Credential",
        screen: "Tools",
        kind: "secret",
        summary: "Credential replaced",
      },
    ]);
    const text = JSON.stringify(changes);
    expect(text).not.toContain("sk-old");
    expect(text).not.toContain("sk-new");

    const none = { tool: {} } as unknown as VersionConfig;
    expect(diffVersionConfigs(none, after, fields)[0]).toMatchObject({
      summary: "Credential added",
    });
    expect(diffVersionConfigs(before, none, fields)[0]).toMatchObject({
      summary: "Credential removed",
    });
    expect(diffVersionConfigs(before, before, fields)).toEqual([]);
  });

  it("groups by screen in a fixed order and summarises in one line", () => {
    const changes = diffVersionConfigs(
      defaultVersionConfig(),
      config((c) => {
        c.widget.accentColor = "#000000";
        c.behaviour.greeting = "Hi";
        c.behaviour.persona = "Calm.";
        c.allowedTools = ["search"];
      }),
    );
    expect(groupChanges(changes).map((g) => [g.screen, g.changes.length])).toEqual([
      ["Behaviour", 2],
      ["Widget", 1],
      ["Tools", 1],
    ]);
    expect(summarizeChanges(changes.slice(0, 3))).toBe("3 changes: greeting, tone, accent colour");
    expect(summarizeChanges(changes.slice(0, 1))).toBe("1 change: greeting");
  });
});

describe("diffWords", () => {
  function rebuild(parts: ReturnType<typeof diffWords>, keep: "removed" | "added"): string {
    return parts
      .filter((p) => p.type === "same" || p.type === keep)
      .map((p) => p.text)
      .join("");
  }

  it("keeps both texts recoverable", () => {
    const a = "The quick brown fox jumps over the lazy dog.";
    const b = "The quick red fox leaps over the dog, quietly.";
    const parts = diffWords(a, b);
    expect(rebuild(parts, "removed")).toBe(a);
    expect(rebuild(parts, "added")).toBe(b);
    expect(parts.filter((p) => p.type === "removed").map((p) => p.text.trim())).toContain("brown");
    expect(parts.filter((p) => p.type === "added").map((p) => p.text.trim())).toContain("red");
  });

  it("handles empty sides", () => {
    expect(diffWords("", "New text")).toEqual([{ type: "added", text: "New text" }]);
    expect(diffWords("Old text", "")).toEqual([{ type: "removed", text: "Old text" }]);
    expect(diffWords("", "")).toEqual([]);
  });

  it("stays whole-text for inputs too large to compare word by word", () => {
    const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join(" ");
    const b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join(" ");
    const parts = diffWords(a, b);
    expect(parts).toEqual([
      { type: "removed", text: a },
      { type: "added", text: b },
    ]);
  });
});
