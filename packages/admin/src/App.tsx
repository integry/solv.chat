import { useState } from "react";
import { ApiError } from "./api/client.js";
import type { Assistant } from "./api/types.js";
import { useResource } from "./api/useResource.js";
import { NAV_ITEMS, type ScreenId, useRoute } from "./routing.js";
import { Behaviour } from "./screens/Behaviour.js";
import { Login } from "./screens/Login.js";
import { Placeholder } from "./screens/Placeholder.js";
import { Widget } from "./screens/Widget.js";
import { AssistantSwitcher } from "./shell/AssistantSwitcher.js";
import { Navigation } from "./shell/Navigation.js";
import { TryItPane } from "./shell/TryItPane.js";
import { useSession } from "./shell/useSession.js";

function renderScreen(screen: ScreenId, assistantId: string) {
  switch (screen) {
    case "behaviour":
      return <Behaviour key={assistantId} assistantId={assistantId} />;
    case "widget":
      return <Widget key={assistantId} assistantId={assistantId} />;
    default: {
      const item = NAV_ITEMS.find((n) => n.id === screen);
      return <Placeholder title={item?.label ?? "Overview"} />;
    }
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

        <main className="shell-main">
          {assistantsRes.status === "loading" && assistants.length === 0 ? (
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

  return <AdminShell onSignOut={session.signOut} />;
}
