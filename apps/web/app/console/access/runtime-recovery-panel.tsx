"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { consoleApi } from "@/lib/api";

interface Quarantine {
  id: string;
  closureVerifiedAt: string | null;
  status: string;
  browserExecutions: Array<{ runId: string; run: { goal: string } }>;
}

export function RuntimeRecoveryPanel() {
  const [items, setItems] = useState<Quarantine[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setItems(await consoleApi<Quarantine[]>("/runtime-quarantines"));
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active) void load().catch((cause: Error) => setError(cause.message));
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [load]);
  async function resolve(item: Quarantine) {
    setBusy(item.id);
    setError(null);
    try {
      await consoleApi(`/runtime-sessions/${item.id}/resolve-write-outcome`, {
        method: "POST",
        body: JSON.stringify({ note: notes[item.id] ?? "" }),
      });
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  }
  if (!items.length && !error) return null;
  return (
    <section className="dp-form">
      <h3>等待核对的写操作</h3>
      <p>
        执行中断时无法确认写入是否成功。核对后台实际状态并记录结果后，可释放数据锁，让后续任务继续。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {items.map((item) => (
        <div className="dp-form" key={item.id}>
          {item.browserExecutions[0] ? (
            <Link
              href={`/console/executions/${item.browserExecutions[0].runId}`}
            >
              {item.browserExecutions[0].run.goal}
            </Link>
          ) : (
            <strong>浏览器执行中断</strong>
          )}
          <p>
            {item.closureVerifiedAt
              ? "旧浏览器已确认关闭，等待业务状态核对。"
              : "等待旧浏览器关闭。节点恢复连接并确认停止前，数据锁会继续保留。"}
          </p>
          <label>
            状态核对记录
            <textarea
              value={notes[item.id] ?? ""}
              minLength={10}
              maxLength={2000}
              onChange={(event) =>
                setNotes((previous) => ({
                  ...previous,
                  [item.id]: event.target.value,
                }))
              }
              placeholder="记录已检查的业务状态、写入结果及必要的数据恢复情况。"
            />
          </label>
          <Button
            disabled={
              busy !== null ||
              !item.closureVerifiedAt ||
              (notes[item.id]?.trim().length ?? 0) < 10
            }
            onClick={() => void resolve(item)}
          >
            记录核对结果并释放数据锁
          </Button>
        </div>
      ))}
    </section>
  );
}
