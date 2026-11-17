import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

export type AssistantMutationKind = "saving" | "publishing" | "restoring";

export interface AssistantMutationState {
  active: AssistantMutationKind | null;
  saving: boolean;
  publishing: boolean;
  restoring: boolean;
  busy: boolean;
  /** Increments each time a mutation completes successfully for this assistant. */
  tick: number;
  /** Kind of the most recent mutation that completed successfully for this assistant. */
  lastKind: AssistantMutationKind | null;
  /**
   * True while a mounted editor (Behaviour, Widget) holds edits that are not
   * saved. Publishing sends the saved draft, so every publish entry point
   * waits for these to be saved first.
   */
  unsaved: boolean;
}

export type MutationRunResult<T> = { ran: true; value: T } | { ran: false };

export interface AssistantMutationHandle extends AssistantMutationState {
  run: <T>(kind: AssistantMutationKind, fn: () => Promise<T>) => Promise<MutationRunResult<T>>;
}

interface Coordinator {
  getState: (assistantId: string) => AssistantMutationState;
  run: <T>(
    assistantId: string,
    kind: AssistantMutationKind,
    fn: () => Promise<T>,
  ) => Promise<MutationRunResult<T>>;
  setUnsaved: (assistantId: string, reporter: string, unsaved: boolean) => void;
  /** True while a save runs for any assistant. */
  anySaving: boolean;
}

const AssistantMutationsContext = createContext<Coordinator | null>(null);

function useLocalCoordinator(): Coordinator {
  const inFlightRef = useRef<Map<string, AssistantMutationKind>>(new Map());
  const [activeByAssistant, setActiveByAssistant] = useState<Record<string, AssistantMutationKind>>(
    {},
  );
  const [ticksByAssistant, setTicksByAssistant] = useState<
    Record<string, { tick: number; lastKind: AssistantMutationKind }>
  >({});
  // Ids of the editors reporting unsaved edits, per assistant.
  const [unsavedByAssistant, setUnsavedByAssistant] = useState<Record<string, string[]>>({});

  const getState = useCallback(
    (assistantId: string): AssistantMutationState => {
      const active = activeByAssistant[assistantId] ?? null;
      const entry = ticksByAssistant[assistantId];
      return {
        active,
        saving: active === "saving",
        publishing: active === "publishing",
        restoring: active === "restoring",
        busy: active !== null,
        tick: entry?.tick ?? 0,
        lastKind: entry?.lastKind ?? null,
        unsaved: (unsavedByAssistant[assistantId]?.length ?? 0) > 0,
      };
    },
    [activeByAssistant, ticksByAssistant, unsavedByAssistant],
  );

  const setUnsaved = useCallback((assistantId: string, reporter: string, unsaved: boolean) => {
    setUnsavedByAssistant((prev) => {
      const current = prev[assistantId] ?? [];
      const has = current.includes(reporter);
      if (has === unsaved) return prev;
      const nextList = unsaved ? [...current, reporter] : current.filter((r) => r !== reporter);
      const next = { ...prev };
      if (nextList.length > 0) next[assistantId] = nextList;
      else delete next[assistantId];
      return next;
    });
  }, []);

  const run = useCallback(
    async <T,>(
      assistantId: string,
      kind: AssistantMutationKind,
      fn: () => Promise<T>,
    ): Promise<MutationRunResult<T>> => {
      if (inFlightRef.current.has(assistantId)) {
        return { ran: false };
      }
      inFlightRef.current.set(assistantId, kind);
      setActiveByAssistant((prev) => ({ ...prev, [assistantId]: kind }));
      try {
        const value = await fn();
        setTicksByAssistant((prev) => ({
          ...prev,
          [assistantId]: {
            tick: (prev[assistantId]?.tick ?? 0) + 1,
            lastKind: kind,
          },
        }));
        return { ran: true, value };
      } finally {
        inFlightRef.current.delete(assistantId);
        setActiveByAssistant((prev) => {
          if (!(assistantId in prev)) return prev;
          const next = { ...prev };
          delete next[assistantId];
          return next;
        });
      }
    },
    [],
  );

  const anySaving = Object.values(activeByAssistant).includes("saving");

  return useMemo(
    () => ({ getState, run, setUnsaved, anySaving }),
    [getState, run, setUnsaved, anySaving],
  );
}

/**
 * Provides per-assistant save/publish/restore mutation coordination across
 * screen navigation in the admin shell.
 */
export function AssistantMutationsProvider({ children }: { children: ReactNode }) {
  const coordinator = useLocalCoordinator();
  return (
    <AssistantMutationsContext.Provider value={coordinator}>
      {children}
    </AssistantMutationsContext.Provider>
  );
}

/** Returns the coordinated mutation state and runner for one assistant. */
export function useAssistantMutation(assistantId: string): AssistantMutationHandle {
  const ctx = useContext(AssistantMutationsContext);
  const fallback = useLocalCoordinator();
  const coordinator = ctx ?? fallback;
  const state = coordinator.getState(assistantId);

  const run = useCallback(
    <T,>(kind: AssistantMutationKind, fn: () => Promise<T>) =>
      coordinator.run(assistantId, kind, fn),
    [coordinator, assistantId],
  );

  return { ...state, run };
}

/**
 * True while a save runs for any assistant, including one the owner has
 * switched away from. Closing the tab then could cancel the request.
 */
export function useAnySaveRunning(): boolean {
  return useContext(AssistantMutationsContext)?.anySaving ?? false;
}

/**
 * Tells the shell whether this editor has unsaved edits for `assistantId`, so
 * publish controls outside the screen (the header) can wait for a save. The
 * report is withdrawn when the editor unmounts.
 */
export function useReportUnsavedEdits(assistantId: string, unsaved: boolean): void {
  const ctx = useContext(AssistantMutationsContext);
  const reporter = useId();
  const setUnsaved = ctx?.setUnsaved;
  useEffect(() => {
    if (!setUnsaved) return;
    setUnsaved(assistantId, reporter, unsaved);
    return () => setUnsaved(assistantId, reporter, false);
  }, [setUnsaved, assistantId, reporter, unsaved]);
}
