import {
  type ConfigChange,
  type DiffField,
  defaultVersionConfig,
  diffVersionConfigs,
  type VersionConfig,
} from "@solvchat/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VersionRow } from "../src/api/types.js";
import { History, previousVersions } from "../src/screens/History.js";
import { PublishConfirmDialog } from "../src/shell/PublishConfirm.js";
import { DiffList } from "../src/ui/DiffList.js";
import { expectNoSeriousA11yViolations } from "./support/axe.js";

function config(edit: (c: VersionConfig) => void = () => {}): VersionConfig {
  const c = defaultVersionConfig();
  edit(c);
  return c;
}

function row(
  id: string,
  state: VersionRow["state"],
  cfg: VersionConfig,
  publishedAt: number | null,
  createdAt = 1_700_000_000_000,
): VersionRow {
  return {
    id,
    orgId: "org_00000000000000000000",
    assistantId: "ast_1",
    state,
    config: cfg,
    createdAt,
    publishedAt,
  };
}

/**
 * Answers the versions list, the draft and rollback for one assistant. The
 * draft defaults to the one in the list; pass `draft` to serve one the
 * (bounded) list does not contain.
 */
function stubVersions(
  versions: VersionRow[],
  draft: VersionRow | null = versions.find((v) => v.state === "draft") ?? null,
) {
  const calls: Array<{ method: string; path: string }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "https://example.com").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path });
    if (path === "/api/admin/assistants/ast_1/versions" && method === "GET") {
      return Response.json({ versions });
    }
    if (path === "/api/admin/assistants/ast_1/draft" && method === "GET") {
      return draft
        ? Response.json({ draft })
        : Response.json({ error: "Not found." }, { status: 404 });
    }
    const rollback = /\/versions\/([^/]+)\/rollback$/.exec(path);
    if (rollback && method === "POST") {
      const target = versions.find((v) => v.id === rollback[1]);
      return Response.json({ version: { ...target, state: "published" } });
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIVE = config();
const EDITED = config((c) => {
  c.behaviour.greeting = "Hi! Ask me about pricing.";
  c.behaviour.persona = "Friendly and concise.";
  c.widget.accentColor = "#112233";
  c.actions.builtins = true;
  c.actions.allowedOrigins = ["https://shop.example.com"];
  c.allowedTools = ["search_orders"];
});

describe("DiffList", () => {
  it("shows each kind of change with was and now in words, grouped by screen", async () => {
    const changes = diffVersionConfigs(
      config((c) => {
        c.behaviour.persona = "Friendly and concise.";
        c.allowedTools = ["old_tool"];
      }),
      config((c) => {
        c.behaviour.persona = "Friendly, warm and concise.";
        c.behaviour.greeting = "Hi!";
        c.widget.accentColor = "#112233";
        c.widget.position = "left";
        c.actions.builtins = true;
        c.allowedTools = ["new_tool"];
      }),
    );
    render(<DiffList changes={changes} />);

    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Behaviour",
      "Widget",
      "Tools",
    ]);

    const greeting = screen.getByText("Greeting").closest("li") as HTMLElement;
    expect(greeting.textContent).toBe("GreetingWasHello. Ask me anything about this site.NowHi!");

    const accent = screen.getByText("Accent colour").closest("li") as HTMLElement;
    expect(accent.textContent).toContain("Was#2563eb");
    expect(accent.textContent).toContain("Now#112233");

    const position = screen.getByText("Position").closest("li") as HTMLElement;
    expect(position.textContent).toContain("WasBottom right");
    expect(position.textContent).toContain("NowBottom left");

    const help = screen.getByText("Help on the page").closest("li") as HTMLElement;
    expect(help.textContent).toContain("WasOff");
    expect(help.textContent).toContain("NowOn");

    const tools = screen.getByText("Tools visitors can use").closest("li") as HTMLElement;
    expect(
      within(tools)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Added: new_tool", "Removed: old_tool"]);

    // Long text: struck-through and underlined words with hidden words for
    // screen readers, not colour alone.
    const tone = screen.getByText("Tone").closest("li") as HTMLElement;
    const removed = tone.querySelector("del") as HTMLElement;
    const added = tone.querySelector("ins") as HTMLElement;
    expect(removed.textContent).toBe("[removed: Friendly]");
    expect(added.textContent).toBe("[added: Friendly, warm]");
    expect(removed.querySelector(".sr-only")).toBeTruthy();

    await expectNoSeriousA11yViolations();
  });

  it("says when only the order of a list changed", () => {
    const changes = diffVersionConfigs(
      config((c) => {
        c.behaviour.suggestedQuestions = ["One?", "Two?"];
      }),
      config((c) => {
        c.behaviour.suggestedQuestions = ["Two?", "One?"];
      }),
    );
    render(<DiffList changes={changes} />);
    const item = screen.getByText("Suggested questions").closest("li") as HTMLElement;
    expect(item.textContent).toContain("Same items, new order.");
    expect(item.textContent).toContain("WasOne?, Two?");
    expect(item.textContent).toContain("NowTwo?, One?");
  });

  it("shows the new order when kept items move and an item is added", () => {
    const changes = diffVersionConfigs(
      config((c) => {
        c.behaviour.suggestedQuestions = ["One?", "Two?"];
      }),
      config((c) => {
        c.behaviour.suggestedQuestions = ["Two?", "One?", "Three?"];
      }),
    );
    render(<DiffList changes={changes} />);
    const item = screen.getByText("Suggested questions").closest("li") as HTMLElement;
    expect(item.textContent).toContain("Added: Three?");
    expect(item.textContent).toContain("The order changed too.");
    expect(item.textContent).toContain("WasOne?, Two?");
    expect(item.textContent).toContain("NowTwo?, One?, Three?");
  });

  it("shows a replaced credential without its value", () => {
    const fields: DiffField[] = [
      { path: "tool.credential", label: "Order lookup key", screen: "Tools", kind: "secret" },
    ];
    const changes: ConfigChange[] = diffVersionConfigs(
      { tool: { credential: "secret-before-111" } } as unknown as VersionConfig,
      { tool: { credential: "secret-after-222" } } as unknown as VersionConfig,
      fields,
    );
    const { container } = render(<DiffList changes={changes} />);
    expect(screen.getByText("Credential replaced")).toBeTruthy();
    expect(container.textContent).not.toContain("secret-before");
    expect(container.textContent).not.toContain("secret-after");
  });

  it("says when there is nothing to show", () => {
    render(<DiffList changes={[]} emptyText="Nothing has changed." />);
    expect(screen.getByText("Nothing has changed.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("Publish confirmation", () => {
  it("lists what will change and publishes on confirm", async () => {
    stubVersions([
      row("ver_draft", "draft", EDITED, null, 1_700_000_200_000),
      row("ver_pub", "published", LIVE, 1_700_000_100_000),
    ]);
    const onConfirm = vi.fn();
    render(
      <PublishConfirmDialog assistantId="ast_1" open onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const dialog = screen.getByRole("dialog", { name: "Publish your draft?" });
    const region = within(dialog).getByRole("region", { name: "What will change" });
    await within(region).findByText("Greeting");
    expect(
      within(region)
        .getAllByRole("heading", { level: 4 })
        .map((h) => h.textContent),
    ).toEqual(["Behaviour", "Widget", "Tools"]);
    expect(within(region).getByText("Other sites it may send visitors to")).toBeTruthy();
    expect(region.textContent).toContain("Added: https://shop.example.com");
    // Focus starts on Cancel, so Enter never publishes by accident.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await expectNoSeriousA11yViolations();

    fireEvent.click(within(dialog).getByRole("button", { name: "Publish now" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables Publish when nothing has changed", async () => {
    stubVersions([
      row("ver_draft", "draft", LIVE, null, 1_700_000_200_000),
      row("ver_pub", "published", LIVE, 1_700_000_100_000),
    ]);
    const onConfirm = vi.fn();
    render(
      <PublishConfirmDialog assistantId="ast_1" open onConfirm={onConfirm} onCancel={() => {}} />,
    );
    expect(await screen.findByText("Nothing has changed.")).toBeTruthy();
    const publish = screen.getByRole("button", { name: "Publish now" }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    fireEvent.click(publish);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("finds the draft even when History no longer lists it", async () => {
    // 100 newer restores push the draft out of the bounded versions list.
    const restores = Array.from({ length: 100 }, (_, i) =>
      row(
        `ver_r${i}`,
        i === 0 ? "published" : "archived",
        LIVE,
        1_700_000_900_000 - i,
        1_700_000_900_000 - i,
      ),
    );
    const { calls } = stubVersions(restores, row("ver_draft", "draft", EDITED, null));
    const onConfirm = vi.fn();
    render(
      <PublishConfirmDialog assistantId="ast_1" open onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const region = screen.getByRole("region", { name: "What will change" });
    await within(region).findByText("Greeting");
    expect(screen.queryByText("There is no draft to publish.")).toBeNull();
    expect(calls).toContainEqual({ method: "GET", path: "/api/admin/assistants/ast_1/draft" });
    const publish = screen.getByRole("button", { name: "Publish now" }) as HTMLButtonElement;
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("allows the first publish with nothing to compare", async () => {
    stubVersions([row("ver_draft", "draft", EDITED, null)]);
    render(
      <PublishConfirmDialog assistantId="ast_1" open onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(
      await screen.findByText("Nothing is live yet. This will be the first version visitors get."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Publish now" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});

describe("History", () => {
  const v1 = config();
  const v2 = config((c) => {
    c.behaviour.greeting = "Second greeting";
    c.behaviour.persona = "Calm.";
    c.widget.accentColor = "#000000";
  });
  const draftCfg = config((c) => {
    c.behaviour.greeting = "Second greeting";
    c.behaviour.persona = "Calm.";
    c.widget.accentColor = "#000000";
    c.widget.title = "Help";
  });
  const versions = [
    row("ver_draft", "draft", draftCfg, null, 1_700_000_300_000),
    row("ver_2", "published", v2, 1_700_000_200_000, 1_700_000_150_000),
    row("ver_1", "archived", v1, 1_700_000_100_000),
  ];

  it("summarises each row in one line and expands to the diff against the one before", async () => {
    stubVersions(versions);
    render(<History assistantId="ast_1" />);
    const items = await screen.findAllByRole("listitem");
    const rows = items.filter((li) => li.classList.contains("history-item"));
    expect(rows.map((li) => li.querySelector(".history-summary")?.textContent)).toEqual([
      "1 change: title",
      "3 changes: greeting, tone, accent colour",
      "First version",
    ]);

    const published = rows[1] as HTMLElement;
    const toggle = within(published).getByRole("button", { name: "Show changes" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(published).getByText("Greeting").closest("li")?.textContent).toBe(
      "GreetingWasHello. Ask me anything about this site.NowSecond greeting",
    );
    expect(
      within(rows[2] as HTMLElement).queryByRole("button", { name: "Show changes" }),
    ).toBeNull();
    await expectNoSeriousA11yViolations();
  });

  it("shows the diff from the live version before restoring, then restores", async () => {
    const { calls } = stubVersions(versions);
    const onRestored = vi.fn();
    render(<History assistantId="ast_1" onRestored={onRestored} />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    const dialog = screen.getByRole("dialog", { name: "Restore this version?" });
    const region = within(dialog).getByRole("region", { name: "What will change" });
    // Going from the live version (v2) back to v1.
    expect(within(region).getByText("Greeting").closest("li")?.textContent).toBe(
      "GreetingWasSecond greetingNowHello. Ask me anything about this site.",
    );
    expect(within(region).getByText("Accent colour").closest("li")?.textContent).toContain(
      "Was#000000",
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await expectNoSeriousA11yViolations();

    fireEvent.click(within(dialog).getByRole("button", { name: "Restore version" }));
    expect(await screen.findByText("Restored earlier version.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/ver_1/rollback"))).toBe(true);
    expect(onRestored).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancelling the restore sends nothing", async () => {
    const { calls } = stubVersions(versions);
    render(<History assistantId="ast_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("compares each published version with the one published before it", () => {
    // A rollback is newest by publish time although an older draft row exists.
    const rollback = row("ver_3", "published", v1, 1_700_000_400_000, 1_700_000_400_000);
    const list = [
      rollback,
      row("ver_draft", "draft", draftCfg, null, 1_700_000_300_000),
      { ...versions[1], state: "archived" } as VersionRow,
      versions[2] as VersionRow,
    ];
    const previous = previousVersions(list);
    expect(previous.get("ver_3")?.id).toBe("ver_2");
    expect(previous.get("ver_draft")?.id).toBe("ver_3");
    expect(previous.get("ver_2")?.id).toBe("ver_1");
    expect(previous.get("ver_1")).toBeNull();
  });
});
