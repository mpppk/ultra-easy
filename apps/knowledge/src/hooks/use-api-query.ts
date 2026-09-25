import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "#lib/api-client";

export type QueryState<T> =
  | { status: "loading"; data?: T; error?: undefined }
  | { status: "success"; data: T; error?: undefined }
  | { status: "error"; data?: T; error: ApiError };

/** Minimal client-side query hook (explicit refetch, no background polling). */
export function useApiQuery<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<QueryState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let active = true;
    setState((previous) => ({
      status: "loading",
      ...(previous.data ? { data: previous.data } : {}),
    }));
    loadRef.current().then(
      (data) => active && setState({ status: "success", data }),
      (error: unknown) =>
        active &&
        setState({
          status: "error",
          error:
            error instanceof ApiError ? error : new ApiError(0, "network_error", "Network error"),
        }),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const refetch = useCallback(() => setNonce((value) => value + 1), []);
  return { ...state, refetch };
}

/** Runs a mutation and tracks busy / error state. */
export function useMutation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    return action()
      .then((value) => value)
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError ? caught : new ApiError(0, "network_error", "Network error"),
        );
        return null;
      })
      .finally(() => setBusy(false));
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}
