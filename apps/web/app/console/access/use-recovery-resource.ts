"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { consoleApi } from "@/lib/api";
import { RecoveryRequest } from "./recovery-request";

export function useRecoveryResource<T>(path: string, paused = false) {
  const requests = useRef(new RecoveryRequest());
  const pause = useRef(paused);
  pause.current = paused;
  const [snapshot, setSnapshot] = useState<{
    path: string;
    data: T | null;
    error: string | null;
    loading: boolean;
  }>({ path, data: null, error: null, loading: true });
  const refresh = useCallback(async () => {
    const request = requests.current.begin();
    setSnapshot((old) => ({
      path,
      data: old.path === path ? old.data : null,
      error: null,
      loading: true,
    }));
    try {
      const data = await consoleApi<T>(path, { signal: request.signal });
      if (request.current()) {
        setSnapshot({ path, data, error: null, loading: false });
        return data;
      }
    } catch (cause) {
      if (request.current())
        setSnapshot((old) => ({
          ...old,
          error: (cause as Error).message,
          loading: false,
        }));
    }
    return null;
  }, [path]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!pause.current && document.visibilityState !== "hidden")
        void refresh();
    }, 15_000);
    const current = requests.current;
    return () => {
      current.cancel();
      window.clearInterval(timer);
    };
  }, [refresh]);
  return {
    data: snapshot.path === path ? snapshot.data : null,
    error: snapshot.path === path ? snapshot.error : null,
    loading: snapshot.path !== path || snapshot.loading,
    refresh,
  };
}
