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

  it("does not ask while the save covering the edits is still running", async () => {
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

    fireEvent.click(navLink("Widget"));
    expect(await screen.findByLabelText("Title")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Leave without saving?" })).toBeNull();
    release();
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
});
