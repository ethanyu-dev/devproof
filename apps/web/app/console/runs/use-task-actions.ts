"use client";

import { useState } from "react";
import { consoleApi } from "@/lib/api";
import type { TaskDetail } from "./task-types";

export function useTaskActions({
  id,
  onUpdated,
  onRerun,
}: {
  id: string;
  onUpdated: (task: TaskDetail) => void;
  onRerun: (task: TaskDetail) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    tone: "error" | "success";
  } | null>(null);

  async function mutate(path: string, body?: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await consoleApi<TaskDetail>(
        `/tasks/${encodeURIComponent(id)}${path}`,
        {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          method: "POST",
        },
      );
      onUpdated(updated);
      setMessage({ text: "任务已更新。", tone: "success" });
      return updated;
    } catch (error) {
      setMessage({ text: (error as Error).message, tone: "error" });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (
      !window.confirm("确认取消整个任务？Spec 分析与所有未完成的执行都会停止。")
    )
      return;
    await mutate("/cancel");
  }

  async function rerun() {
    if (
      !window.confirm(
        "确认基于当前任务重新运行？这会创建新任务并保留当前记录。",
      )
    )
      return;
    setBusy(true);
    setMessage(null);
    try {
      const task = await consoleApi<TaskDetail>(
        `/tasks/${encodeURIComponent(id)}/rerun`,
        { method: "POST" },
      );
      onRerun(task);
    } catch (error) {
      setMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return { busy, message, mutate, cancel, rerun };
}
