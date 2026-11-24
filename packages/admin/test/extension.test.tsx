import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AdminMount,
  type Assistant,
  type BuiltinScreenId,
  type ExtraScreenProps,
  mountAdmin,
  type SignInProps,
} from "../src/index.js";
import { matchScreen, NAV_ITEMS, useRoute } from "../src/routing.js";

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

function installMockFetch(options: { signedIn?: boolean; assistants?: Assistant[] } = {}) {
  let signedIn = options.signedIn ?? true;
  const assistants = options.assistants ?? [makeAssistant("ast_1", "Docs Bot")];
  let forceNext401 = false;

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "https://example.com").pathname;

    if (!signedIn || forceNext401) {
      forceNext401 = false;
      return Response.json({ error: "Sign in first." }, { status: 401 });
    }

    if (path === "/api/admin/assistants") {
      return Response.json({ assistants });
    }

    if (path.endsWith("/overview")) {
      return Response.json({
        todayCostMicros: 0,
        topQuestions: [],
      });
    }

    if (path === "/api/admin/account") {
      return Response.json({ plan: "Pro" });
    }

    return Response.json({ ok: true });
  });

  vi.stubGlobal("fetch", fetchMock);

  return {
    setSignedIn(value: boolean) {
      signedIn = value;
    },
    triggerNext401() {
      forceNext401 = true;
    },
    fetchMock,
  };
}

let activeMount: AdminMount | null = null;
let container: HTMLDivElement | null = null;
let lastCapturedProps: ExtraScreenProps | null = null;
let onCustomSignInClick: (() => void) | null = null;

function AccountScreen(props: ExtraScreenProps) {
  lastCapturedProps = props;
  const profile = props.api.useResource<{ plan: string }>("/api/admin/account");
  return (
    <div className="screen">
      <h1>Account</h1>
      <p data-testid="assistant-id">{props.assistantId ?? "none"}</p>
      <p data-testid="assistant-name">{props.assistant?.name ?? "none"}</p>
      <p data-testid="plan">{profile.value?.plan ?? "loading"}</p>
    </div>
  );
}

function DummyScreen() {
  return <div>Dummy</div>;
}

function RouteProbe() {
  const { screen: current, navigate } = useRoute();
  return (
    <div>
      <span data-testid="current-screen">{current}</span>
      <button type="button" onClick={() => navigate("/admin/custom/../providers?from=test#top")}>
        Go
      </button>
    </div>
  );
}

function CustomSignIn({ onSignedIn }: SignInProps) {
  return (
    <div>
      <h1>Cloud Sign In</h1>
      <button
        type="button"
        onClick={() => {
          onCustomSignInClick?.();
          onSignedIn();
        }}
      >
        Continue with SSO
      </button>
    </div>
  );
}

function mountIntoDom(options?: Parameters<typeof mountAdmin>[1]): AdminMount {
  container = document.createElement("div");
  document.body.appendChild(container);
  let handle!: AdminMount;
  act(() => {
    handle = mountAdmin(container as HTMLElement, options);
  });
  activeMount = handle;
  return handle;
}

describe("admin extension point", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/overview");
    lastCapturedProps = null;
    onCustomSignInClick = null;
  });

  afterEach(() => {
    if (activeMount) {
      act(() => {
        activeMount?.unmount();
      });
      activeMount = null;
    }
    container?.remove();
    container = null;
    cleanup();
    vi.unstubAllGlobals();
  });

  it("mounts with no options and renders identical navigation and routes", async () => {
    installMockFetch();
    mountIntoDom();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    });

    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.map((a) => a.textContent)).toEqual(NAV_ITEMS.map((item) => item.label));
    // The organisation's screens open without an assistant in the address.
    expect(links.map((a) => a.getAttribute("href"))).toEqual(
      NAV_ITEMS.map((item) =>
        item.section === "Settings" ? item.path : `${item.path}?assistant=ast_1`,
      ),
    );
    const sectionLabels = Array.from(nav.querySelectorAll("h2.nav-section-label")).map(
      (el) => el.textContent,
    );
    expect(sectionLabels).toEqual(["Monitor", "Build", "Go live", "Settings"]);
  });

  it("adds an extra nav item in the given section, routes to it, and passes props", async () => {
    installMockFetch();

    mountIntoDom({
      extraNavItems: [
        { id: "account", label: "Account", path: "/admin/account", section: "Account" },
      ],
      extraScreens: {
        account: AccountScreen,
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    });

    const nav = screen.getByRole("navigation", { name: "Primary" });
    const sectionLabels = Array.from(nav.querySelectorAll(".nav-section-label")).map(
      (el) => el.textContent,
    );
    expect(sectionLabels).toEqual(["Monitor", "Build", "Go live", "Settings", "Account"]);

    const accountLink = screen.getByRole("link", { name: "Account" });
    expect(accountLink.getAttribute("href")).toBe("/admin/account");

    fireEvent.click(accountLink);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Account", level: 1 })).toBeTruthy();
      expect(screen.getByTestId("plan").textContent).toBe("Pro");
    });

    expect(window.location.pathname).toBe("/admin/account");
    expect(screen.getByTestId("assistant-id").textContent).toBe("ast_1");
    expect(screen.getByTestId("assistant-name").textContent).toBe("Docs Bot");

    expect(lastCapturedProps?.api.getJson).toBeTypeOf("function");
    expect(lastCapturedProps?.api.postJson).toBeTypeOf("function");
    expect(lastCapturedProps?.api.putJson).toBeTypeOf("function");
    expect(lastCapturedProps?.api.patchJson).toBeTypeOf("function");
    expect(lastCapturedProps?.api.deleteJson).toBeTypeOf("function");
    expect(lastCapturedProps?.api.apiFetch).toBeTypeOf("function");
    expect(lastCapturedProps?.api.useResource).toBeTypeOf("function");
  });

  it("renders extra screens even when the org has no assistants", async () => {
    installMockFetch({ assistants: [] });
    window.history.replaceState(null, "", "/admin/account");

    mountIntoDom({
      extraNavItems: [{ id: "account", label: "Account", path: "/admin/account" }],
      extraScreens: { account: AccountScreen },
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Account", level: 1 })).toBeTruthy();
    });
    expect(screen.getByTestId("assistant-id").textContent).toBe("none");
  });

  it("throws on built-in id or path clashes at mount time", () => {
    const el = document.createElement("div");

    expect(() =>
      mountAdmin(el, {
        extraNavItems: [{ id: "overview", label: "Custom Overview", path: "/admin/custom" }],
        extraScreens: { overview: DummyScreen },
      }),
    ).toThrow(/clashes with a built-in screen id/i);

    expect(() =>
      mountAdmin(el, {
        extraNavItems: [{ id: "custom", label: "Custom", path: "/admin/providers/" }],
        extraScreens: { custom: DummyScreen },
      }),
    ).toThrow(/clashes with a built-in route/i);

    expect(() =>
      mountAdmin(el, {
        hideScreens: ["providers"],
        extraNavItems: [{ id: "providers", label: "My Providers", path: "/admin/my-providers" }],
        extraScreens: { providers: DummyScreen },
      }),
    ).toThrow(/clashes with a built-in screen id/i);

    expect(() =>
      mountAdmin(el, {
        extraScreens: { tools: DummyScreen },
      }),
    ).toThrow(/cannot override built-in admin screen "tools"/i);

    expect(() =>
      mountAdmin(el, {
        extraNavItems: [{ id: "outside", label: "Outside", path: "/other/page" }],
        extraScreens: { outside: DummyScreen },
      }),
    ).toThrow(/must have a path under "\/admin\/"/i);

    render(<div />);
  });

  it("replaces the password form with custom signIn on 401 and calls onSignOut", async () => {
    const server = installMockFetch({ signedIn: false });
    const onSignOut = vi.fn(async () => {
      server.setSignedIn(false);
    });
    onCustomSignInClick = () => {
      server.setSignedIn(true);
    };

    mountIntoDom({ signIn: CustomSignIn, onSignOut });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Cloud Sign In" })).toBeTruthy();
    });
    expect(screen.queryByLabelText("Password")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue with SSO" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Cloud Sign In" })).toBeTruthy();
    });
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("hideScreens removes the nav item and its route", async () => {
    installMockFetch();
    window.history.replaceState(null, "", "/admin/providers");

    mountIntoDom({
      hideScreens: ["providers"],
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    });

    expect(screen.queryByRole("link", { name: "Providers" })).toBeNull();
    expect(screen.getByRole("link", { name: "MCP access" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Providers" })).toBeNull();
  });

  it("rejects noncanonical, query, fragment, and protocol-relative extension paths", () => {
    const el = document.createElement("div");

    for (const badPath of [
      "/admin/custom/../providers",
      "/admin/custom/../account",
      "/admin/./account",
      "/admin\\..\\providers",
      "//evil.com/admin/account",
      "/admin/account?tab=1",
      "/admin/account#section",
    ]) {
      expect(() =>
        mountAdmin(el, {
          extraNavItems: [{ id: "custom", label: "Custom", path: badPath }],
          extraScreens: { custom: DummyScreen },
        }),
      ).toThrow();
    }
  });

  it("matches navigate against browser-normalized window.location.pathname", () => {
    render(<RouteProbe />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(window.location.pathname).toBe("/admin/providers");
    expect(screen.getByTestId("current-screen").textContent).toBe("providers");
  });

  it("renders an empty state without restoring Overview when all built-in screens are hidden", async () => {
    installMockFetch();
    window.history.replaceState(null, "", "/admin/overview");

    const allBuiltinIds = NAV_ITEMS.map((item) => item.id as BuiltinScreenId);
    expect(matchScreen("/admin/overview", [])).toBeNull();

    mountIntoDom({
      hideScreens: allBuiltinIds,
    });

    await waitFor(() => {
      expect(screen.getByText("No screens available.")).toBeTruthy();
    });

    expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.querySelectorAll("a")).toHaveLength(0);
  });
});
