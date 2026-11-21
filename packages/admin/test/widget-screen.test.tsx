/**
 * @vitest-environment-options {"settings": {"disableJavaScriptFileLoading": true, "handleDisabledFileLoadingAsSuccess": true, "navigation": {"disableChildFrameNavigation": true}}}
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ADMIN_PREVIEW_CSP } from "@solvchat/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { contrastRatio } from "../src/ui/color.js";
import { installBuildScreensFake } from "./support/buildScreensFake.js";

const ORIGINS = "Websites that may show the chat";

function previewFrame(): HTMLIFrameElement {
  const frame = document.querySelector<HTMLIFrameElement>("iframe.widget-preview-frame");
  if (!frame) throw new Error("no preview frame");
  return frame;
}

describe("Widget screen", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/widget");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("checks each website line as it is typed, with the API's wording and an example", async () => {
    installBuildScreensFake();
    render(<App />);
    const origins = (await screen.findByLabelText(ORIGINS)) as HTMLTextAreaElement;
    expect(screen.getByText(/for example https:\/\/www\.example\.com/)).toBeTruthy();

    fireEvent.change(origins, {
      target: {
        value: "https://docs.example.com\n\nwww.example.com\nhttps://shop.example.com/cart",
      },
    });
    expect(
      screen.getByText(
        "Line 3 (www.example.com): must be an absolute URL such as https://example.com",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Line 4 (https://shop.example.com/cart): must be an origin only, with no path",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/^Line 1 /)).toBeNull();
    expect(origins.getAttribute("aria-describedby")).toContain("widget-origins-problems");

    fireEvent.change(origins, {
      target: { value: "https://docs.example.com\nhttps://example.com" },
    });
    expect(screen.queryByText(/^Line \d/)).toBeNull();
    expect(origins.getAttribute("aria-invalid")).toBe("false");
  });

  it("warns when white text on the accent colour is hard to read", async () => {
    installBuildScreensFake();
    render(<App />);
    const accent = (await screen.findByLabelText("Accent colour")) as HTMLInputElement;

    fireEvent.change(accent, { target: { value: "#1d4ed8" } });
    expect(screen.queryByText(/hard to read/)).toBeNull();

    fireEvent.change(accent, { target: { value: "#ffff00" } });
    const ratio = contrastRatio("#ffff00", "#ffffff")?.toFixed(1);
    expect(screen.getByText(new RegExp(`contrast\\s+${ratio}:1`))).toBeTruthy();
    expect(screen.getByText(/hard to read/)).toBeTruthy();
  });

  it("fills the colour field from the colour picker", async () => {
    installBuildScreensFake();
    render(<App />);
    const accent = (await screen.findByLabelText("Accent colour")) as HTMLInputElement;
    const picker = screen.getByLabelText("Pick accent colour") as HTMLInputElement;
    expect(picker.type).toBe("color");

    fireEvent.change(picker, { target: { value: "#0f766e" } });
    expect(accent.value).toBe("#0f766e");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("renders the preview in a sandboxed frame that cannot make requests", async () => {
    installBuildScreensFake();
    render(<App />);
    await screen.findByLabelText("Title");
    const frame = previewFrame();

    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("title")).toBe("Preview of the chat on your site");
    // A same-origin static page, not srcdoc: a srcdoc frame inherits the
    // admin's policy, which blocks inline script and style.
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame.getAttribute("src")).toBe("/admin/preview.html");
  });

  it("ships a preview page with no inline script or style and a policy that allows no requests", () => {
    const publicDir = path.resolve(import.meta.dirname, "../public");
    const page = readFileSync(path.join(publicDir, "preview.html"), "utf8");
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(page)?.[1];
    expect(csp).toBe(ADMIN_PREVIEW_CSP);
    expect(csp).not.toContain("connect-src");
    expect(csp).not.toContain("unsafe-inline");
    // Every script and stylesheet is a file, so script-src/style-src 'self' allow them.
    expect(page).not.toMatch(/<style/);
    expect(page.match(/<script\b[^>]*>/g)).toEqual([
      '<script src="/widget.js">',
      '<script src="preview.js">',
    ]);
    expect(page).toContain('<link rel="stylesheet" href="preview.css">');
    // No assistant key in the frame, so the widget has nothing to send.
    expect(page).toContain("<solv-chat></solv-chat>");
    expect(page).not.toContain("assistant=");
  });

  it("sends the form's values to the preview once it is ready, and again on each change", async () => {
    installBuildScreensFake();
    render(<App />);
    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    const frame = previewFrame();
    const frameWindow = frame.contentWindow;
    if (!frameWindow) throw new Error("no frame window");
    const post = vi.spyOn(frameWindow, "postMessage").mockImplementation(() => {});

    // A message from anywhere else is not the frame saying it is ready.
    window.dispatchEvent(
      new MessageEvent("message", { data: "solv-preview-ready", source: window }),
    );
    expect(post).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", { data: "solv-preview-ready", source: frameWindow }),
    );
    await waitFor(() => expect(post).toHaveBeenCalled());
    const first = post.mock.calls.at(-1)?.[0] as {
      widget: { title: string; accentColor: string; position: string; allowExpand: boolean };
      behaviour: { greeting: string; suggestedQuestions: string[] };
    };
    expect(first.widget).toEqual({
      title: "Ask a question",
      accentColor: "#2563eb",
      position: "right",
      allowExpand: true,
    });
    expect(first.behaviour.suggestedQuestions).toEqual(["First?", "Second?", "Third?"]);

    fireEvent.change(title, { target: { value: "Help desk" } });
    fireEvent.change(screen.getByLabelText("Accent colour"), { target: { value: "#0f766e" } });
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "left" } });
    await waitFor(() => {
      const last = post.mock.calls.at(-1)?.[0] as { widget: Record<string, unknown> };
      expect(last.widget).toEqual({
        title: "Help desk",
        accentColor: "#0f766e",
        position: "left",
        allowExpand: true,
      });
    });

    // An unfinished colour keeps the last valid one in the preview.
    fireEvent.change(screen.getByLabelText("Accent colour"), { target: { value: "#0f7" } });
    await waitFor(() => {
      const last = post.mock.calls.at(-1)?.[0] as { widget: Record<string, string> };
      expect(last.widget.accentColor).toBe("#2563eb");
    });
  });

  it("offers expanding to a side panel by default, previews and saves the choice", async () => {
    const fake = installBuildScreensFake();
    render(<App />);
    const toggle = (await screen.findByLabelText(
      "Allow expanding to a side panel",
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    // The help text says what it does to the owner's page.
    const hint = document.getElementById(toggle.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toMatch(/Your page moves over to make room/);

    const frameWindow = previewFrame().contentWindow;
    if (!frameWindow) throw new Error("no frame window");
    const post = vi.spyOn(frameWindow, "postMessage").mockImplementation(() => {});
    window.dispatchEvent(
      new MessageEvent("message", { data: "solv-preview-ready", source: frameWindow }),
    );
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    await waitFor(() => {
      const last = post.mock.calls.at(-1)?.[0] as { widget: { allowExpand: boolean } };
      expect(last.widget.allowExpand).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const put = fake.calls.find((c) => c.method === "PUT" && c.path.endsWith("/draft"));
      expect((put?.body as { widget?: { allowExpand?: boolean } })?.widget?.allowExpand).toBe(
        false,
      );
    });
    await waitFor(() =>
      expect([...fake.drafts.values()][0]?.config.widget.allowExpand).toBe(false),
    );
  });

  it("explains page help in plain words and keeps it off by default", async () => {
    installBuildScreensFake();
    render(<App />);
    const toggle = (await screen.findByLabelText(
      "Let the assistant help on the page",
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    const region = screen.getByRole("region", { name: "Help on the page" });
    expect(region.textContent).toContain("the visitor always makes the final click");
    expect(region.querySelectorAll("li")).toHaveLength(3);
  });

  it("shows an error with Try again when settings cannot load, and recovers", async () => {
    const server = installBuildScreensFake({ failing: ["/api/admin/assistants/ast_1/draft"] });
    render(<App />);
    expect(await screen.findByText("Could not load your widget settings.")).toBeTruthy();
    server.recover();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Title")).toBeTruthy();
  });

  it("has no serious accessibility problems", async () => {
    installBuildScreensFake();
    const { container } = render(<App />);
    await screen.findByLabelText("Title");
    fireEvent.change(screen.getByLabelText(ORIGINS), { target: { value: "nope" } });
    // Same rules as support/axe.ts. The preview frame's own page is the widget
    // package (with its own tests); axe cannot reach into a sandboxed frame here.
    const results = await axe.run(container, {
      iframes: false,
      resultTypes: ["violations"],
      rules: {
        "color-contrast": { enabled: false },
        "document-title": { enabled: false },
        "html-has-lang": { enabled: false },
      },
    });
    const serious = results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
    expect(serious).toEqual([]);
  });
});
