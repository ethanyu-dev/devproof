"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { consoleApi } from "@/lib/api";
import { terminalLifecycles } from "./task-display";
import type { TaskDetail, TaskEvent } from "./task-types";

export function useTaskDetail(id: string, showLogs: boolean) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const detailRequest = useRef<AbortController | null>(null);
  const eventsRequest = useRef<AbortController | null>(null);
  const active = detail !== null && !terminalLifecycles.has(detail.lifecycle);

  const loadDetail = useCallback(
    async (foreground = false) => {
      if (detailRequest.current && !foreground) return;
      detailRequest.current?.abort();
      const controller = new AbortController();
      detailRequest.current = controller;
      if (foreground) setLoading(true);
      try {
        const next = await consoleApi<TaskDetail>(
          `/tasks/${encodeURIComponent(id)}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setDetail(next);
          setError(null);
        }
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      } finally {
        if (detailRequest.current === controller) {
          detailRequest.current = null;
          setLoading(false);
        }
      }
    },
    [id],
  );

  const loadEvents = useCallback(
    async (foreground = false) => {
      if (eventsRequest.current && !foreground) return;
      eventsRequest.current?.abort();
      const controller = new AbortController();
      eventsRequest.current = controller;
      setEventsLoading(true);
      try {
        const next = await consoleApi<TaskEvent[]>(
          `/tasks/${encodeURIComponent(id)}/events`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setEvents(next);
          setEventsError(null);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setEventsError((error as Error).message);
      } finally {
        if (eventsRequest.current === controller) {
          eventsRequest.current = null;
          setEventsLoading(false);
        }
      }
    },
    [id],
  );

  useEffect(() => {
    void loadDetail(true);
    return () => {
      detailRequest.current?.abort();
      detailRequest.current = null;
    };
  }, [loadDetail]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void loadDetail(), 2_000);
    return () => window.clearInterval(timer);
  }, [active, loadDetail]);

  useEffect(() => {
    if (!showLogs) return;
    void loadEvents(true);
    const timer = active
      ? window.setInterval(() => void loadEvents(), 2_000)
      : null;
    return () => {
      if (timer !== null) window.clearInterval(timer);
      eventsRequest.current?.abort();
      eventsRequest.current = null;
    };
  }, [active, loadEvents, showLogs]);

  function refresh() {
    void loadDetail(true);
    if (showLogs) void loadEvents(true);
  }

  function updateDetail(next: TaskDetail) {
    setDetail(next);
    refresh();
  }

  return {
    detail,
    error,
    loading,
    events,
    eventsError,
    eventsLoading,
    refresh,
    updateDetail,
    retryEvents: () => void loadEvents(true),
  };
}
