"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { consoleApi } from "@/lib/api";
import { TaskCreateRequest, type TaskCreateDraft } from "./task-create";

const emptyDraft: TaskCreateDraft = {
  issueRef: "",
  pullRequestUrls: "",
  targetUrls: "",
};

export function TaskCreateButton({
  onCreated,
}: {
  onCreated: (id: string) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef(new TaskCreateRequest(consoleApi));
  const pending = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  function update(field: keyof TaskCreateDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setError(null);
  }

  async function submit() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const task = await request.current.submit(draft);
      setOpen(false);
      setDraft(emptyDraft);
      onCreated(task.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "创建失败，请稍后重试。",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Button aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Plus /> 创建任务
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClose={() => setOpen(false)}
        onCancel={(event) => {
          if (pending.current) event.preventDefault();
          else setOpen(false);
        }}
        className="m-auto max-h-[90dvh] w-[min(560px,calc(100vw_-_32px))] overflow-y-auto rounded-xl border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/40"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold">
              创建任务
            </h2>
            <p
              id={descriptionId}
              className="mt-1.5 text-sm leading-6 text-muted-foreground"
            >
              分析 Issue 和 PR，生成测试用例并在指定环境执行。
            </p>
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="关闭创建任务"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </div>
        <form
          aria-busy={busy}
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field
            label="Issue 链接或编号"
            description="支持 Linear Issue 链接或编号，例如 ENG-123。"
          >
            <Input
              autoFocus
              required
              maxLength={500}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://linear.app/team/issue/ENG-123"
              value={draft.issueRef}
              onChange={(event) => update("issueRef", event.target.value)}
            />
          </Field>
          <Field
            label="GitHub PR 链接（选填）"
            description="每行一个，最多 25 个；留空时自动查找 Issue 关联的 PR。"
          >
            <Textarea
              rows={3}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://github.com/owner/repo/pull/123"
              value={draft.pullRequestUrls}
              onChange={(event) =>
                update("pullRequestUrls", event.target.value)
              }
            />
          </Field>
          <Field
            label="执行测试环境"
            description="填写可访问的 HTTP 或 HTTPS 地址，每行一个，最多 20 个。"
          >
            <Textarea
              required
              rows={3}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://staging.example.com"
              value={draft.targetUrls}
              onChange={(event) => update("targetUrls", event.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "正在创建…" : "创建并执行"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
