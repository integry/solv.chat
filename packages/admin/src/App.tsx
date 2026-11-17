import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "./api/client.js";
import type { Assistant } from "./api/types.js";
import { useResource } from "./api/useResource.js";
import {
  ADMIN_API_HELPERS,
  type MountAdminOptions,
  type ResolvedAdminConfig,
  resolveAdminConfig,
} from "./extension.js";
import {
  type AdminNavigation,
  AdminNavigationContext,
  assistantPath,
  BUILD_SCREENS,
  type BuiltinScreenId,
  MONITOR_SCREENS,
  useRoute,
  withAssistant,
} from "./routing.js";
import { Behaviour } from "./screens/Behaviour.js";
import { Conversations } from "./screens/Conversations.js";
import { Gaps } from "./screens/Gaps.js";
import { Install } from "./screens/Install.js";
import { Login } from "./screens/Login.js";
import { Overview } from "./screens/Overview.js";
import { OPEN_TRY_IT_EVENT } from "./screens/OverviewParts.js";
import { Providers } from "./screens/Providers.js";
import { Reports } from "./screens/Reports.js";
import { Sources } from "./screens/Sources.js";
import { Tests } from "./screens/Tests.js";
import { Tools } from "./screens/Tools.js";
import { Widget } from "./screens/Widget.js";
import {
  AssistantSwitcher,
  type CreatedIngestKey,
  IngestKeyNotice,
} from "./shell/AssistantSwitcher.js";
import { FirstRun } from "./shell/FirstRun.js";
import { Navigation } from "./shell/Navigation.js";
import type { CreatedAssistant } from "./shell/NewAssistantForm.js";
import { PublishControls } from "./shell/PublishStatus.js";
import { TryItPane } from "./shell/TryItPane.js";
import {
  AssistantMutationsProvider,
  useAnySaveRunning,
  useAssistantMutation,
} from "./shell/useAssistantMutations.js";
import { useSession } from "./shell/useSession.js";
import { ConfirmDialog } from "./ui/Dialog.js";
import { useFocusTrap, useMediaQuery } from "./ui/focus.js";
import { Icon } from "./ui/Icon.js";
import { Skeleton } from "./ui/Skeleton.js";
import { ToastProvider } from "./ui/Toast.js";

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

const NARROW_QUERY = "(max-width: 899px)";
const TRY_IT_STORAGE_KEY = "solvchat.admin.tryIt";
const TRY_IT_ID = "try-it-pane";
const DRAWER_ID = "shell-drawer";

type TryItGroup = "monitor" | "build";
type TryItPrefs = Partial<Record<TryItGroup, boolean>>;

function readTryItPrefs(): TryItPrefs {
  try {
    const raw = window.localStorage.getItem(TRY_IT_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const prefs: TryItPrefs = {};
    if (parsed && typeof parsed === "object") {
      for (const group of ["monitor", "build"] as const) {
        const value = (parsed as Record<string, unknown>)[group];
        if (typeof value === "boolean") prefs[group] = value;
      }
    }
    return prefs;
  } catch {
    return {};
  }
}

function writeTryItPrefs(prefs: TryItPrefs) {
  try {
    window.localStorage.setItem(TRY_IT_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be unavailable (private mode, blocked); the choice then lasts this visit.
  }
}

/**
 * Whether the Try it pane is open. Wide screens remember the choice per
 * browser, separately for Monitor screens (closed by default) and the rest
 * (open by default). On narrow screens it is a sheet, opened on demand and
 * closed again on every screen change.
 */
function useTryItOpen(screen: string | null, narrow: boolean) {
  const group: TryItGroup = screen !== null && MONITOR_SCREENS.has(screen) ? "monitor" : "build";
  const [prefs, setPrefs] = useState<TryItPrefs>(readTryItPrefs);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    void screen;
    void narrow;
    setSheetOpen(false);
  }, [screen, narrow]);

  const open = narrow ? sheetOpen : (prefs[group] ?? group !== "monitor");
  const setOpen = useCallback(
    (next: boolean) => {
      if (narrow) {
        setSheetOpen(next);
        return;
      }
      setPrefs((prev) => {
        const updated = { ...prev, [group]: next };
        writeTryItPrefs(updated);
        return updated;
      });
    },
    [narrow, group],
  );
  return { open, setOpen };
}

interface PendingLeave {
  leave: () => void;
}

function AdminShell({
  config,
  onSignOut,
}: {
  config: ResolvedAdminConfig;
  onSignOut: () => Promise<void>;
}) {
  // Set while the owner decides whether to leave a screen with unsaved edits.
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
  const unsavedRef = useRef(false);
  const savingRef = useRef(false);
  // A move asked for while a save runs. It waits for the save: the save can
  // still fail, and leaving then would lose both the edits and the error.
  const deferredLeaveRef = useRef<PendingLeave | null>(null);
  // The router's `restore`, set once the router below exists.
  const restoreRef = useRef<() => void>(() => {});

  /**
   * Runs a move, then puts the address back if a Back or Forward moved it and
   * this move replaced that one (switching assistant keeps the screen on show).
   */
  const proceed = useCallback((pending: PendingLeave) => {
    pending.leave();
    restoreRef.current();
  }, []);

  /**
   * Runs `leave` now, or after the owner agrees to drop unsaved edits.
   * While a save runs, the move waits until the save finishes and is decided then.
   * Staying, whatever the move was, puts the address back with `restore`.
   */
  const guardLeave = useCallback(
    (leave: () => void) => {
      if (savingRef.current) {
        // The newest move replaces an older one still waiting, as below.
        deferredLeaveRef.current = { leave };
      } else if (unsavedRef.current) {
        // A newer request replaces one still on screen.
        setPendingLeave({ leave });
      } else {
        proceed({ leave });
      }
    },
    [proceed],
  );

  const {
    screen,
    assistant: addressAssistant,
    navigate,
    shows,
    restore,
  } = useRoute(config.navItems, config.defaultScreen, guardLeave);
  restoreRef.current = restore;

  /**
   * Asking for the place already on show drops a move still waiting for a
   * save, and undoes a Back or Forward that was waiting with it.
   */
  const stayPut = useCallback(() => {
    deferredLeaveRef.current = null;
    restore();
  }, [restore]);

  /**
   * Moves to another screen once the leave check allows it. The screen on show
   * is not always the one at the address: a Back or Forward can be waiting.
   */
  const moveTo = useCallback(
    (path: string) => {
      if (!shows(path)) {
        guardLeave(() => navigate(path));
      } else if (
        `${window.location.pathname}${window.location.search}` === path ||
        !shows(window.location.pathname)
      ) {
        // Already there, or a Back or Forward is waiting: stay on this screen.
        stayPut();
      } else {
        // Another address of the screen on show (an open conversation, say)
        // leaves nothing behind, so it needs no check.
        deferredLeaveRef.current = null;
        navigate(path);
      }
    },
    [shows, stayPut, guardLeave, navigate],
  );
  const assistantsRes = useResource<{ assistants: Assistant[] }>("/api/admin/assistants");
  const assistants = assistantsRes.value?.assistants ?? [];
  // The address names the assistant on show, so a link, a reload and Back all
  // show the one they were made under. Start from it; an id that is not in the
  // list falls back to the first assistant below.
  const [selectedId, setSelectedId] = useState<string | null>(() => addressAssistant);
  // Back and Forward restore an address, and with it the assistant it names,
  // once the leave check lets them go ahead. An address without one (the bare
  // screen path) keeps the current selection.
  // Followed during render, not in an effect: a screen that checks its
  // address against the assistant on show must never see the two apart.
  const [followedAssistant, setFollowedAssistant] = useState(addressAssistant);
  if (followedAssistant !== addressAssistant) {
    setFollowedAssistant(addressAssistant);
    if (addressAssistant !== null) setSelectedId(addressAssistant);
  }
  // Choosing an assistant writes it into the address too (a new history entry,
  // so Back undoes the switch), and `popstate` tells screens that follow the
  // address: an open conversation of the previous assistant is left behind.
  const selectAssistant = useCallback(
    (id: string) => {
      setSelectedId(id);
      if (shows(window.location.pathname)) {
        navigate(withAssistant(id));
        return;
      }
      // A Back or Forward is waiting, so the address belongs to another
      // screen: the switch keeps the screen on show, at its own address.
      const path = config.navItems.find((item) => item.id === screen)?.path;
      if (path) navigate(assistantPath(path, id));
    },
    [navigate, shows, screen, config.navItems],
  );
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  // A queue, not one slot: two create forms can finish close together, and each key is
  // shown once by the API, so every key stays until the user dismisses it.
  const [createdKeys, setCreatedKeys] = useState<CreatedIngestKey[]>([]);
  const narrow = useMediaQuery(NARROW_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const tryItToggleRef = useRef<HTMLButtonElement>(null);
  // Set when the owner presses "Try it", so only that (not navigation) moves focus.
  const focusTryItRef = useRef(false);
  const tryIt = useTryItOpen(screen, narrow);
  const drawerTrap = useFocusTrap(drawerRef, narrow && drawerOpen, {
    onEscape: () => setDrawerOpen(false),
  });

  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);

  function handleNavigate(path: string) {
    setDrawerOpen(false);
    moveTo(path);
  }

  function handleCreated({ assistant, ingestKey }: CreatedAssistant) {
    // Merge into the latest list: two create forms can have requests in flight at once.
    assistantsRes.setValue((prev) => {
      const current = prev?.assistants ?? [];
      if (current.some((a) => a.id === assistant.id)) return prev ?? { assistants: current };
      return { assistants: [...current, assistant] };
    });
    selectAssistant(assistant.id);
    setDrawerOpen(false);
    if (ingestKey) {
      setCreatedKeys((prev) =>
        prev.some((k) => k.assistantId === assistant.id)
          ? prev
          : [...prev, { assistantId: assistant.id, ingestKey }],
      );
    }
  }

  function handleFirstRunCreated(created: CreatedAssistant) {
    handleCreated(created);
    const sources = config.navItems.find((item) => item.id === "sources");
    if (sources) navigate(assistantPath(sources.path, created.assistant.id));
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

  function closeTryIt() {
    tryIt.setOpen(false);
    tryItToggleRef.current?.focus();
  }

  const effectiveSelectedId =
    selectedId !== null && assistants.some((a) => a.id === selectedId)
      ? selectedId
      : (assistants[0]?.id ?? null);
  const selectedAssistant = assistants.find((a) => a.id === effectiveSelectedId) ?? null;
  const selectedMutation = useAssistantMutation(effectiveSelectedId ?? "");
  const saving = selectedMutation.saving;
  unsavedRef.current = selectedMutation.unsaved;
  savingRef.current = saving;
  const isUnsavedNow = selectedMutation.isUnsavedNow;
  // Once the save finishes, a move that waited for it goes ahead if the edits
  // are saved, and asks first if the save failed and they are still unsaved.
  // The editor reports its new state in an effect of this same commit, before
  // this one runs, so `isUnsavedNow` already reflects the save's outcome.
  useEffect(() => {
    if (saving) return;
    const deferred = deferredLeaveRef.current;
    if (!deferred) return;
    deferredLeaveRef.current = null;
    if (isUnsavedNow()) setPendingLeave(deferred);
    else proceed(deferred);
  }, [saving, isUnsavedNow, proceed]);
  // Closing the tab is different: it can cancel a save that has not reached the
  // server, so the browser asks until every save has finished.
  const anySaveRunning = useAnySaveRunning();
  const protectUnload = selectedMutation.unsaved || anySaveRunning;

  // Closing or reloading the tab asks the browser's own question.
  useEffect(() => {
    if (!protectUnload) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [protectUnload]);

  const navigation: AdminNavigation = useMemo(
    () => ({
      navigate: moveTo,
      pathFor: (id: string) => config.navItems.find((item) => item.id === id)?.path ?? null,
    }),
    [config.navItems, moveTo],
  );
  const ExtraScreen =
    screen !== null && config.extraScreenIds.has(screen) ? config.extraScreens[screen] : undefined;
  // Host screens registered with `assistantScoped: false` hide the assistant chrome.
  const assistantChrome = !(ExtraScreen && screen !== null && config.unscopedScreenIds.has(screen));
  const HeaderStart = config.headerStart;
  const HeaderEnd = config.headerEnd;
  const currentItem = config.navItems.find((item) => item.id === screen) ?? null;
  const hasTryIt = selectedAssistant !== null && assistantChrome;
  const tryItVisible = hasTryIt && tryIt.open;
  const keyNotice = createdKeys[0] ?? null;

  // The Overview checklist's "Open Try it" asks for the pane with an event:
  // the shell owns the pane, and screens are not handed its controls.
  const setTryItOpen = tryIt.setOpen;
  useEffect(() => {
    const onOpenTryIt = () => {
      if (!hasTryIt) return;
      focusTryItRef.current = true;
      setTryItOpen(true);
    };
    window.addEventListener(OPEN_TRY_IT_EVENT, onOpenTryIt);
    return () => window.removeEventListener(OPEN_TRY_IT_EVENT, onOpenTryIt);
  }, [hasTryIt, setTryItOpen]);

  useEffect(() => {
    if (!tryItVisible || !focusTryItRef.current) return;
    focusTryItRef.current = false;
    document.getElementById("try-it-input")?.focus();
  }, [tryItVisible]);

  // Hidden, not unmounted, on unscoped screens so a half-filled form survives.
  const switcher = (
    <AssistantSwitcher
      assistants={assistants}
      selectedId={effectiveSelectedId}
      onSelect={(id) => {
        setDrawerOpen(false);
        if (id === effectiveSelectedId) {
          stayPut();
          return;
        }
        guardLeave(() => selectAssistant(id));
      }}
      onCreated={handleCreated}
      createdKey={narrow ? null : keyNotice}
      pendingKeyCount={Math.max(createdKeys.length - 1, 0)}
      onDismissKey={(assistantId) =>
        setCreatedKeys((prev) => prev.filter((k) => k.assistantId !== assistantId))
      }
      hidden={!assistantChrome}
    />
  );
  const publishControls =
    assistantChrome && selectedAssistant !== null ? (
      <PublishControls
        key={selectedAssistant.id}
        assistantId={selectedAssistant.id}
        showActions={screen !== null && BUILD_SCREENS.has(screen)}
        refreshKey={screen ?? ""}
      />
    ) : null;
  const headerEnd = HeaderEnd && (
    <div className="shell-header-slot">
      <HeaderEnd api={ADMIN_API_HELPERS} />
    </div>
  );
  const signOut = (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      disabled={signingOut}
      onClick={() => void handleSignOut()}
    >
      {signingOut ? "Signing out…" : "Sign out"}
    </button>
  );
  const tryItToggle = hasTryIt && (
    <button
      ref={tryItToggleRef}
      type="button"
      className={
        tryIt.open
          ? "btn btn-secondary btn-sm try-it-toggle is-on"
          : "btn btn-secondary btn-sm try-it-toggle"
      }
      aria-expanded={tryIt.open}
      aria-controls={TRY_IT_ID}
      onClick={() => {
        focusTryItRef.current = !tryIt.open;
        tryIt.setOpen(!tryIt.open);
      }}
    >
      <Icon name="chat" />
      Try it
    </button>
  );
  const navigationList = (
    <Navigation
      current={screen}
      onNavigate={handleNavigate}
      items={config.navItems}
      assistantId={effectiveSelectedId}
    />
  );

  const bodyClass = [
    "shell-body",
    assistantChrome ? null : "shell-body-unscoped",
    tryItVisible && !narrow ? "shell-body-try-open" : null,
  ]
    .filter(Boolean)
    .join(" ");

  const shellClass = [
    "shell",
    narrow ? "shell-narrow" : null,
    narrow && drawerOpen ? "shell-drawer-open" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <AdminNavigationContext.Provider value={navigation}>
      <div className={shellClass}>
        <header className="shell-header">
          <div className="shell-brand">solv.chat</div>
          {HeaderStart && (
            <div className="shell-header-slot">
              <HeaderStart api={ADMIN_API_HELPERS} />
            </div>
          )}
          {narrow && (
            <div className="shell-current" aria-hidden={currentItem === null ? true : undefined}>
              {currentItem?.label ?? ""}
            </div>
          )}
          {narrow && tryItToggle}
          {narrow && (
            <button
              type="button"
              className="btn-icon shell-menu-button"
              aria-label="Menu"
              aria-expanded={drawerOpen}
              aria-controls={DRAWER_ID}
              onClick={() => {
                // The Try it sheet sits above the drawer; close it so the menu is usable.
                if (tryIt.open) tryIt.setOpen(false);
                setDrawerOpen(true);
              }}
            >
              <Icon name="menu" size={20} />
            </button>
          )}
          {narrow && drawerOpen && (
            <div
              className="shell-backdrop"
              aria-hidden="true"
              onClick={() => setDrawerOpen(false)}
            />
          )}
          {/* One element at one place in the tree on every screen and at every width:
            wide screens lay its contents out in the header row (display: contents),
            narrow screens show it as the drawer. Moving the switcher or the host slot
            between parents would remount them and lose a half-filled form. */}
          <div
            ref={drawerRef}
            id={DRAWER_ID}
            className={narrow ? "shell-sidebar shell-drawer" : "shell-header-controls"}
            hidden={narrow && !drawerOpen}
            {...(narrow
              ? {
                  role: "dialog",
                  "aria-modal": true,
                  "aria-label": "Menu",
                  onKeyDown: drawerTrap.onKeyDown,
                }
              : {})}
          >
            {narrow && (
              <div className="drawer-header">
                <span className="shell-brand">solv.chat</span>
                <button
                  type="button"
                  className="btn-icon"
                  aria-label="Close menu"
                  onClick={() => setDrawerOpen(false)}
                >
                  <Icon name="close" size={20} />
                </button>
              </div>
            )}
            <div className="drawer-top" hidden={!assistantChrome}>
              {switcher}
              {publishControls}
            </div>
            {narrow && navigationList}
            {!narrow && <div className="shell-header-spacer" />}
            <div className="drawer-bottom">
              {headerEnd}
              {!narrow && tryItToggle}
              {signOut}
            </div>
          </div>
        </header>
        {signOutError && (
          <div className="shell-alert" role="alert">
            <p className="error-text">{signOutError}</p>
          </div>
        )}

        <div className={bodyClass}>
          {!narrow && <div className="shell-sidebar">{navigationList}</div>}

          <main className="shell-main">
            {narrow && keyNotice && assistantChrome && (
              <div className="shell-key-notice">
                <IngestKeyNotice
                  key={keyNotice.assistantId}
                  createdKey={keyNotice}
                  pendingCount={Math.max(createdKeys.length - 1, 0)}
                  onDismiss={() =>
                    setCreatedKeys((prev) =>
                      prev.filter((k) => k.assistantId !== keyNotice.assistantId),
                    )
                  }
                />
              </div>
            )}
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
              <Skeleton label="Loading assistants…" lines={4} />
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

          {/* Mounted once outside <main> so moving between screens, closing the pane
            or visiting an unscoped screen keeps the transcript. */}
          {selectedAssistant !== null && (
            <TryItPane
              id={TRY_IT_ID}
              assistant={selectedAssistant}
              hidden={!tryItVisible}
              overlay={narrow}
              onClose={closeTryIt}
            />
          )}
        </div>
        <ConfirmDialog
          open={pendingLeave !== null}
          title="Leave without saving?"
          description="You have changes on this screen that are not saved. If you leave now, they are lost."
          confirmLabel="Leave without saving"
          cancelLabel="Stay here"
          tone="danger"
          onCancel={() => {
            setPendingLeave(null);
            restore();
          }}
          onConfirm={() => {
            const pending = pendingLeave;
            setPendingLeave(null);
            if (pending) proceed(pending);
          }}
        />
      </div>
    </AdminNavigationContext.Provider>
  );
}

/** The shell with the providers every screen shares. */
function AdminShellWithProviders(props: {
  config: ResolvedAdminConfig;
  onSignOut: () => Promise<void>;
}) {
  return (
    <ToastProvider>
      <AssistantMutationsProvider>
        <AdminShell {...props} />
      </AssistantMutationsProvider>
    </ToastProvider>
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

  return <AdminShellWithProviders config={resolved} onSignOut={session.signOut} />;
}
