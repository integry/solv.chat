import { useCallback, useEffect, useState } from "react";
import { ApiError, getJson } from "./client.js";

export type ResourceState<T> =
  | { status: "loading"; value: T | undefined; error: string | null }
  | { status: "ready"; value: T; error: null }
  | { status: "error"; value: T | undefined; error: string };

export interface UseResourceResult<T> {
  status: ResourceState<T>["status"];
  value: T | undefined;
  error: string | null;
  reload: () => void;
  setValue: (next: T) => void;
}

/**
 * Loads a JSON resource from the admin API whenever `path` changes or
 * `reload()` is called. Pass `null` to skip fetching.
 */
export function useResource<T>(path: string | null): UseResourceResult<T> {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<ResourceState<T>>({
    status: "loading",
    value: undefined,
    error: null,
  });

  useEffect(() => {
    void tick;
    if (path === null) {
      setState({ status: "loading", value: undefined, error: null });
      return;
    }

    const controller = new AbortController();
    setState((prev) => ({
      status: "loading",
      value: prev.value,
      error: null,
    }));

    getJson<T>(path, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setState({ status: "ready", value: data, error: null });
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          err instanceof ApiError || err instanceof Error ? err.message : "Could not load data.";
        setState({ status: "error", value: undefined, error: message });
      });

    return () => {
      controller.abort();
    };
  }, [path, tick]);

  const reload = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  const setValue = useCallback((next: T) => {
    setState({ status: "ready", value: next, error: null });
  }, []);

  return {
    status: state.status,
    value: state.value,
    error: state.error,
    reload,
    setValue,
  };
}
