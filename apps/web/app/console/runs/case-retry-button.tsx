"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { consoleApi } from "@/lib/api";
import { CaseRetryRequest, type CaseRetryPlan } from "./case-retry";
import type { TaskDetail } from "./task-types";
import { taskDetailHref } from "./task-navigation";

export function CaseRetryButton({
  taskId,
  runId,
  disabled = false,
  onRetried,
}: {
  taskId: string;
  runId: string;
  disabled?: boolean;
  onRetried?: (task: TaskDetail) => void;
}) {
  const router = useRouter();
  const request = useRef(new CaseRetryRequest(consoleApi));
  const pending = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<CaseRetryPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prepareAccounts, setPrepareAccounts] = useState(false);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  async function act(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setOpen(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function submit(prepared: CaseRetryPlan, confirmed = false) {
    const task = await request.current.submit(
      prepared,
      confirmed,
      !prepareAccounts,
    );
    setOpen(false);
    if (onRetried) onRetried(task);
    else router.push(taskDetailHref(task.id));
  }

  function start() {
    setPlan(null);
    void act(async () => {
      const prepared = await request.current.prepare(taskId, runId);
      setPlan(prepared);
      if (
        !prepared.blockedReason &&
        !prepared.recoveries.length &&
        !prepared.hasTestAccounts
      )
        await submit(prepared);
      else setOpen(true);
    });
  }

  return (
    <>
      <Button
        disabled={disabled || busy}
        onClick={start}
        size="sm"
        variant="secondary"
      >
        <RotateCcw />
        {busy ? "处理中…" : "重试用例"}
      </Button>
      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setOpen(false);
        }}
        aria-labelledby={`retry-title-${runId}`}
        className="m-auto max-h-[85vh] w-[min(640px,calc(100vw_-_32px))] overflow-y-auto rounded-xl border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/40"
      >
        <div className="flex flex-col gap-4">
          <h2 id={`retry-title-${runId}`} className="text-lg font-semibold">
            重试用例
          </h2>
          <p className="text-sm text-muted-foreground">
            {plan ? `${plan.name} · ` : ""}
            复用当前用例规格和验证环境，在原任务下新增一次执行；历史执行记录与证据保留。
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {busy && (
            <p role="status" className="text-sm">
              正在处理，请稍候…
            </p>
          )}
          {plan?.blockedReason && (
            <p role="status" className="text-sm">
              {plan.blockedReason}
            </p>
          )}
          {plan && !plan.blockedReason && plan.recoveries.length > 0 && (
            <p className="text-sm">
              旧浏览器已确认关闭。上次写入结果尚未核实，重试可能重复执行已完成的操作。确认后即可重试，无需填写核实说明或证据。
            </p>
          )}
          {!!plan?.preparationConditions?.length && (
            <section className="text-sm" aria-label="重试前的数据条件">
              <b>重试前的数据条件</b>
              <ul className="my-2 list-disc space-y-1 pl-5">
                {plan.preparationConditions.map((condition) => (
                  <li key={condition}>{condition}</li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                分配账号不代表业务数据已就绪；原有记录不会被自动删除或重置。
              </p>
            </section>
          )}
          {plan?.hasTestAccounts && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                aria-label="重新填写测试账号"
                checked={prepareAccounts}
                disabled={busy}
                onChange={(event) => setPrepareAccounts(event.target.checked)}
              />
              <span>
                重新填写测试账号
                <span className="block text-muted-foreground">
                  默认复用上次账号。勾选后，新一轮将在账号准备处等待填写；适用于上次账号不存在或不满足数据前置条件。
                </span>
              </span>
            </label>
          )}
          <form
            className="flex min-h-0 flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (plan) void act(() => submit(plan, true));
            }}
          >
            <div className="grid min-h-0 gap-4 overflow-y-auto pr-1">
              {plan?.recoveries.map((recovery, index) => (
                <Link
                  key={recovery.id}
                  className="text-sm underline"
                  href={`/console/access/recoveries/${recovery.id}`}
                  target="_blank"
                >
                  查看原执行恢复记录{" "}
                  {plan.recoveries.length > 1 ? index + 1 : ""} ↗
                </Link>
              ))}
            </div>
            <div className="flex shrink-0 justify-end gap-2">
              {error && plan && !plan.blockedReason && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={start}
                >
                  刷新状态
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                关闭
              </Button>
              {!plan || plan.blockedReason ? (
                <Button type="button" disabled={busy} onClick={start}>
                  重新检查
                </Button>
              ) : (
                <Button type="submit" disabled={busy}>
                  {plan.recoveries.length ? "确认重试" : "重试用例"}
                </Button>
              )}
            </div>
          </form>
        </div>
      </dialog>
    </>
  );
}
