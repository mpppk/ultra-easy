import { useCallback, useEffect, useRef, useState } from "react";

import { ConsoleApiError } from "#lib/console-client";

export type QueryState<T> =
  | { status: "idle" | "loading"; data?: T; error?: undefined }
  | { status: "success"; data: T; error?: undefined }
  | { status: "error"; data?: T; error: ConsoleApiError };

/** Minimal client-side query hook (explicit refetch, no background polling). */
export function useConsoleQuery<T>(
  load: (() => Promise<T>) | null,
  deps: readonly unknown[],
): QueryState<T> & { refetch: () => void } {
  const [state, setState] = useState<QueryState<T>>({ status: load ? "loading" : "idle" });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const current = loadRef.current;
    if (!current) return;
    let active = true;
    setState((previous) => ({
      status: "loading",
      ...(previous.data ? { data: previous.data } : {}),
    }));
    current().then(
      (data) => active && setState({ status: "success", data }),
      (error: unknown) =>
        active &&
        setState({
          status: "error",
          error:
            error instanceof ConsoleApiError
              ? error
              : new ConsoleApiError(0, "network_error", String(error)),
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
