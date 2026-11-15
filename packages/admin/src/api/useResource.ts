import { useCallback, useEffect, useRef, useState } from "react";
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
  setValue: (next: T | ((prev: T | undefined) => T)) => void;
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
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    void tick;
    const gen = ++generationRef.current;
    if (path === null) {
      controllerRef.current?.abort();
      controllerRef.current = null;
      setState({ status: "loading", value: undefined, error: null });
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setState((prev) => ({
      status: "loading",
      value: prev.value,
      error: null,
    }));

    getJson<T>(path, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted && generationRef.current === gen) {
          setState({ status: "ready", value: data, error: null });
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || generationRef.current !== gen) return;
        const message =
          err instanceof ApiError || err instanceof Error ? err.message : "Could not load data.";
        setState({ status: "error", value: undefined, error: message });
      });

    return () => {
      controller.abort();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [path, tick]);

  const reload = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  const setValue = useCallback((next: T | ((prev: T | undefined) => T)) => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState((prev) => ({
      status: "ready",
      value: typeof next === "function" ? (next as (prev: T | undefined) => T)(prev.value) : next,
      error: null,
    }));
  }, []);

  return {
    status: state.status,
    value: state.value,
    error: state.error,
    reload,
    setValue,
  };
}
