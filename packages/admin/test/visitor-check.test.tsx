/**
 * @vitest-environment-options {"settings": {"disableJavaScriptFileLoading": true, "handleDisabledFileLoadingAsSuccess": true, "navigation": {"disableChildFrameNavigation": true}}}
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { installBuildScreensFake } from "./support/buildScreensFake.js";

describe("visitor check in the admin", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/install");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("warns on every screen that visitor chat is unprotected when the check is off", async () => {
    installBuildScreensFake({ visitorCheck: { state: "off", missing: [] } });
    render(<App />);
    const warning = await screen.findByText(/Visitor chat is not protected\./);
    expect(warning.closest("[role=status]")?.textContent).toContain("SOLV_TURNSTILE_SITE_KEY");
    expect(warning.closest(".shell-check-alert")?.closest("main")).toBeNull();
  });

  it("says test keys let everyone through", async () => {
    installBuildScreensFake({ visitorCheck: { state: "test_keys", missing: [] } });
    render(<App />);
    expect(await screen.findByText(/uses Turnstile's\s+test keys/)).toBeTruthy();
  });

  it("names what is missing when the check is half set up", async () => {
    installBuildScreensFake({
      visitorCheck: { state: "misconfigured", missing: ["secret", "secret_key"] },
    });
    render(<App />);
    const alert = (await screen.findByText(/turning every visitor away/)).closest("[role=alert]");
    expect(alert?.textContent).toContain("SOLV_TURNSTILE_SECRET");
    expect(alert?.textContent).toContain("SOLV_SECRET_KEY");
    expect(alert?.textContent).not.toContain("SOLV_TURNSTILE_SITE_KEY");
  });

  it("shows no warning when the check runs, and the policy and privacy notes on Install", async () => {
    installBuildScreensFake({ visitorCheck: { state: "on", missing: [] } });
    render(<App />);
    const list = await screen.findByRole("list", { name: "Content-Security-Policy additions" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "script-src https://example.com",
      "connect-src https://example.com",
      "frame-src https://example.com",
    ]);
    expect(
      screen.getByRole("heading", { name: "Tell visitors about the security check" }),
    ).toBeTruthy();
    const link = screen.getByRole("link", { name: "Cloudflare's Turnstile privacy addendum" });
    expect(link.getAttribute("href")).toBe("https://www.cloudflare.com/turnstile-privacy-policy/");
    expect(screen.queryByText(/Visitor chat is not protected/)).toBeNull();
  });

  it("leaves the privacy note out when no check runs", async () => {
    installBuildScreensFake({ visitorCheck: { state: "off", missing: [] } });
    render(<App />);
    await screen.findByRole("list", { name: "Content-Security-Policy additions" });
    expect(
      screen.queryByRole("heading", { name: "Tell visitors about the security check" }),
    ).toBeNull();
  });
});
