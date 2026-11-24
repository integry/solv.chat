import type { OperatorAccessCapabilities } from "@solvchat/core";
import { useCallback, useEffect, useState } from "react";
import { ApiError, getJson, logoutRequest, subscribeUnauthorized } from "../api/client.js";

export type SessionState = "loading" | "signed-in" | "signed-out" | "unavailable";

export interface UseSessionResult {
  state: SessionState;
  operatorAccess: OperatorAccessCapabilities | undefined;
  refresh: () => void;
  signOut: () => Promise<void>;
}

/**
 * Tracks whether the owner holds a valid session cookie. Any 401 from any
 * authenticated API call flips the state back to `"signed-out"`. Any other
 * failure of the first request (a 500, a network error) is `"unavailable"`:
 * the session may be fine, so the owner is offered a retry, not the login.
 */
export function useSession(customSignOut?: () => void | Promise<void>): UseSessionResult {
  const [state, setState] = useState<SessionState>("loading");
  const [operatorAccess, setOperatorAccess] = useState<OperatorAccessCapabilities>();
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

    getJson<{ operatorAccess?: OperatorAccessCapabilities }>(
      "/api/admin/assistants",
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setOperatorAccess(data.operatorAccess);
          setState("signed-in");
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setState(err instanceof ApiError && err.status === 401 ? "signed-out" : "unavailable");
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
    if (customSignOut) {
      await customSignOut();
    } else {
      await logoutRequest();
    }
    setState("signed-out");
  }, [customSignOut]);

  return { state, operatorAccess, refresh, signOut };
}
