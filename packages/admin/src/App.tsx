import { useMemo, useState } from "react";
import { ApiError } from "./api/client.js";
import type { Assistant } from "./api/types.js";
import { useResource } from "./api/useResource.js";
import {
  ADMIN_API_HELPERS,
  type MountAdminOptions,
  type ResolvedAdminConfig,
  resolveAdminConfig,
} from "./extension.js";
import { type BuiltinScreenId, useRoute } from "./routing.js";
import { Behaviour } from "./screens/Behaviour.js";
import { Conversations } from "./screens/Conversations.js";
import { Gaps } from "./screens/Gaps.js";
import { Install } from "./screens/Install.js";
import { Login } from "./screens/Login.js";
import { Overview } from "./screens/Overview.js";
import { Providers } from "./screens/Providers.js";
import { Reports } from "./screens/Reports.js";
import { Sources } from "./screens/Sources.js";
import { Tests } from "./screens/Tests.js";
import { Tools } from "./screens/Tools.js";
import { Widget } from "./screens/Widget.js";
import { AssistantSwitcher, type CreatedIngestKey } from "./shell/AssistantSwitcher.js";
import { FirstRun } from "./shell/FirstRun.js";
import { Navigation } from "./shell/Navigation.js";
import type { CreatedAssistant } from "./shell/NewAssistantForm.js";
import { TryItPane } from "./shell/TryItPane.js";
import { AssistantMutationsProvider } from "./shell/useAssistantMutations.js";
import { useSession } from "./shell/useSession.js";

function renderBuiltinScreen(screen: BuiltinScreenId, assistantId: string) {
  switch (screen) {
    case "overview":
      return <Overview key={assistantId} assistantId={assistantId} />;
    case "reports":
      return <Reports key={assistantId} assistantId={assistantId} />;
    case "conversations":
      return <Conversations key={assistantId} assistantId={assistantId} />;
    case "gaps":
      return <Gaps key={assistantId} assistantId={assistantId} />;
    case "sources":
      return <Sources key={assistantId} assistantId={assistantId} />;
    case "tools":
      return <Tools key={assistantId} assistantId={assistantId} />;
    case "behaviour":
      return <Behaviour key={assistantId} assistantId={assistantId} />;
    case "widget":
      return <Widget key={assistantId} assistantId={assistantId} />;
    case "tests":
      return <Tests key={assistantId} assistantId={assistantId} />;
    case "install":
      return <Install key={assistantId} assistantId={assistantId} />;
    case "providers":
      return <Providers />;
  }
}

function AdminShell({
  config,
  onSignOut,
}: {
  config: ResolvedAdminConfig;
  onSignOut: () => Promise<void>;
}) {
  const { screen, navigate } = useRoute(config.navItems, config.defaultScreen);
  const assistantsRes = useResource<{ assistants: Assistant[] }>("/api/admin/assistants");
  const assistants = assistantsRes.value?.assistants ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedIngestKey | null>(null);

  function handleCreated({ assistant, ingestKey }: CreatedAssistant) {
    // Merge into the latest list: two create forms can have requests in flight at once.
    assistantsRes.setValue((prev) => {
      const current = prev?.assistants ?? [];
      if (current.some((a) => a.id === assistant.id)) return prev ?? { assistants: current };
      return { assistants: [...current, assistant] };
    });
    setSelectedId(assistant.id);
    setCreatedKey(ingestKey ? { assistantId: assistant.id, ingestKey } : null);
  }

  function handleFirstRunCreated(created: CreatedAssistant) {
    handleCreated(created);
    const sources = config.navItems.find((item) => item.id === "sources");
    if (sources) navigate(sources.path);
  }

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await onSignOut();
    } catch (err) {
      setSignOutError(err instanceof ApiError ? err.message : "Could not sign out. Try again.");
    } finally {
      setSigningOut(false);
    }
  }

  const effectiveSelectedId =
    selectedId !== null && assistants.some((a) => a.id === selectedId)
      ? selectedId
      : (assistants[0]?.id ?? null);
  const selectedAssistant = assistants.find((a) => a.id === effectiveSelectedId) ?? null;
  const ExtraScreen =
    screen !== null && config.extraScreenIds.has(screen) ? config.extraScreens[screen] : undefined;
  // Host screens registered with `assistantScoped: false` hide the assistant chrome.
  const assistantChrome = !(ExtraScreen && screen !== null && config.unscopedScreenIds.has(screen));
  const HeaderStart = config.headerStart;
  const HeaderEnd = config.headerEnd;

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-brand">solv.chat</div>
        {HeaderStart && (
          <div className="shell-header-slot">
            <HeaderStart api={ADMIN_API_HELPERS} />
          </div>
        )}
        {/* Hidden, not unmounted, on unscoped screens so a half-filled form survives. */}
        <AssistantSwitcher
          assistants={assistants}
          selectedId={effectiveSelectedId}
          onSelect={setSelectedId}
          onCreated={handleCreated}
          createdKey={createdKey}
          onDismissKey={() => setCreatedKey(null)}
          hidden={!assistantChrome}
        />
        {!assistantChrome && <div className="shell-header-spacer" />}
        {HeaderEnd && (
          <div className="shell-header-slot">
            <HeaderEnd api={ADMIN_API_HELPERS} />
          </div>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={signingOut}
          onClick={() => void handleSignOut()}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </header>
      {signOutError && (
        <div className="shell-alert" role="alert">
          <p className="error-text">{signOutError}</p>
        </div>
      )}

      <div className={assistantChrome ? "shell-body" : "shell-body shell-body-unscoped"}>
        <Navigation current={screen} onNavigate={navigate} items={config.navItems} />

        <AssistantMutationsProvider>
          <main className="shell-main">
            {ExtraScreen ? (
              <ExtraScreen
                assistant={selectedAssistant}
                assistantId={selectedAssistant?.id ?? null}
                api={ADMIN_API_HELPERS}
              />
            ) : screen === null ? (
              <div className="screen">
                <p className="muted">No screens available.</p>
              </div>
            ) : screen === "providers" ? (
              <Providers />
            ) : assistantsRes.status === "loading" && assistants.length === 0 ? (
              <p className="muted">Loading assistants…</p>
            ) : assistantsRes.status === "error" ? (
              <p className="error-text" role="alert">
                {assistantsRes.error}
              </p>
            ) : selectedAssistant === null ? (
              <FirstRun onCreated={handleFirstRunCreated} />
            ) : (
              renderBuiltinScreen(screen as BuiltinScreenId, selectedAssistant.id)
            )}
          </main>
        </AssistantMutationsProvider>

        {/* Mounted once outside <main> so moving between screens keeps the transcript.
            Unscoped screens hide it rather than unmount it, for the same reason. */}
        {selectedAssistant !== null && (
          <TryItPane assistant={selectedAssistant} hidden={!assistantChrome} />
        )}
      </div>
    </div>
  );
}

export interface AppProps {
  options?: MountAdminOptions;
  /** @internal Pre-resolved config passed by `mountAdmin`. */
  config?: ResolvedAdminConfig;
}

export function App({ options, config: preResolved }: AppProps = {}) {
  const resolved = useMemo(
    () => preResolved ?? resolveAdminConfig(options),
    [preResolved, options],
  );
  const session = useSession(resolved.onSignOut);

  if (session.state === "loading") {
    return <p className="loading-screen">Loading…</p>;
  }

  if (session.state === "signed-out") {
    const SignIn = resolved.signIn ?? Login;
    return <SignIn onSignedIn={session.refresh} />;
  }

  if (session.state === "unavailable") {
    return (
      <div className="loading-screen" role="alert">
        <p>Could not reach the server.</p>
        <button type="button" onClick={session.refresh}>
          Try again
        </button>
      </div>
    );
  }

  return <AdminShell config={resolved} onSignOut={session.signOut} />;
}
