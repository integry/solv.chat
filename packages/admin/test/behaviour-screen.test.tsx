import { CONFIG_LIMITS } from "@solvchat/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { expectNoSeriousA11yViolations } from "./support/axe.js";
import { installBuildScreensFake } from "./support/buildScreensFake.js";

function questionInputs(): HTMLInputElement[] {
  return screen.getAllByLabelText(/^Suggested question \d+$/) as HTMLInputElement[];
}

function lastPutQuestions(calls: Array<{ method: string; path: string; body: unknown }>) {
  const put = calls.filter((c) => c.method === "PUT" && c.path.endsWith("/draft")).at(-1);
  return (put?.body as { behaviour: { suggestedQuestions: string[] } } | undefined)?.behaviour
    .suggestedQuestions;
}

describe("Behaviour screen", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/behaviour");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens History when the address asks for it, then drops the request from the address", async () => {
    installBuildScreensFake();
    window.history.replaceState(null, "", "/admin/behaviour?assistant=ast_1&history=open");
    render(<App />);
    expect(await screen.findByRole("region", { name: "Version history" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "History" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(new URLSearchParams(window.location.search).has("history")).toBe(false);
  });

  it("keeps History closed by default", async () => {
    installBuildScreensFake();
    render(<App />);
    await screen.findByLabelText("First thing it says");
    expect(screen.queryByRole("region", { name: "Version history" })).toBeNull();
  });

  it("groups the fields under plain headings, each with one line of help", async () => {
    installBuildScreensFake();
    render(<App />);
    await screen.findByLabelText("First thing it says");

    for (const heading of ["Greeting", "Tone", "When it does not know", "Suggested questions"]) {
      const region = screen.getByRole("region", { name: heading });
      expect(within(region).getByRole("heading", { name: heading })).toBeTruthy();
      expect(region.querySelector(".field-hint")?.textContent?.length).toBeGreaterThan(10);
    }
    expect(screen.getByRole("region", { name: "Greeting" }).textContent).toContain(
      "First thing it says",
    );
  });

  it("shows character counts against the limits and says when a field is too long", async () => {
    installBuildScreensFake();
    render(<App />);
    const greeting = (await screen.findByLabelText("First thing it says")) as HTMLInputElement;

    fireEvent.change(greeting, { target: { value: "Hello there" } });
    const count = document.getElementById(greeting.getAttribute("aria-describedby") ?? "");
    expect(count?.textContent).toBe(`11 / ${CONFIG_LIMITS.greeting}`);

    fireEvent.change(greeting, { target: { value: "x".repeat(CONFIG_LIMITS.greeting + 3) } });
    expect(count?.textContent).toBe(
      `3 characters too long (${CONFIG_LIMITS.greeting + 3} / ${CONFIG_LIMITS.greeting})`,
    );
    expect(count?.className).toContain("char-count-over");
    expect(screen.getByText(`0 / ${CONFIG_LIMITS.persona}`)).toBeTruthy();
  });

  it("adds, removes and reorders suggested questions and saves them in that order", async () => {
    const server = installBuildScreensFake();
    render(<App />);
    await screen.findByLabelText("Suggested question 1");
    expect(questionInputs().map((i) => i.value)).toEqual(["First?", "Second?", "Third?"]);
    expect(screen.queryByLabelText(/Questions to suggest/)).toBeNull();

    // Move the third question up to second, then the first one down.
    fireEvent.click(screen.getByRole("button", { name: "Move question 3 up" }));
    expect(questionInputs().map((i) => i.value)).toEqual(["First?", "Third?", "Second?"]);
    fireEvent.click(screen.getByRole("button", { name: "Move question 1 down" }));
    expect(questionInputs().map((i) => i.value)).toEqual(["Third?", "First?", "Second?"]);
    expect(
      (screen.getByRole("button", { name: "Move question 1 up" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Move question 3 down" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Remove question 2" }));
    expect(questionInputs().map((i) => i.value)).toEqual(["Third?", "Second?"]);

    fireEvent.click(screen.getByRole("button", { name: "Add a question" }));
    const added = questionInputs()[2];
    if (!added) throw new Error("no new row");
    fireEvent.change(added, { target: { value: "  New one?  " } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Draft saved.")).toBeTruthy();
    expect(lastPutQuestions(server.calls)).toEqual(["Third?", "Second?", "New one?"]);
    await waitFor(() =>
      expect(questionInputs().map((i) => i.value)).toEqual(["Third?", "Second?", "New one?"]),
    );
  });

  it("stops at the maximum number of questions and leaves empty rows out of the save", async () => {
    const server = installBuildScreensFake();
    render(<App />);
    await screen.findByLabelText("Suggested question 1");
    const add = screen.getByRole("button", { name: "Add a question" }) as HTMLButtonElement;

    for (let i = 3; i < CONFIG_LIMITS.suggestedQuestions; i++) fireEvent.click(add);
    expect(questionInputs()).toHaveLength(CONFIG_LIMITS.suggestedQuestions);
    expect(add.disabled).toBe(true);
    expect(screen.getByText(/that is the most the chat shows/)).toBeTruthy();

    // Empty rows alone are not a change; with a real edit they are dropped on save.
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    fireEvent.change(questionInputs()[3] as HTMLInputElement, { target: { value: "Fourth?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Draft saved.")).toBeTruthy();
    expect(lastPutQuestions(server.calls)).toEqual(["First?", "Second?", "Third?", "Fourth?"]);
  });

  it("shows an error with Try again when the draft cannot load, and recovers", async () => {
    const server = installBuildScreensFake({ failing: ["/api/admin/assistants/ast_1/draft"] });
    render(<App />);
    expect(await screen.findByText("Could not load your assistant's behaviour.")).toBeTruthy();
    server.recover();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("First thing it says")).toBeTruthy();
  });

  it("has no serious accessibility problems", async () => {
    installBuildScreensFake();
    const { container } = render(<App />);
    await screen.findByLabelText("Suggested question 1");
    await expectNoSeriousA11yViolations(container);
  });
});
