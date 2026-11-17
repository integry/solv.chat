/**
 * One test follows a link to Widget, whose preview frame would load /widget.js.
 * @vitest-environment-options {"settings": {"disableJavaScriptFileLoading": true, "handleDisabledFileLoadingAsSuccess": true, "navigation": {"disableChildFrameNavigation": true}}}
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { expectNoSeriousA11yViolations } from "./support/axe.js";
import { installBuildScreensFake, makeAssistant } from "./support/buildScreensFake.js";

describe("Install screen", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/install");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows three numbered steps in order", async () => {
    installBuildScreensFake();
    render(<App />);
    await screen.findByRole("heading", { name: "Copy the snippet" });
    const steps = document.querySelectorAll("ol.install-steps > li");
    expect(Array.from(steps, (li) => li.querySelector("h2")?.textContent)).toEqual([
      "Check the websites that may show the chat",
      "Copy the snippet",
      "Check it works",
    ]);
  });

  it("lists the same websites as Widget and links there instead of editing them", async () => {
    installBuildScreensFake({
      assistants: [
        makeAssistant("ast_1", "Docs Bot", ["https://docs.example.com", "https://www.example.com"]),
      ],
    });
    render(<App />);
    const list = await screen.findByRole("list", { name: "Websites that may show the chat" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["https://docs.example.com", "https://www.example.com"]);
    expect(document.querySelector("ol.install-steps textarea:not([readonly])")).toBeNull();

    const link = screen.getByRole("link", { name: "Change this list on the Widget screen" });
    expect(link.getAttribute("href")).toBe("/admin/widget");
    fireEvent.click(link);
    expect(await screen.findByLabelText("Websites that may show the chat")).toBeTruthy();
    expect(window.location.pathname).toBe("/admin/widget");
  });

  it("says where the widget was last seen, from real data", async () => {
    installBuildScreensFake({
      lastSeen: { pageUrl: "https://docs.example.com/x?ref=1", at: Date.now() - 3_600_000 },
    });
    render(<App />);
    const seen = await screen.findByText(/We have seen the widget load on/);
    expect(seen.textContent).toContain("docs.example.com/x");
    expect(seen.textContent).toContain("1 hour ago");
    // A visitor's browser sent that URL, so it is text, never a link.
    expect(seen.querySelector("a")).toBeNull();
    expect(screen.queryByText("Not seen yet")).toBeNull();
  });

  it("says Not seen yet when no visitor has written from the site", async () => {
    installBuildScreensFake({ lastSeen: null });
    render(<App />);
    expect(await screen.findByText("Not seen yet")).toBeTruthy();
    expect(screen.queryByText(/We have seen the widget load on/)).toBeNull();
  });

  it("keeps platform notes and developer details collapsed until opened", async () => {
    installBuildScreensFake();
    render(<App />);
    await screen.findByRole("heading", { name: "Copy the snippet" });
    const summaries = Array.from(document.querySelectorAll(".platform-notes details > summary"));
    expect(summaries.map((s) => s.textContent)).toEqual([
      "Plain HTML",
      "WordPress",
      "Shopify",
      "Next.js",
    ]);
    for (const summary of summaries) {
      expect((summary.parentElement as HTMLDetailsElement).open).toBe(false);
    }
    const next = summaries[3]?.parentElement as HTMLDetailsElement;
    expect(next.textContent).toContain('<solv-chat assistant="pk_ast_1"></solv-chat>');
    expect(next.textContent).toContain('<Script src="https://example.com/widget.js" />');

    const developers = screen.getByText("For developers").closest("details");
    expect(developers?.open).toBe(false);
    expect(developers?.textContent).toContain("--assistant ast_1");
  });

  it("asks before rotating the ingest key, and Cancel sends nothing", async () => {
    const server = installBuildScreensFake();
    render(<App />);
    const developers = (await screen.findByText("For developers")).closest("details");
    if (!developers) throw new Error("no For developers section");
    developers.open = true;

    fireEvent.click(screen.getByRole("button", { name: "Rotate ingest key" }));
    const dialog = await screen.findByRole("dialog", { name: "Rotate the ingest key?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls.some((c) => c.path.endsWith("/ingest-key"))).toBe(false);
    expect(screen.queryByLabelText("New ingest key")).toBeNull();
  });

  it("shows an error with Try again when the install details cannot load", async () => {
    const server = installBuildScreensFake({ failing: ["/api/admin/assistants/ast_1/install"] });
    render(<App />);
    expect(await screen.findByText("Could not load the install details.")).toBeTruthy();
    server.recover();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Copy the snippet" })).toBeTruthy();
  });

  it("has no serious accessibility problems", async () => {
    installBuildScreensFake({ lastSeen: { pageUrl: "https://docs.example.com/", at: Date.now() } });
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Check it works" });
    await expectNoSeriousA11yViolations(container);
  });
});
