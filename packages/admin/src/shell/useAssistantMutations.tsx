import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
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
}

const AssistantMutationsContext = createContext<Coordinator | null>(null);

function useLocalCoordinator(): Coordinator {
  const inFlightRef = useRef<Map<string, AssistantMutationKind>>(new Map());
  const [activeByAssistant, setActiveByAssistant] = useState<Record<string, AssistantMutationKind>>(
    {},
  );
  const [ticksByAssistant, setTicksByAssistant] = useState<Record<string, number>>({});

  const getState = useCallback(
    (assistantId: string): AssistantMutationState => {
      const active = activeByAssistant[assistantId] ?? null;
      return {
        active,
        saving: active === "saving",
        publishing: active === "publishing",
        restoring: active === "restoring",
        busy: active !== null,
        tick: ticksByAssistant[assistantId] ?? 0,
      };
    },
    [activeByAssistant, ticksByAssistant],
  );

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
          [assistantId]: (prev[assistantId] ?? 0) + 1,
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

  return useMemo(() => ({ getState, run }), [getState, run]);
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
