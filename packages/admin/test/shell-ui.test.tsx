import { defaultVersionConfig } from "@solvchat/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Assistant, VersionRow } from "../src/api/types.js";
import { App, type HeaderSlotProps, type MountAdminOptions } from "../src/index.js";
import { expectNoSeriousA11yViolations } from "./support/axe.js";
import {
  assistantButton,
  findAssistantButton,
  openNewAssistantForm,
  selectedAssistantId,
} from "./support/switcher.js";

type Config = VersionRow["config"];

function makeAssistant(id: string, name: string): Assistant {
  return {
    id,
    orgId: "org_00000000000000000000",
    name,
    publicKey: `pk_${id}`,
    allowedOrigins: [],
    hasIngestKey: true,
    createdAt: 1_700_000_000_000,
  };
}

function configWith(greeting: string): Config {
  const config = defaultVersionConfig();
  config.behaviour = { ...config.behaviour, greeting };
  return config;
}

interface AssistantState {
  draft: Config;
  published: Config | null;
}

interface ServerOptions {
  /** Answers the first unforced publish with 409 and a failed test run. */
  failTests?: boolean;
  /** Publish answers only after this settles, so a test can act mid-publish. */
  holdPublish?: Promise<void>;
}

function installServer(
  entries: Array<{ assistant: Assistant; state: AssistantState }>,
  options: ServerOptions = {},
) {
  const assistants = entries.map((e) => e.assistant);
  const states = new Map(entries.map((e) => [e.assistant.id, e.state]));
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  // Publishing promotes the draft and inserts a fresh one, so the draft id changes.
  const draftGeneration = new Map<string, number>();
  const row = (id: string, state: VersionRow["state"], config: Config): VersionRow => ({
    id:
      state === "draft" ? `ver_draft_${id}_${draftGeneration.get(id) ?? 0}` : `ver_${state}_${id}`,
    orgId: "org_00000000000000000000",
    assistantId: id,
    state,
    config,
    createdAt: 1_700_000_000_000,
    publishedAt: state === "draft" ? null : 1_700_000_100_000,
  });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "https://example.com").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    if (path === "/api/admin/assistants" && method === "GET") {
      return Response.json({ assistants });
    }
    const single = assistants.find((a) => path === `/api/admin/assistants/${a.id}`);
    if (single && method === "GET") return Response.json({ assistant: single });
    const match = /^\/api\/admin\/assistants\/([^/]+)\/(versions|draft|publish)$/.exec(path);
    const state = match ? states.get(match[1] ?? "") : undefined;
    if (match && state) {
      const id = match[1] as string;
      if (match[2] === "versions") {
        const versions = [row(id, "draft", state.draft)];
        if (state.published) versions.push(row(id, "published", state.published));
        return Response.json({ versions });
      }
      if (match[2] === "draft" && method === "GET") {
        return Response.json({ draft: row(id, "draft", state.draft) });
      }
      if (match[2] === "draft" && method === "PUT") {
        state.draft = { ...state.draft, ...(body as Partial<Config>) };
        return Response.json({ draft: row(id, "draft", state.draft) });
      }
      if (match[2] === "publish" && method === "POST") {
        const force = (body as { force?: boolean } | undefined)?.force === true;
        if (options.failTests && !force) {
          return Response.json(
            {
              error: "Some tests did not pass.",
              run: {
                id: "run_1",
                results: [
                  {
                    testId: "tst_1",
                    question: "What is the refund policy?",
                    expectation: { kind: "contains", phrase: "30 days" },
                    outcome: "failed",
                    reason: "The answer did not mention 30 days.",
                    excerpt: "",
                  },
                ],
              },
            },
            { status: 409 },
          );
        }
        if (options.holdPublish) await options.holdPublish;
        state.published = state.draft;
        draftGeneration.set(id, (draftGeneration.get(id) ?? 0) + 1);
        return Response.json({ version: row(id, "published", state.published) });
      }
    }
    if (path === "/api/admin/chat" && method === "POST") {
      const message = (body as { message: string }).message;
      return new Response(
        `event: token\ndata: ${JSON.stringify({ text: `Draft reply to: ${message}` })}\n\n` +
          `event: done\ndata: ${JSON.stringify({ messageId: "m1", conversationId: "c1" })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    if (path.endsWith("/overview")) {
      return Response.json({ todayCostMicros: 0, topQuestions: [] });
    }
    if (path.endsWith("/sources")) return Response.json({ sources: [] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, states };
}

const LIVE: AssistantState = { draft: configWith("Hi"), published: configWith("Hi") };
const CHANGED: AssistantState = { draft: configWith("Hello there"), published: configWith("Hi") };
const NEVER: AssistantState = { draft: configWith("Hi"), published: null };

function oneAssistant(state: AssistantState) {
  return installServer([
    { assistant: makeAssistant("ast_1", "Docs Bot"), state: structuredClone(state) },
  ]);
}

function setNarrow(narrow: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: narrow && query.includes("max-width: 899px"),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

/** A matchMedia stub whose narrow flag can change mid-test, like a resize or rotation. */
function controllableNarrow(initial: boolean) {
  let narrow = initial;
  const listeners = new Set<() => void>();
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return narrow && query.includes("max-width: 899px");
        },
        media: query,
        onchange: null,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
  return (next: boolean) => {
    narrow = next;
    act(() => {
      for (const fn of [...listeners]) fn();
    });
  };
}

function go(path: string) {
  window.history.replaceState(null, "", path);
}

function header(): HTMLElement {
  return document.querySelector("header.shell-header") as HTMLElement;
}

beforeEach(() => {
  window.localStorage.clear();
  go("/admin/overview");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function Billing() {
  return <h1>Billing</h1>;
}

function OrgName(_: HeaderSlotProps) {
  return <span data-testid="org">Acme</span>;
}

function OrgSwitch(_: HeaderSlotProps) {
  return (
    <button type="button" data-testid="org-switch">
      Switch org
    </button>
  );
}

/** Presses Publish now in the "What will change" dialog once it has loaded. */
async function confirmPublish() {
  const dialog = await screen.findByRole("dialog", { name: "Publish your draft?" });
  const button = within(dialog).getByRole("button", { name: "Publish now" }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  await act(async () => {
    fireEvent.click(button);
  });
}

describe("grouped navigation", () => {
  it("groups built-in screens under headings with icons, then host sections", async () => {
    oneAssistant(LIVE);
    const icon = <svg data-testid="billing-icon" aria-hidden="true" viewBox="0 0 16 16" />;
    const options: MountAdminOptions = {
      extraNavItems: [
        { id: "billing", label: "Billing", path: "/admin/billing", section: "Account", icon },
        { id: "faq", label: "Help", path: "/admin/help", section: "Settings" },
      ],
      extraScreens: { billing: Billing, faq: Billing },
    };
    render(<App options={options} />);
    const nav = await screen.findByRole("navigation", { name: "Primary" });

    const groups = within(nav)
      .getAllByRole("heading", { level: 2 })
      .map((h) => {
        const list = within(nav).getByRole("list", { name: h.textContent ?? "" });
        return [
          h.textContent,
          within(list)
            .getAllByRole("link")
            .map((a) => a.textContent),
        ];
      });
    expect(groups).toEqual([
      ["Monitor", ["Overview", "Reports", "Conversations", "Gaps"]],
      ["Build", ["Sources", "Behaviour", "Tools", "Widget", "Tests"]],
      ["Go live", ["Install"]],
      ["Settings", ["Providers", "Help"]],
      ["Account", ["Billing"]],
    ]);

    // Built-in items carry decorative icons; a host item can bring its own.
    for (const link of within(nav).getAllByRole("link")) {
      if (link.textContent === "Help") continue;
      expect(link.querySelector(".nav-icon[aria-hidden='true'] svg")).toBeTruthy();
    }
    expect(within(nav).getByTestId("billing-icon")).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe(
      "page",
    );
    await findAssistantButton();
    await expectNoSeriousA11yViolations();
  });
});

describe("narrow screens", () => {
  it("collapses the header and opens the navigation in a focus-trapped drawer", async () => {
    setNarrow(true);
    oneAssistant(LIVE);
    render(<App options={{ headerStart: OrgName, headerEnd: OrgSwitch }} />);

    const menuButton = await screen.findByRole("button", { name: "Menu" });
    // Header: product name, host start slot, current screen, Try it, menu button.
    expect(header().firstElementChild?.textContent).toBe("solv.chat");
    expect(within(header()).getByTestId("org")).toBeTruthy();
    expect(header().querySelector(".shell-current")?.textContent).toBe("Overview");
    // Switcher, host end slot and Sign out wait in the closed drawer.
    const closedDrawer = document.getElementById("shell-drawer") as HTMLElement;
    expect(closedDrawer.hidden).toBe(true);
    expect(closedDrawer.querySelector(".switcher")).toBeTruthy();
    expect(within(closedDrawer).getByTestId("org-switch")).toBeTruthy();
    expect(within(header()).queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(menuButton.getAttribute("aria-expanded")).toBe("false");

    // Closed drawer is out of the accessibility tree.
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();

    menuButton.focus();
    fireEvent.click(menuButton);
    const drawer = screen.getByRole("dialog", { name: "Menu" });
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    expect(drawer.contains(document.activeElement)).toBe(true);

    // Switcher and publish status at the top, host end slot and Sign out at the bottom.
    await waitFor(() => expect(within(drawer).getByText("Live")).toBeTruthy());
    const top = drawer.querySelector(".drawer-top") as HTMLElement;
    expect(within(top).getByRole("button", { name: /^Assistant Docs Bot/ })).toBeTruthy();
    const bottom = drawer.querySelector(".drawer-bottom") as HTMLElement;
    expect(within(bottom).getByTestId("org-switch")).toBeTruthy();
    expect(within(bottom).getByRole("button", { name: "Sign out" })).toBeTruthy();
    await expectNoSeriousA11yViolations();

    // Tab wraps within the drawer.
    const signOut = within(bottom).getByRole("button", { name: "Sign out" });
    signOut.focus();
    fireEvent.keyDown(signOut, { key: "Tab" });
    expect(document.activeElement).toBe(within(drawer).getByRole("button", { name: "Close menu" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(signOut);

    // Escape closes and returns focus to the menu button.
    fireEvent.keyDown(signOut, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
    expect(document.activeElement).toBe(menuButton);

    // The backdrop closes it too.
    fireEvent.click(menuButton);
    fireEvent.click(document.querySelector(".shell-backdrop") as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();

    // Choosing a screen closes the drawer and names the new screen in the header.
    fireEvent.click(menuButton);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Menu" })).getByRole("link", { name: "Gaps" }),
    );
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
    expect(header().querySelector(".shell-current")?.textContent).toBe("Gaps");
    expect(window.location.pathname).toBe("/admin/gaps");
  });

  it("opens Try it as a sheet that Escape closes", async () => {
    setNarrow(true);
    oneAssistant(LIVE);
    go("/admin/behaviour");
    render(<App />);
    const toggle = await screen.findByRole("button", { name: "Try it" });
    // Narrow screens never open the sheet on their own.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const pane = screen.getByRole("complementary", { name: "Try it" });
    expect(pane.className).toContain("try-it-overlay");
    expect(document.activeElement).toBe(within(pane).getByLabelText("Ask a question"));
    fireEvent.keyDown(within(pane).getByLabelText("Ask a question"), { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Try it" })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });
});

describe("Try it toggle", () => {
  it("is closed on Monitor screens and open on Build screens by default", async () => {
    oneAssistant(LIVE);
    render(<App />);
    const toggle = await screen.findByRole("button", { name: "Try it" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("try-it-pane");
    expect(screen.queryByRole("complementary", { name: "Try it" })).toBeNull();

    const link = screen.getByRole("link", { name: "Behaviour" });
    link.focus();
    fireEvent.click(link);
    await screen.findByRole("heading", { name: "Behaviour", level: 1 });
    const pane = screen.getByRole("complementary", { name: "Try it" });
    // Opening because of navigation does not steal focus.
    expect(document.activeElement).toBe(link);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // It says plainly that it uses the draft.
    expect(within(pane).getByText("Draft")).toBeTruthy();
    expect(pane.textContent).toMatch(/Uses your saved draft\. Visitors still get the published/);
    await expectNoSeriousA11yViolations();
  });

  it("remembers the choice per browser and keeps the transcript when closed", async () => {
    oneAssistant(LIVE);
    go("/admin/behaviour");
    const { unmount } = render(<App />);
    const pane = await screen.findByRole("complementary", { name: "Try it" });
    const input = within(pane).getByLabelText("Ask a question");
    fireEvent.change(input, { target: { value: "How do I install?" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Send" }));
    await within(pane).findByText("Draft reply to: How do I install?");

    fireEvent.click(within(pane).getByRole("button", { name: "Close Try it" }));
    expect(screen.queryByRole("complementary", { name: "Try it" })).toBeNull();
    expect(pane.isConnected).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Try it" }));

    // Closed on a Build screen stays closed on other Build screens...
    fireEvent.click(screen.getByRole("link", { name: "Sources" }));
    await screen.findByRole("heading", { name: "Sources", level: 1 });
    expect(screen.queryByRole("complementary", { name: "Try it" })).toBeNull();

    // ...and opening it on a Monitor screen is remembered separately.
    fireEvent.click(screen.getByRole("link", { name: "Reports" }));
    fireEvent.click(screen.getByRole("button", { name: "Try it" }));
    const reopened = screen.getByRole("complementary", { name: "Try it" });
    expect(reopened).toBe(pane);
    expect(document.activeElement).toBe(within(reopened).getByLabelText("Ask a question"));
    expect(within(reopened).getByText("Draft reply to: How do I install?")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem("solvchat.admin.tryIt") ?? "{}")).toEqual({
      build: false,
      monitor: true,
    });

    unmount();
    go("/admin/overview");
    render(<App />);
    await screen.findByRole("complementary", { name: "Try it" });
    fireEvent.click(screen.getByRole("link", { name: "Sources" }));
    await screen.findByRole("heading", { name: "Sources", level: 1 });
    expect(screen.queryByRole("complementary", { name: "Try it" })).toBeNull();
  });
});

describe("publish status", () => {
  it.each([
    ["Live", LIVE, true],
    ["Unpublished changes", CHANGED, false],
    ["Not published yet", NEVER, false],
  ] as const)("shows %s next to the assistant", async (label, state, publishDisabled) => {
    oneAssistant(state);
    go("/admin/behaviour");
    render(<App />);
    await findAssistantButton();
    const badge = await within(header()).findByText(label);
    expect(badge.className).toContain("status-badge");
    const publish = within(header()).getByRole("button", { name: "Publish draft" });
    expect((publish as HTMLButtonElement).disabled).toBe(publishDisabled);
    await expectNoSeriousA11yViolations();
  });

  it("shows the status but no Publish on Monitor screens", async () => {
    oneAssistant(CHANGED);
    render(<App />);
    await findAssistantButton();
    await within(header()).findByText("Unpublished changes");
    expect(within(header()).queryByRole("button", { name: "Publish draft" })).toBeNull();
    expect(within(header()).queryByRole("button", { name: "More publish options" })).toBeNull();
  });

  it("publishes from the header, runs tests first, and updates the status", async () => {
    const server = installServer(
      [{ assistant: makeAssistant("ast_1", "Docs Bot"), state: structuredClone(CHANGED) }],
      { failTests: true },
    );
    go("/admin/sources");
    render(<App />);
    await findAssistantButton();
    fireEvent.click(await within(header()).findByRole("button", { name: "Publish draft" }));
    await confirmPublish();

    const dialog = await screen.findByRole("dialog", { name: "Not published" });
    expect(within(dialog).getByText("What is the refund policy?")).toBeTruthy();
    expect(within(header()).getByText("Unpublished changes")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Publish anyway" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await within(header()).findByText("Live")).toBeTruthy();
    expect((await screen.findByRole("status")).textContent).toMatch(/Published/);
    const publishes = server.calls.filter((c) => c.path.endsWith("/publish"));
    expect(publishes.map((c) => c.body)).toEqual([undefined, { force: true, runId: "run_1" }]);
  });

  it("discards unpublished changes after confirming, and the screen reloads", async () => {
    const server = oneAssistant(CHANGED);
    go("/admin/behaviour");
    render(<App />);
    const greeting = (await screen.findByLabelText("First thing it says")) as HTMLInputElement;
    await waitFor(() => expect(greeting.value).toBe("Hello there"));
    await within(header()).findByText("Unpublished changes");

    fireEvent.click(within(header()).getByRole("button", { name: "More publish options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Discard changes" }));
    const dialog = screen.getByRole("dialog", { name: "Discard unpublished changes?" });
    // Cancel is focused first so Enter never discards by accident.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    const confirm = within(dialog).getByRole("button", { name: "Discard changes" });
    expect(confirm.className).toContain("btn-danger");
    await act(async () => {
      fireEvent.click(confirm);
    });

    await within(header()).findByText("Live");
    await waitFor(() => expect(greeting.value).toBe("Hi"));
    const put = server.calls.find((c) => c.method === "PUT" && c.path.endsWith("/draft"));
    expect((put?.body as Config | undefined)?.behaviour.greeting).toBe("Hi");
    expect(server.states.get("ast_1")?.draft.behaviour.greeting).toBe("Hi");
  });

  it("refreshes after a screen saves", async () => {
    oneAssistant(LIVE);
    go("/admin/behaviour");
    render(<App />);
    const greeting = (await screen.findByLabelText("First thing it says")) as HTMLInputElement;
    await within(header()).findByText("Live");
    fireEvent.change(greeting, { target: { value: "Welcome!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(header()).findByText("Unpublished changes")).toBeTruthy();
  });
});

describe("header Publish with unsaved edits on the screen", () => {
  it.each([
    ["behaviour", "First thing it says"],
    ["widget", "Title"],
  ] as const)("waits for %s edits to be saved first", async (screenId, fieldLabel) => {
    const server = oneAssistant(CHANGED);
    go(`/admin/${screenId}`);
    render(<App />);
    const field = (await screen.findByLabelText(fieldLabel)) as HTMLInputElement;
    await waitFor(() => expect(field.value).not.toBe(""));
    await within(header()).findByText("Unpublished changes");
    const publish = within(header()).getByRole("button", {
      name: "Publish draft",
    }) as HTMLButtonElement;
    expect(publish.disabled).toBe(false);

    fireEvent.change(field, { target: { value: "Not saved yet" } });
    await waitFor(() => expect(publish.disabled).toBe(true));
    expect(publish.title).toBe("Save your changes before publishing.");
    fireEvent.click(publish);
    expect(server.calls.some((c) => c.path.endsWith("/publish"))).toBe(false);

    // Saving lets the header publish again, and it publishes what was saved.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(publish.disabled).toBe(false));
    fireEvent.click(publish);
    await confirmPublish();
    await within(header()).findByText("Live");
    const published = server.states.get("ast_1")?.published;
    const value =
      screenId === "behaviour" ? published?.behaviour.greeting : published?.widget.title;
    expect(value).toBe("Not saved yet");
  });

  it("disables Publish anyway in the failed-tests dialog while edits are unsaved", async () => {
    const server = installServer(
      [{ assistant: makeAssistant("ast_1", "Docs Bot"), state: structuredClone(CHANGED) }],
      { failTests: true },
    );
    go("/admin/behaviour");
    render(<App />);
    const greeting = (await screen.findByLabelText("First thing it says")) as HTMLInputElement;
    await waitFor(() => expect(greeting.value).toBe("Hello there"));
    fireEvent.click(await within(header()).findByRole("button", { name: "Publish draft" }));
    await confirmPublish();
    const dialog = await screen.findByRole("dialog", { name: "Not published" });
    const anyway = within(dialog).getByRole("button", {
      name: "Publish anyway",
    }) as HTMLButtonElement;
    await waitFor(() => expect(anyway.disabled).toBe(false));

    fireEvent.change(greeting, { target: { value: "Edited behind the dialog" } });
    await waitFor(() => expect(anyway.disabled).toBe(true));
    expect(within(dialog).getByText("Save your changes before publishing.")).toBeTruthy();
    fireEvent.click(anyway);
    const forced = server.calls.filter(
      (c) => c.path.endsWith("/publish") && (c.body as { force?: boolean })?.force === true,
    );
    expect(forced).toHaveLength(0);
  });
});

describe("header Publish with the screen's History open", () => {
  it.each([
    ["behaviour", "First thing it says", "How it should sound"],
    ["widget", "Title", "Accent colour"],
  ] as const)(
    "refreshes %s History and the draft, keeping edits typed mid-publish",
    async (screenId, editedLabel, untouchedLabel) => {
      let release = () => {};
      const holdPublish = new Promise<void>((resolve) => {
        release = resolve;
      });
      const server = installServer(
        [{ assistant: makeAssistant("ast_1", "Docs Bot"), state: structuredClone(NEVER) }],
        { holdPublish },
      );
      go(`/admin/${screenId}`);
      render(<App />);
      const edited = (await screen.findByLabelText(editedLabel)) as HTMLInputElement;
      await waitFor(() => expect(edited.value).not.toBe(""));
      const untouched = screen.getByLabelText(untouchedLabel) as HTMLInputElement;
      const untouchedBefore = untouched.value;

      fireEvent.click(screen.getByRole("button", { name: "History" }));
      const history = await screen.findByRole("region", { name: "Version history" });
      await within(history).findByText("Draft");
      expect(within(history).queryByText("Published")).toBeNull();
      const draftLoads = () =>
        server.calls.filter((c) => c.method === "GET" && c.path.endsWith("/draft")).length;
      const loadsBefore = draftLoads();

      await within(header()).findByText("Not published yet");
      fireEvent.click(within(header()).getByRole("button", { name: "Publish draft" }));
      await confirmPublish();
      await waitFor(() =>
        expect(within(header()).getByRole("button", { name: "Publishing…" })).toBeTruthy(),
      );
      fireEvent.change(edited, { target: { value: "Typed while publishing" } });
      await act(async () => {
        release();
      });

      await within(header()).findByText("Live");
      expect(await within(history).findByText("Published")).toBeTruthy();
      await waitFor(() => expect(draftLoads()).toBeGreaterThan(loadsBefore));
      // The reloaded draft has a new id; the edit typed mid-publish is kept,
      // still unsaved, and the field left alone shows the saved value.
      await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeTruthy());
      expect(edited.value).toBe("Typed while publishing");
      expect(untouched.value).toBe(untouchedBefore);
      expect(server.states.get("ast_1")?.published).not.toBeNull();
    },
  );
});

describe("dialogs opened from the narrow-screen drawer", () => {
  it("keep Tab inside the dialog instead of the drawer behind it", async () => {
    setNarrow(true);
    installServer(
      [{ assistant: makeAssistant("ast_1", "Docs Bot"), state: structuredClone(CHANGED) }],
      { failTests: true },
    );
    go("/admin/sources");
    render(<App />);
    await screen.findByRole("heading", { name: "Sources", level: 1 });
    fireEvent.click(within(header()).getByRole("button", { name: "Menu" }));
    const drawer = screen.getByRole("dialog", { name: "Menu" });
    await within(drawer).findByText("Unpublished changes");

    // Discard confirmation: Cancel is first, so Tab is normal traversal.
    fireEvent.click(within(drawer).getByRole("button", { name: "More publish options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Discard changes" }));
    const confirm = screen.getByRole("dialog", { name: "Discard unpublished changes?" });
    const cancel = within(confirm).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    expect(fireEvent.keyDown(cancel, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(cancel);
    // Wrapping at the dialog's edge is still the dialog's own.
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      within(confirm).getByRole("button", { name: "Discard changes" }),
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Discard unpublished changes?" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Menu" })).toBe(drawer);

    // The failed-tests dialog from the drawer's Publish behaves the same.
    fireEvent.click(within(drawer).getByRole("button", { name: "Publish draft" }));
    await confirmPublish();
    const failed = await screen.findByRole("dialog", { name: "Not published" });
    const fix = within(failed).getByRole("button", { name: "Go back and fix it" });
    await waitFor(() => expect((fix as HTMLButtonElement).disabled).toBe(false));
    fix.focus();
    expect(fireEvent.keyDown(fix, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(fix);
  });
});

let hostMounts = 0;

function CountingHost(_: HeaderSlotProps) {
  const [clicks, setClicks] = useState(0);
  useEffect(() => {
    hostMounts += 1;
  }, []);
  return (
    <button type="button" data-testid="host-counter" onClick={() => setClicks((n) => n + 1)}>
      Clicked {clicks}
    </button>
  );
}

describe("crossing the narrow-screen breakpoint", () => {
  it("keeps a half-filled New assistant form and host header slots mounted", async () => {
    hostMounts = 0;
    const setNarrowNow = controllableNarrow(false);
    oneAssistant(LIVE);
    render(<App options={{ headerEnd: CountingHost }} />);
    await findAssistantButton();
    openNewAssistantForm();
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Half typed" } });
    fireEvent.click(screen.getByTestId("host-counter"));
    const host = screen.getByTestId("host-counter");
    expect(host.textContent).toBe("Clicked 1");
    expect(hostMounts).toBe(1);

    // Wide to narrow: everything moves into the drawer without remounting.
    setNarrowNow(true);
    fireEvent.click(within(header()).getByRole("button", { name: "Menu" }));
    const drawer = screen.getByRole("dialog", { name: "Menu" });
    expect(within(drawer).getByLabelText("Name")).toBe(name);
    expect(name.value).toBe("Half typed");
    expect(within(drawer).getByTestId("host-counter")).toBe(host);
    expect(host.textContent).toBe("Clicked 1");

    // And back again, as when a phone is rotated twice.
    setNarrowNow(false);
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
    expect(screen.getByLabelText("Name")).toBe(name);
    expect(name.value).toBe("Half typed");
    expect(within(header()).getByTestId("host-counter")).toBe(host);
    expect(host.textContent).toBe("Clicked 1");
    expect(hostMounts).toBe(1);
  });
});

describe("narrow-screen Menu with Try it open", () => {
  it("closes the Try it sheet so the drawer is not covered", async () => {
    setNarrow(true);
    oneAssistant(LIVE);
    go("/admin/behaviour");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Try it" }));
    expect(screen.getByRole("complementary", { name: "Try it" })).toBeTruthy();

    const menu = within(header()).getByRole("button", { name: "Menu" });
    menu.focus();
    fireEvent.click(menu);
    expect(screen.queryByRole("complementary", { name: "Try it" })).toBeNull();
    expect(screen.getByRole("button", { name: "Try it" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    const drawer = screen.getByRole("dialog", { name: "Menu" });
    expect(drawer.contains(document.activeElement)).toBe(true);

    // Escape returns focus to Menu, not to Try it.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(document.activeElement).toBe(menu);
  });
});

describe("narrow-screen switcher on unscoped host screens", () => {
  it("keeps a half-filled New assistant form across an unscoped screen", async () => {
    setNarrow(true);
    oneAssistant(LIVE);
    const options: MountAdminOptions = {
      extraNavItems: [
        {
          id: "billing",
          label: "Billing",
          path: "/admin/billing",
          section: "Account",
          assistantScoped: false,
        },
      ],
      extraScreens: { billing: Billing },
    };
    render(<App options={options} />);
    const menu = await screen.findByRole("button", { name: "Menu" });
    fireEvent.click(menu);
    await findAssistantButton();
    openNewAssistantForm();
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Half typed" } });

    fireEvent.click(menu);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Menu" })).getByRole("link", { name: "Billing" }),
    );
    await screen.findByRole("heading", { name: "Billing", level: 1 });
    fireEvent.click(menu);
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect((document.querySelector(".switcher") as HTMLElement).hidden).toBe(true);

    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Menu" })).getByRole("link", { name: "Overview" }),
    );
    fireEvent.click(menu);
    const again = screen.getByLabelText("Name") as HTMLInputElement;
    expect(again).toBe(name);
    expect(again.value).toBe("Half typed");
  });
});

describe("assistant switcher", () => {
  it("lists assistants with their status in a listbox ending in New assistant", async () => {
    installServer([
      { assistant: makeAssistant("ast_1", "Docs Bot"), state: structuredClone(LIVE) },
      { assistant: makeAssistant("ast_2", "Shop Bot"), state: structuredClone(NEVER) },
    ]);
    render(<App />);
    const button = await findAssistantButton();
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    button.focus();
    fireEvent.keyDown(button, { key: "ArrowDown" });

    const listbox = screen.getByRole("listbox", { name: "Assistant" });
    expect(document.activeElement).toBe(listbox);
    await waitFor(() => {
      expect(
        within(listbox)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["Docs BotLive", "Shop BotNot published yet", "New assistant"]);
    });
    const [first, second] = within(listbox).getAllByRole("option");
    expect(first?.getAttribute("aria-selected")).toBe("true");
    expect(listbox.getAttribute("aria-activedescendant")).toBe(first?.id);
    await expectNoSeriousA11yViolations();

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(listbox.getAttribute("aria-activedescendant")).toBe(second?.id);
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(selectedAssistantId()).toBe("ast_2");
    expect(document.activeElement).toBe(assistantButton());
    await within(header()).findByText("Not published yet");

    // Escape closes without changing the selection; End + Enter opens the create form.
    fireEvent.keyDown(assistantButton(), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(selectedAssistantId()).toBe("ast_2");

    fireEvent.keyDown(assistantButton(), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "End" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    const form = screen.getByRole("region", { name: "New assistant" });
    expect(document.activeElement).toBe(within(form).getByLabelText("Name"));
    await expectNoSeriousA11yViolations();
  });

  it("scrolls the keyboard-active option into view in a long list", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      assistant: makeAssistant(`ast_${String(i).padStart(2, "0")}`, `Bot ${i}`),
      state: structuredClone(LIVE),
    }));
    installServer(many);
    // jsdom has no layout, so record which option each scroll targets.
    const scrolled: string[] = [];
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value(this: Element, arg?: ScrollIntoViewOptions) {
        expect(arg).toEqual({ block: "nearest" });
        scrolled.push(this.textContent ?? "");
      },
    });
    try {
      render(<App />);
      const button = await findAssistantButton();
      pickByKeyboard(button, "ast_27");

      // Opening with a selection near the bottom brings it into view.
      scrolled.length = 0;
      fireEvent.keyDown(assistantButton(), { key: "ArrowDown" });
      const listbox = screen.getByRole("listbox");
      const active = () =>
        document.getElementById(listbox.getAttribute("aria-activedescendant") ?? "");
      expect(active()?.getAttribute("data-value")).toBe("ast_27");
      expect(scrolled.at(-1)).toMatch(/^Bot 27/);

      // End, ArrowUp and Home each scroll the newly active option.
      fireEvent.keyDown(listbox, { key: "End" });
      expect(active()?.textContent).toBe("New assistant");
      expect(scrolled.at(-1)).toBe("New assistant");
      fireEvent.keyDown(listbox, { key: "ArrowUp" });
      expect(scrolled.at(-1)).toMatch(/^Bot 29/);
      fireEvent.keyDown(listbox, { key: "Home" });
      expect(scrolled.at(-1)).toMatch(/^Bot 0/);

      // Hovering does not scroll: the hovered option is already in view.
      const count = scrolled.length;
      const options = within(listbox).getAllByRole("option");
      fireEvent.mouseEnter(options[5] as HTMLElement);
      expect(active()).toBe(options[5]);
      expect(scrolled).toHaveLength(count);
    } finally {
      if (original) Object.defineProperty(Element.prototype, "scrollIntoView", original);
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

/** Selects `id` through the open listbox with ArrowDown presses and Enter. */
function pickByKeyboard(button: HTMLElement, id: string): void {
  fireEvent.keyDown(button, { key: "ArrowDown" });
  const listbox = screen.getByRole("listbox");
  for (let i = 0; i < 40; i++) {
    const active = document.getElementById(listbox.getAttribute("aria-activedescendant") ?? "");
    if (active?.getAttribute("data-value") === id) break;
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
  }
  fireEvent.keyDown(listbox, { key: "Enter" });
  expect(selectedAssistantId()).toBe(id);
}
