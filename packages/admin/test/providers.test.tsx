import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsView } from "../src/api/types.js";
import { Providers } from "../src/screens/Providers.js";

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

function installProvidersFakeServer() {
  let state = initialView();
  let getCount = 0;
  const savedSettingsBodies: unknown[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "https://example.com").pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (path === "/api/admin/providers" && method === "GET") {
      getCount += 1;
      return Response.json(structuredClone(state));
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

    return new Response("Not found", { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    getCount: () => getCount,
    savedSettingsBodies,
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
    render(<Providers />);

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

    expect(await within(openRouterCard).findByText("OpenRouter key saved.")).toBeTruthy();
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
});
