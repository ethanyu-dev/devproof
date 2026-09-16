"use client";

import { KeyRound, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { consoleApi } from "@/lib/api";
import {
  existingProfileForDraft,
  profileCreateInput,
  type ProfileCreateDraft,
} from "./profile-create";
import type { Profile } from "./profile-types";

const emptyDraft: ProfileCreateDraft = {
  websiteUrl: "",
  displayName: "",
  environmentKey: "",
  authRole: "",
};

export function ProfileCreateDialog({
  open,
  profiles,
  onClose,
  onCreated,
  onRefresh,
  onSelectExisting,
}: {
  open: boolean;
  profiles: Profile[];
  onClose: () => void;
  onCreated: (profile: Profile) => void;
  onRefresh: () => Promise<void>;
  onSelectExisting: (profile: Profile) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const existing = existingProfileForDraft(profiles, draft);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  function update(field: keyof ProfileCreateDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setError(null);
  }

  async function submit() {
    if (pending.current) return;
    if (existing) {
      onSelectExisting(existing);
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const profile = await consoleApi<Profile>("/browser-profiles", {
        method: "POST",
        body: JSON.stringify(profileCreateInput(draft)),
      });
      setDraft(emptyDraft);
      onCreated(profile);
    } catch (cause) {
      // Creation may have committed before a timeout, or another tab may have
      // created this scope. Refresh so the existing identity can be selected.
      await onRefresh().catch(() => undefined);
      setError(
        cause instanceof Error ? cause.message : "添加失败，请稍后重试。",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClose={onClose}
      onCancel={(event) => {
        if (pending.current) event.preventDefault();
        else onClose();
      }}
      className="m-auto max-h-[90dvh] w-[min(520px,calc(100vw_-_32px))] overflow-y-auto rounded-xl border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/40"
    >
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-lg font-semibold">
            添加网站并登录
          </h2>
          <p
            id={descriptionId}
            className="mt-1.5 text-sm leading-6 text-muted-foreground"
          >
            打开网站完成登录或 MFA，验证并保存后即可供后续任务使用。
          </p>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="关闭添加网站"
          disabled={busy}
          onClick={onClose}
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
          label="网站地址"
          description="填写需要登录后访问的页面地址。保存时会重新访问该页面，检查登录是否有效。"
        >
          <Input
            autoFocus
            required
            type="url"
            maxLength={2000}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://app.example.com/dashboard"
            value={draft.websiteUrl}
            onChange={(event) => update("websiteUrl", event.target.value)}
          />
        </Field>
        <Field
          label="身份名称（选填）"
          description="留空时使用网站域名，方便之后查找。"
        >
          <Input
            maxLength={160}
            disabled={busy}
            placeholder="例如：测试环境账号"
            value={draft.displayName}
            onChange={(event) => update("displayName", event.target.value)}
          />
        </Field>
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            环境与角色（选填）
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="环境">
              <Input
                maxLength={160}
                disabled={busy}
                placeholder="default"
                value={draft.environmentKey}
                onChange={(event) =>
                  update("environmentKey", event.target.value)
                }
              />
            </Field>
            <Field label="角色">
              <Input
                maxLength={100}
                disabled={busy}
                placeholder="default"
                value={draft.authRole}
                onChange={(event) => update("authRole", event.target.value)}
              />
            </Field>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            一般保持默认即可。同一网站的不同环境或角色可分别保存身份，任务需使用相同的环境与角色。
          </p>
        </details>
        {existing ? (
          <p role="status" className="text-sm leading-6 text-muted-foreground">
            此网站、环境和角色已有身份「{existing.displayName}
            」，可查看现有身份并继续登录。
          </p>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            保存后允许控制台任务使用此身份。飞书和 Issue
            负责人入口首次使用时会单独请求授权。
          </p>
        )}
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
            onClick={onClose}
          >
            取消
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
            {busy ? "正在添加…" : existing ? "查看已有身份" : "打开网站登录"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
