/**
 * @vitest-environment-options {"settings": {"disableJavaScriptFileLoading": true, "handleDisabledFileLoadingAsSuccess": true, "navigation": {"disableChildFrameNavigation": true}}}
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { installBuildScreensFake, makeAssistant } from "./support/buildScreensFake.js";
import { pickAssistant, selectedAssistantId } from "./support/switcher.js";

function navLink(name: string): HTMLElement {
  return within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name });
}

describe("leaving a screen with unsaved edits", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/behaviour");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("asks first; Stay here keeps the edits and the screen", async () => {
    installBuildScreensFake();
    render(<App />);
    const greeting = (await screen.findByLabelText("First thing it says")) as HTMLInputElement;
    fireEvent.change(greeting, { target: { value: "Edited, not saved" } });

    fireEvent.click(navLink("Widget"));
    const dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    expect(window.location.pathname).toBe("/admin/behaviour");
    // Cancel is focused first, so Enter never throws the edits away.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Stay here" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Stay here" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.pathname).toBe("/admin/behaviour");
    expect((screen.getByLabelText("First thing it says") as HTMLInputElement).value).toBe(
      "Edited, not saved",
    );
  });

  it("Leave without saving goes to the other screen", async () => {
    installBuildScreensFake();
    render(<App />);
    fireEvent.change(await screen.findByLabelText("First thing it says"), {
      target: { value: "Thrown away" },
    });
    fireEvent.click(navLink("Widget"));
    fireEvent.click(await screen.findByRole("button", { name: "Leave without saving" }));
    expect(await screen.findByLabelText("Title")).toBeTruthy();
    expect(window.location.pathname).toBe("/admin/widget");
  });

  it("does not ask when nothing is unsaved", async () => {
    installBuildScreensFake();
    render(<App />);
    await screen.findByLabelText("First thing it says");
    fireEvent.click(navLink("Widget"));
    expect(await screen.findByLabelText("Title")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /**
   * Holds every save (PUT/PATCH) until `release` is called. `release(true)`
   * answers it with a 400, as the API does for a value it will not accept.
   */
  function holdSaves() {
    const inner = globalThis.fetch;
    let settle!: (reject: boolean) => void;
    const held = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT" || method === "PATCH") {
        if (await held) {
          return Response.json({ error: "That greeting is too long." }, { status: 400 });
        }
      }
      return inner(input, init);
    });
    return { release: (reject = false) => settle(reject) };
  }

  async function startBehaviourSave(text: string) {
    fireEvent.change(await screen.findByLabelText("First thing it says"), {
      target: { value: text },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect((screen.getByLabelText("First thing it says") as HTMLInputElement).disabled).toBe(
        true,
      ),
    );
  }

  it("waits for a running save, then moves on without asking once it is saved", async () => {
    const api = installBuildScreensFake();
    const saves = holdSaves();
    render(<App />);
    await startBehaviourSave("Saving now");

    fireEvent.click(navLink("Widget"));
    // The save could still fail, so the screen and its edits stay for now.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.location.pathname).toBe("/admin/behaviour");
    expect(screen.getByLabelText("First thing it says")).toBeTruthy();

    saves.release();
    expect(await screen.findByLabelText("Title")).toBeTruthy();
    expect(window.location.pathname).toBe("/admin/widget");
    expect(screen.queryByRole("dialog", { name: "Leave without saving?" })).toBeNull();
    expect(api.drafts.get("ast_1")?.config.behaviour.greeting).toBe("Saving now");
  });

  it("asking for the screen already on show drops a move waiting for a save", async () => {
    installBuildScreensFake();
    const saves = holdSaves();
    render(<App />);
    await startBehaviourSave("Staying here");

    fireEvent.click(navLink("Widget"));
    fireEvent.click(navLink("Behaviour"));
    saves.release();
    await waitFor(() =>
      expect((screen.getByLabelText("First thing it says") as HTMLInputElement).disabled).toBe(
        false,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.location.pathname).toBe("/admin/behaviour");
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("a failed save keeps the edits and the error, and asks before leaving", async () => {
    installBuildScreensFake();
    const saves = holdSaves();
    render(<App />);
    await startBehaviourSave("Far too long a greeting");

    fireEvent.click(navLink("Widget"));
    saves.release(true);
    const dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    expect(window.location.pathname).toBe("/admin/behaviour");

    fireEvent.click(within(dialog).getByRole("button", { name: "Stay here" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.pathname).toBe("/admin/behaviour");
    const greeting = screen.getByLabelText("First thing it says") as HTMLInputElement;
    expect(greeting.value).toBe("Far too long a greeting");
    expect(greeting.disabled).toBe(false);
    expect(screen.getByText("That greeting is too long.")).toBeTruthy();
  });

  it("a failed Widget save keeps the edits and asks before leaving", async () => {
    window.history.replaceState(null, "", "/admin/widget");
    installBuildScreensFake();
    const saves = holdSaves();
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Edited title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Title") as HTMLInputElement).disabled).toBe(true),
    );

    fireEvent.click(navLink("Behaviour"));
    saves.release(true);
    const dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    expect(window.location.pathname).toBe("/admin/widget");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay here" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Edited title");
    expect(screen.getByText("That greeting is too long.")).toBeTruthy();
  });

  it("switching assistant waits for a running save and asks if it fails", async () => {
    installBuildScreensFake({
      assistants: [makeAssistant("ast_1", "First Bot"), makeAssistant("ast_2", "Second Bot")],
    });
    const saves = holdSaves();
    render(<App />);
    await startBehaviourSave("First bot edit");

    pickAssistant("ast_2");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(selectedAssistantId()).toBe("ast_1");

    saves.release(true);
    const dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay here" }));
    expect(selectedAssistantId()).toBe("ast_1");
    expect((screen.getByLabelText("First thing it says") as HTMLInputElement).value).toBe(
      "First bot edit",
    );
  });

  it("guards switching assistant the same way", async () => {
    installBuildScreensFake({
      assistants: [makeAssistant("ast_1", "First Bot"), makeAssistant("ast_2", "Second Bot")],
    });
    render(<App />);
    fireEvent.change(await screen.findByLabelText("First thing it says"), {
      target: { value: "First bot edit" },
    });

    pickAssistant("ast_2");
    const dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    expect(selectedAssistantId()).toBe("ast_1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay here" }));
    expect((screen.getByLabelText("First thing it says") as HTMLInputElement).value).toBe(
      "First bot edit",
    );

    pickAssistant("ast_2");
    fireEvent.click(await screen.findByRole("button", { name: "Leave without saving" }));
    await waitFor(() => expect(selectedAssistantId()).toBe("ast_2"));
  });

  it("asks the browser before the tab closes, only while edits are unsaved", async () => {
    installBuildScreensFake();
    render(<App />);
    const greeting = await screen.findByLabelText("First thing it says");

    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    fireEvent.change(greeting, { target: { value: "Edited" } });
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  /**
   * Same-document session history, as a browser keeps it. happy-dom's own
   * back/forward reload the frame instead of firing popstate.
   */
  function browserHistory() {
    const real = History.prototype.replaceState;
    const setAddress = (state: unknown, url: string) => real.call(window.history, state, "", url);
    const entries = [{ state: window.history.state as unknown, url: window.location.pathname }];
    let index = 0;
    vi.spyOn(window.history, "pushState").mockImplementation((state, _title, url) => {
      const next = { state, url: String(url ?? window.location.pathname) };
      entries.splice(index + 1, entries.length, next);
      index += 1;
      setAddress(next.state, next.url);
    });
    vi.spyOn(window.history, "replaceState").mockImplementation((state, _title, url) => {
      const entry = { state, url: String(url ?? window.location.pathname) };
      entries[index] = entry;
      setAddress(entry.state, entry.url);
    });
    const go = (delta = 0) => {
      const target = index + delta;
      const entry = entries[target];
      if (delta === 0 || !entry) return;
      setTimeout(() => {
        index = target;
        setAddress(entry.state, entry.url);
        window.dispatchEvent(new PopStateEvent("popstate", { state: entry.state }));
      }, 0);
    };
    vi.spyOn(window.history, "go").mockImplementation(go);
    vi.spyOn(window.history, "back").mockImplementation(() => go(-1));
    vi.spyOn(window.history, "forward").mockImplementation(() => go(1));
    return { position: () => index };
  }

  async function popTo(move: () => void) {
    const popped = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    move();
    await popped;
  }

  it("asks before Back leaves; Stay here keeps the screen, the edits and the address", async () => {
    window.history.replaceState(null, "", "/admin/widget");
    const history = browserHistory();
    installBuildScreensFake();
    render(<App />);
    await screen.findByLabelText("Title");
    fireEvent.click(navLink("Behaviour"));
    fireEvent.change(await screen.findByLabelText("First thing it says"), {
      target: { value: "Not saved yet" },
    });

    await popTo(() => window.history.back());
    let dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay here" }));
    await waitFor(() => expect(window.location.pathname).toBe("/admin/behaviour"));
    expect(history.position()).toBe(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((screen.getByLabelText("First thing it says") as HTMLInputElement).value).toBe(
      "Not saved yet",
    );

    // Still one entry ahead of the Widget screen, so Back asks again.
    await popTo(() => window.history.back());
    dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave without saving" }));
    expect(await screen.findByLabelText("Title")).toBeTruthy();
    expect(window.location.pathname).toBe("/admin/widget");
    expect(history.position()).toBe(0);
  });

  it("Back during a save that fails asks, and Stay here puts the address back", async () => {
    window.history.replaceState(null, "", "/admin/widget");
    const history = browserHistory();
    installBuildScreensFake();
    const saves = holdSaves();
    render(<App />);
    await screen.findByLabelText("Title");
    fireEvent.click(navLink("Behaviour"));
    await startBehaviourSave("Rejected on save");

    await popTo(() => window.history.back());
    // Still on Behaviour while the save runs.
    expect(screen.getByLabelText("First thing it says")).toBeTruthy();
    saves.release(true);
    const dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay here" }));
    await waitFor(() => expect(window.location.pathname).toBe("/admin/behaviour"));
    expect(history.position()).toBe(1);
    expect((screen.getByLabelText("First thing it says") as HTMLInputElement).value).toBe(
      "Rejected on save",
    );
  });

  it("asks before Forward leaves, and Stay here returns to the same entry", async () => {
    const history = browserHistory();
    installBuildScreensFake();
    render(<App />);
    await screen.findByLabelText("First thing it says");
    fireEvent.click(navLink("Widget"));
    await screen.findByLabelText("Title");
    // Nothing unsaved: Back goes straight there.
    await popTo(() => window.history.back());
    const greeting = await screen.findByLabelText("First thing it says");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.change(greeting, { target: { value: "Edited after Back" } });

    await popTo(() => window.history.forward());
    let dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    expect(screen.getByLabelText("First thing it says")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay here" }));
    await waitFor(() => expect(window.location.pathname).toBe("/admin/behaviour"));
    expect(history.position()).toBe(0);
    expect((screen.getByLabelText("First thing it says") as HTMLInputElement).value).toBe(
      "Edited after Back",
    );

    await popTo(() => window.history.forward());
    dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave without saving" }));
    expect(await screen.findByLabelText("Title")).toBeTruthy();
    expect(window.location.pathname).toBe("/admin/widget");
  });

  it("keeps asking the browser before the tab closes until a running save finishes", async () => {
    installBuildScreensFake();
    const inner = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "PUT") await held;
      return inner(input, init);
    });
    const closing = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    render(<App />);
    fireEvent.change(await screen.findByLabelText("First thing it says"), {
      target: { value: "Saving now" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect((screen.getByLabelText("First thing it says") as HTMLInputElement).disabled).toBe(
        true,
      ),
    );
    expect(closing()).toBe(true);

    release();
    await waitFor(() => expect(closing()).toBe(false));
  });
});
