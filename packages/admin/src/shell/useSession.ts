import { useCallback, useEffect, useState } from "react";
import { getJson, logoutRequest, subscribeUnauthorized } from "../api/client.js";
import type { Assistant } from "../api/types.js";

export type SessionState = "loading" | "signed-in" | "signed-out";

export interface UseSessionResult {
  state: SessionState;
  refresh: () => void;
  signOut: () => Promise<void>;
}

/**
 * Tracks whether the owner holds a valid session cookie. Any 401 from any
 * authenticated API call flips the state back to `"signed-out"`.
 */
export function useSession(): UseSessionResult {
  const [state, setState] = useState<SessionState>("loading");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    return subscribeUnauthorized(() => {
      setState("signed-out");
    });
  }, []);

  useEffect(() => {
    void tick;
    const controller = new AbortController();
    setState("loading");

    getJson<{ assistants: Assistant[] }>("/api/admin/assistants", controller.signal)
      .then(() => {
        if (!controller.signal.aborted) {
          setState("signed-in");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState("signed-out");
        }
      });

    return () => {
      controller.abort();
    };
  }, [tick]);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  const signOut = useCallback(async () => {
    await logoutRequest().catch(() => {});
    setState("signed-out");
  }, []);

  return { state, refresh, signOut };
}
