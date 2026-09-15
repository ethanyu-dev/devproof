"use client";
import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { consoleApi } from "@/lib/api";

export function TaskDeleteButton({
  id,
  title,
  onDeleted,
  disabled = false,
  iconOnly = false,
}: {
  id: string;
  title: string;
  onDeleted: () => void;
  disabled?: boolean;
  iconOnly?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  async function remove() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await consoleApi(
        `/tasks/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        30_000,
      );
      setOpen(false);
      onDeleted();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        aria-label="删除任务"
        title={disabled ? "任务结束后可删除" : "删除任务"}
        disabled={disabled || busy}
        size={iconOnly ? "icon-sm" : "default"}
        variant="ghost"
        className="text-muted-foreground hover:bg-destructive-soft hover:text-destructive"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Trash2 />
        {!iconOnly && "删除任务"}
      </Button>
      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        aria-labelledby={`delete-title-${id}`}
        aria-describedby={`delete-description-${id}`}
        className="m-auto w-[min(480px,calc(100vw_-_32px))] rounded-xl border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/40"
      >
        <div className="flex flex-col gap-4">
          <h2 id={`delete-title-${id}`} className="text-lg font-semibold">
            永久删除任务？
          </h2>
          <p className="break-words text-sm font-medium">{title}</p>
          <p
            id={`delete-description-${id}`}
            className="text-sm leading-6 text-muted-foreground"
          >
            将删除此任务的全部执行批次、用例、日志、验收报告和专属证据附件，无法恢复。不会删除测试环境中的业务数据，也不会删除其他任务。
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              autoFocus
              variant="secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              保留任务
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? "正在删除…" : "永久删除"}
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
