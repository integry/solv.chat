import { useState } from "react";
import { ApiError } from "./api/client.js";
import type { Assistant } from "./api/types.js";
import { useResource } from "./api/useResource.js";
import { type ScreenId, useRoute } from "./routing.js";
import { Behaviour } from "./screens/Behaviour.js";
import { Conversations } from "./screens/Conversations.js";
import { Gaps } from "./screens/Gaps.js";
import { Install } from "./screens/Install.js";
import { Login } from "./screens/Login.js";
import { Overview } from "./screens/Overview.js";
import { Providers } from "./screens/Providers.js";
import { Sources } from "./screens/Sources.js";
import { Tools } from "./screens/Tools.js";
import { Widget } from "./screens/Widget.js";
import { AssistantSwitcher } from "./shell/AssistantSwitcher.js";
import { Navigation } from "./shell/Navigation.js";
import { TryItPane } from "./shell/TryItPane.js";
import { AssistantMutationsProvider } from "./shell/useAssistantMutations.js";
import { useSession } from "./shell/useSession.js";

function renderScreen(screen: ScreenId, assistantId: string) {
  switch (screen) {
    case "overview":
      return <Overview key={assistantId} assistantId={assistantId} />;
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
    case "install":
      return <Install key={assistantId} assistantId={assistantId} />;
    case "providers":
      return <Providers />;
  }
}

function AdminShell({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const { screen, navigate } = useRoute();
  const assistantsRes = useResource<{ assistants: Assistant[] }>("/api/admin/assistants");
  const assistants = assistantsRes.value?.assistants ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

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

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-brand">solv.chat</div>
        <AssistantSwitcher
          assistants={assistants}
          selectedId={effectiveSelectedId}
          onSelect={setSelectedId}
          onCreated={(created) => {
            assistantsRes.setValue({ assistants: [...assistants, created] });
            setSelectedId(created.id);
          }}
        />
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

      <div className="shell-body">
        <Navigation current={screen} onNavigate={navigate} />

        <AssistantMutationsProvider>
          <main className="shell-main">
            {screen === "providers" ? (
              <Providers />
            ) : assistantsRes.status === "loading" && assistants.length === 0 ? (
              <p className="muted">Loading assistants…</p>
            ) : assistantsRes.status === "error" ? (
              <p className="error-text" role="alert">
                {assistantsRes.error}
              </p>
            ) : selectedAssistant === null ? (
              <div className="screen">
                <p className="muted">Create an assistant to begin.</p>
              </div>
            ) : (
              renderScreen(screen, selectedAssistant.id)
            )}
          </main>
        </AssistantMutationsProvider>

        {/* Mounted once outside <main> so moving between screens keeps the transcript. */}
        {selectedAssistant !== null && <TryItPane assistant={selectedAssistant} />}
      </div>
    </div>
  );
}

export function App() {
  const session = useSession();

  if (session.state === "loading") {
    return <p className="loading-screen">Loading…</p>;
  }

  if (session.state === "signed-out") {
    return <Login onSignedIn={session.refresh} />;
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

  return <AdminShell onSignOut={session.signOut} />;
}
