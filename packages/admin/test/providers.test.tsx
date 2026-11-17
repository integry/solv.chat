import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { KeyTestResult, ProviderSettingsView } from "../src/api/types.js";
import { Providers } from "../src/screens/Providers.js";
import { ToastProvider } from "../src/ui/Toast.js";
import { expectNoSeriousA11yViolations } from "./support/axe.js";

/**
 * The shell provides the toast region and the <main> landmark; the screen is
 * rendered on its own here, so both are added around it.
 */
function renderProviders() {
  return render(
    <ToastProvider>
      <main>
        <Providers />
      </main>
    </ToastProvider>,
  );
}

function initialView(): ProviderSettingsView {
  return {
    settings: {
      llmProvider: { value: "anthropic", source: "none" },
      llmTier: { value: "fast", source: "none" },
      llmModel: { value: null, source: "none" },
      embeddingsProvider: { value: "openai", source: "none" },
    },
    keysManaged: false,
    keys: {
      anthropic: { source: "none", updatedAt: null, unreadable: false },
      openai: { source: "none", updatedAt: null, unreadable: false },
      openrouter: { source: "none", updatedAt: null, unreadable: false },
    },
    configError:
      "Anthropic is selected, but no API key is set. Add one in Settings → Providers or set SOLV_ANTHROPIC_KEY.",
  };
}

function installProvidersFakeServer(options?: {
  deferReloadGet?: boolean;
  view?: ProviderSettingsView;
  keyTest?: KeyTestResult;
  failFirstGet?: boolean;
}) {
  let state = options?.view ?? initialView();
  const deletedKeys: string[] = [];
  const testedKeys: string[] = [];
  let getCount = 0;
  const savedSettingsBodies: unknown[] = [];
  let releaseDeferredGet: (() => void) | null = null;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "https://example.com").pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (path === "/api/admin/assistants" && method === "GET") {
      return Response.json({ assistants: [] });
    }

    if (path === "/api/admin/providers" && method === "GET") {
      getCount += 1;
      if (options?.failFirstGet && getCount === 1) {
        return Response.json({ error: "The database is busy." }, { status: 503 });
      }
      const snapshot = structuredClone(state);
      if (options?.deferReloadGet && getCount === 2) {
        await new Promise<void>((resolve) => {
          releaseDeferredGet = resolve;
        });
      }
      return Response.json(snapshot);
    }

    if (path === "/api/admin/providers" && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        llmProvider?: "anthropic" | "openai" | "openrouter" | null;
        llmTier?: "fast" | "balanced" | null;
        llmModel?: string | null;
        embeddingsProvider?: "openai" | "openrouter" | null;
      };
      savedSettingsBodies.push(body);
      state = {
        ...state,
        settings: {
          llmProvider:
            body.llmProvider !== undefined && body.llmProvider !== null
              ? { value: body.llmProvider, source: "stored" }
              : { value: "anthropic", source: "none" },
          llmTier:
            body.llmTier !== undefined && body.llmTier !== null
              ? { value: body.llmTier, source: "stored" }
              : { value: "fast", source: "none" },
          llmModel:
            body.llmModel !== undefined && body.llmModel !== null
              ? { value: body.llmModel, source: "stored" }
              : { value: null, source: "none" },
          embeddingsProvider:
            body.embeddingsProvider !== undefined && body.embeddingsProvider !== null
              ? { value: body.embeddingsProvider, source: "stored" }
              : { value: "openai", source: "none" },
        },
        configError: null,
      };
      return Response.json(structuredClone(state));
    }

    const keyMatch = /^\/api\/admin\/providers\/keys\/(anthropic|openai|openrouter)$/.exec(path);
    if (keyMatch?.[1] && method === "PUT") {
      const provider = keyMatch[1] as "anthropic" | "openai" | "openrouter";
      state = {
        ...state,
        keys: {
          ...state.keys,
          [provider]: { source: "stored", updatedAt: 1_700_000_000_000, unreadable: false },
        },
      };
      return Response.json({ ok: true });
    }

    if (keyMatch?.[1] && method === "DELETE") {
      const provider = keyMatch[1] as "anthropic" | "openai" | "openrouter";
      deletedKeys.push(provider);
      state = {
        ...state,
        keys: { ...state.keys, [provider]: { source: "none", updatedAt: null, unreadable: false } },
      };
      return Response.json({ ok: true });
    }

    const testMatch = /^\/api\/admin\/providers\/keys\/(anthropic|openai|openrouter)\/test$/.exec(
      path,
    );
    if (testMatch?.[1] && method === "POST") {
      testedKeys.push(testMatch[1]);
      return Response.json(
        options?.keyTest ?? { ok: true, category: "ok", message: "The key was accepted." },
      );
    }

    return new Response("Not found", { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    deletedKeys,
    testedKeys,
    getCount: () => getCount,
    savedSettingsBodies,
    releaseDeferredGet: () => {
      releaseDeferredGet?.();
      releaseDeferredGet = null;
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Providers screen", () => {
  it("preserves unsaved provider settings when saving an API key triggers a reload", async () => {
    const server = installProvidersFakeServer();
    renderProviders();

    const llmProviderSelect = (await screen.findByLabelText(
      "Answering provider",
    )) as HTMLSelectElement;
    const embeddingsSelect = screen.getByLabelText("Embeddings provider") as HTMLSelectElement;

    expect(llmProviderSelect.value).toBe("anthropic");
    expect(embeddingsSelect.value).toBe("openai");
    expect(server.getCount()).toBe(1);

    // Owner selects OpenRouter, enters a model ID, and switches embeddings to OpenRouter
    // without clicking Save settings yet.
    fireEvent.change(llmProviderSelect, { target: { value: "openrouter" } });
    const llmModelInput = screen.getByLabelText("OpenRouter model ID") as HTMLInputElement;
    fireEvent.change(llmModelInput, { target: { value: "anthropic/claude-sonnet-4" } });
    fireEvent.change(embeddingsSelect, { target: { value: "openrouter" } });

    // Owner enters the OpenRouter API key and clicks Save key.
    const openRouterCard = screen.getByRole("region", { name: "OpenRouter API key" });
    const keyInput = within(openRouterCard).getByLabelText("API key") as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "sk-or-test-key" } });
    fireEvent.click(within(openRouterCard).getByRole("button", { name: "Save key" }));

    expect(await screen.findByText("OpenRouter key saved.")).toBeTruthy();
    await waitFor(() => {
      expect(server.getCount()).toBe(2);
    });
    // Key card reflects the reloaded stored status.
    expect(within(openRouterCard).getByRole("button", { name: "Replace" })).toBeTruthy();

    // Unsaved settings edits must remain intact after the reload.
    expect((screen.getByLabelText("Answering provider") as HTMLSelectElement).value).toBe(
      "openrouter",
    );
    expect((screen.getByLabelText("OpenRouter model ID") as HTMLInputElement).value).toBe(
      "anthropic/claude-sonnet-4",
    );
    expect((screen.getByLabelText("Embeddings provider") as HTMLSelectElement).value).toBe(
      "openrouter",
    );

    // Saving settings persists those pending selections.
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Provider settings saved.")).toBeTruthy();
    expect(server.savedSettingsBodies).toEqual([
      {
        llmProvider: "openrouter",
        llmModel: "anthropic/claude-sonnet-4",
        embeddingsProvider: "openrouter",
      },
    ]);
  });

  it("ignores an earlier key-triggered reload GET that resolves after Save settings PUT", async () => {
    const server = installProvidersFakeServer({ deferReloadGet: true });
    renderProviders();

    const llmProviderSelect = (await screen.findByLabelText(
      "Answering provider",
    )) as HTMLSelectElement;
    const embeddingsSelect = screen.getByLabelText("Embeddings provider") as HTMLSelectElement;

    // Owner edits settings before saving an API key.
    fireEvent.change(llmProviderSelect, { target: { value: "openrouter" } });
    fireEvent.change(screen.getByLabelText("OpenRouter model ID"), {
      target: { value: "anthropic/claude-sonnet-4" },
    });
    fireEvent.change(embeddingsSelect, { target: { value: "openrouter" } });

    // Saving the key starts GET #2, which is held in-flight with the old settings.
    const openRouterCard = screen.getByRole("region", { name: "OpenRouter API key" });
    fireEvent.change(within(openRouterCard).getByLabelText("API key"), {
      target: { value: "sk-or-test-key" },
    });
    fireEvent.click(within(openRouterCard).getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("OpenRouter key saved.")).toBeTruthy();
    await waitFor(() => {
      expect(server.getCount()).toBe(2);
    });

    // While GET #2 is still pending, owner clicks Save settings (PUT completes first).
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Provider settings saved.")).toBeTruthy();

    // Now the stale GET #2 resolves with the old settings.
    server.releaseDeferredGet();
    await Promise.resolve();
    await Promise.resolve();

    // The form must keep the saved settings rather than reverting to the stale GET.
    expect((screen.getByLabelText("Answering provider") as HTMLSelectElement).value).toBe(
      "openrouter",
    );
    expect((screen.getByLabelText("OpenRouter model ID") as HTMLInputElement).value).toBe(
      "anthropic/claude-sonnet-4",
    );
    expect((screen.getByLabelText("Embeddings provider") as HTMLSelectElement).value).toBe(
      "openrouter",
    );
  });

  it("says where each value comes from in plain words", async () => {
    const view = initialView();
    view.configError = null;
    view.settings.llmTier = { value: "fast", source: "environment" };
    view.settings.embeddingsProvider = { value: "openai", source: "stored" };
    view.keys.anthropic = { source: "stored", updatedAt: 1_700_000_000_000, unreadable: false };
    view.keys.openai = { source: "environment", updatedAt: null, unreadable: false };
    installProvidersFakeServer({ view });
    const { container } = renderProviders();

    await screen.findByLabelText("Answering provider");
    expect(screen.getAllByText("Using the default").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Set on the server").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Set in this screen").length).toBeGreaterThan(0);
    const anthropic = screen.getByRole("region", { name: "Anthropic API key" });
    expect(within(anthropic).getByText("Set in this screen")).toBeTruthy();
    const openai = screen.getByRole("region", { name: "OpenAI API key" });
    expect(within(openai).getByText("Set on the server")).toBeTruthy();
    const openrouter = screen.getByRole("region", { name: "OpenRouter API key" });
    expect(within(openrouter).getByText("No key")).toBeTruthy();
    // The old jargon is gone.
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\bnone\b|\benvironment\b|Worker secret/);
  });

  it("shows the key test result inline, passing or failing", async () => {
    installProvidersFakeServer({
      keyTest: {
        ok: false,
        category: "unauthorised",
        message: "The provider refused this key.",
      },
    });
    renderProviders();

    const card = await screen.findByRole("region", { name: "Anthropic API key" });
    fireEvent.click(within(card).getByRole("button", { name: "Test" }));
    expect(await within(card).findByText("Key test failed")).toBeTruthy();
    expect(within(card).getByText("The provider refused this key.")).toBeTruthy();
    expect(within(card).getByRole("alert")).toBeTruthy();
  });

  it("says a working key works", async () => {
    const server = installProvidersFakeServer();
    renderProviders();

    const card = await screen.findByRole("region", { name: "OpenAI API key" });
    fireEvent.click(within(card).getByRole("button", { name: "Test" }));
    expect(await within(card).findByText("Key works")).toBeTruthy();
    expect(within(card).getByText("The key was accepted.")).toBeTruthy();
    expect(server.testedKeys).toEqual(["openai"]);
  });

  it("asks before removing a saved key, and Cancel removes nothing", async () => {
    const view = initialView();
    view.keys.anthropic = { source: "stored", updatedAt: 1_700_000_000_000, unreadable: false };
    const server = installProvidersFakeServer({ view });
    renderProviders();

    const card = await screen.findByRole("region", { name: "Anthropic API key" });
    fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
    let dialog = await screen.findByRole("dialog", { name: "Remove the Anthropic key?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.deletedKeys).toEqual([]);

    fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
    dialog = await screen.findByRole("dialog", { name: "Remove the Anthropic key?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));
    expect(await screen.findByText("Anthropic key removed.")).toBeTruthy();
    expect(server.deletedKeys).toEqual(["anthropic"]);
  });

  it("with managed keys and no own keys allowed, says they are included and offers no key entry", async () => {
    const view = initialView();
    view.keysManaged = true;
    view.ownKeysAllowed = false;
    view.configError = null;
    installProvidersFakeServer({ view });
    renderProviders();

    expect(await screen.findByText("Included with your plan")).toBeTruthy();
    expect(screen.getByText(/No key needed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use my own key" })).toBeNull();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(document.querySelector("input[type='password']")).toBeNull();
  });

  it("with managed keys and own keys allowed, puts key entry behind Use my own key", async () => {
    const view = initialView();
    view.keysManaged = true;
    view.ownKeysAllowed = true;
    view.configError = null;
    installProvidersFakeServer({ view });
    // Through the shell, which the axe check below needs (see the last test).
    window.history.replaceState(null, "", "/admin/providers");
    render(<App />);

    const toggle = await screen.findByRole("button", { name: "Use my own key" });
    expect(screen.getByText("Included with your plan")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Anthropic API key" })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const card = await screen.findByRole("region", { name: "Anthropic API key" });
    expect(within(card).getByLabelText("API key")).toBeTruthy();
    await expectNoSeriousA11yViolations(document.body);

    fireEvent.click(toggle);
    expect(screen.queryByRole("region", { name: "Anthropic API key" })).toBeNull();
  });

  it("asks before going back to the defaults", async () => {
    const view = initialView();
    view.settings.llmProvider = { value: "openai", source: "stored" };
    const server = installProvidersFakeServer({ view });
    renderProviders();

    fireEvent.click(await screen.findByRole("button", { name: "Reset to defaults" }));
    const dialog = await screen.findByRole("dialog", { name: "Go back to the defaults?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.savedSettingsBodies).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Go back to the defaults?" })).getByRole(
        "button",
        { name: "Use the defaults" },
      ),
    );
    expect(await screen.findByText("Back to the defaults.")).toBeTruthy();
    expect(server.savedSettingsBodies).toEqual([
      { llmProvider: null, llmTier: null, llmModel: null, embeddingsProvider: null },
    ]);
  });

  it("shows an error with Try again when the settings cannot load, and recovers", async () => {
    installProvidersFakeServer({ failFirstGet: true });
    renderProviders();

    expect(await screen.findByText("Could not load your provider settings.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Answering provider")).toBeTruthy();
  });

  // Rendered through the shell: axe-core's selector code crashes on this
  // screen's form buttons in happy-dom when the screen is mounted on its own.
  it("has no serious accessibility problems", async () => {
    installProvidersFakeServer();
    window.history.replaceState(null, "", "/admin/providers");
    render(<App />);
    await screen.findByLabelText("Answering provider");
    await expectNoSeriousA11yViolations(document.body);
  });
});
