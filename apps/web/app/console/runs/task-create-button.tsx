"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { consoleApi } from "@/lib/api";
import { TaskCreateRequest, type TaskCreateDraft } from "./task-create";

const emptyDraft: TaskCreateDraft = {
  issueRef: "",
  goal: "",
  title: "",
  pullRequestUrls: "",
  targetUrls: "",
  profileStrategy: "REQUESTER",
  profileId: "",
};

const profileDescriptions = {
  REQUESTER:
    "按测试环境匹配你的浏览器身份并复用登录状态；如需登录，任务会等待你完成。",
  EXPLICIT_PROFILE: "选择你已准备好的浏览器身份，需适用于所有测试环境。",
  ISSUE_ASSIGNEE:
    "使用 Linear Issue 当前负责人的浏览器身份；负责人需已关联 DevProof 用户。",
  EPHEMERAL: "每个用例使用独立的临时会话；遇到登录页面时需要分别完成登录。",
};

type BrowserProfile = { id: string; displayName: string; status: string };

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
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [profilesReload, setProfilesReload] = useState(0);

  useEffect(() => {
    if (!open || draft.profileStrategy !== "EXPLICIT_PROFILE") return;
    const controller = new AbortController();
    setProfilesLoading(true);
    setProfilesError(null);
    void consoleApi<BrowserProfile[]>("/browser-profiles", {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const ready = result.filter((profile) => profile.status === "READY");
        setProfiles(ready);
        setDraft((current) => ({
          ...current,
          profileId: ready.some((profile) => profile.id === current.profileId)
            ? current.profileId
            : "",
        }));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setProfilesError(
            cause instanceof Error ? cause.message : "浏览器身份加载失败。",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setProfilesLoading(false);
      });
    return () => controller.abort();
  }, [open, draft.profileStrategy, profilesReload]);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  function update<K extends keyof TaskCreateDraft>(
    field: K,
    value: TaskCreateDraft[K],
  ) {
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(field === "issueRef" &&
      !String(value).trim() &&
      current.profileStrategy === "ISSUE_ASSIGNEE"
        ? { profileStrategy: "REQUESTER" as const }
        : {}),
    }));
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
        className="m-auto max-h-[90dvh] w-[min(560px,calc(100vw_-_32px))] overflow-hidden rounded-xl border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/40 open:flex open:flex-col"
      >
        <div className="mb-5 flex shrink-0 items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold">
              创建任务
            </h2>
            <p
              id={descriptionId}
              className="mt-1.5 text-sm leading-6 text-muted-foreground"
            >
              根据 Issue、PR 或测试说明生成用例，并在指定环境执行。
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
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid min-h-0 gap-5 overflow-y-auto">
            <Field
              label="Issue 链接或编号（选填）"
              description="支持 Linear Issue 链接或编号，例如 ENG-123。"
            >
              <Input
                autoFocus
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
              description="每行一个，最多 25 个；可直接通过 PR 创建，无需 Issue。留空时尝试查找 Issue 关联 PR。"
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
              label="测试说明（选填）"
              description="Issue、PR 和测试说明至少填写一项。请说明本次需要验证的操作及预期结果。"
            >
              <Textarea
                rows={3}
                maxLength={20_000}
                disabled={busy}
                value={draft.goal ?? ""}
                onChange={(event) => update("goal", event.target.value)}
              />
            </Field>
            <Field
              label="任务名称（选填）"
              description="留空时根据分析来源自动命名。"
            >
              <Input
                maxLength={500}
                disabled={busy}
                value={draft.title ?? ""}
                onChange={(event) => update("title", event.target.value)}
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
            <Field
              label="浏览器身份"
              description={profileDescriptions[draft.profileStrategy]}
            >
              <Select
                disabled={busy}
                value={draft.profileStrategy}
                onChange={(event) =>
                  update(
                    "profileStrategy",
                    event.target.value as TaskCreateDraft["profileStrategy"],
                  )
                }
              >
                <option value="REQUESTER">使用我的浏览器身份</option>
                <option value="EXPLICIT_PROFILE">指定我的浏览器身份</option>
                <option
                  value="ISSUE_ASSIGNEE"
                  disabled={!draft.issueRef.trim()}
                >
                  使用 Issue 负责人的浏览器身份
                </option>
                <option value="EPHEMERAL">使用临时会话</option>
              </Select>
            </Field>
            {draft.profileStrategy === "EXPLICIT_PROFILE" && (
              <>
                <Field
                  label="可用浏览器身份"
                  description={
                    !profilesLoading && !profilesError && !profiles.length
                      ? "暂无可用身份，请先在「浏览器身份」中完成登录，或选择「使用我的浏览器身份」在任务中准备。"
                      : "复用所选身份的登录状态。"
                  }
                >
                  <Select
                    required
                    disabled={busy || profilesLoading || !!profilesError}
                    value={draft.profileId}
                    onChange={(event) =>
                      update("profileId", event.target.value)
                    }
                  >
                    <option value="">
                      {profilesLoading ? "正在加载…" : "请选择"}
                    </option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.displayName}
                      </option>
                    ))}
                  </Select>
                </Field>
                {profilesError && (
                  <div className="flex items-center gap-2">
                    <p role="alert" className="text-sm text-destructive">
                      {profilesError}
                    </p>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        setProfilesReload((current) => current + 1)
                      }
                    >
                      重试
                    </Button>
                  </div>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <div className="mt-5 flex shrink-0 justify-end gap-2 border-t pt-4">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={
                busy ||
                (draft.profileStrategy === "EXPLICIT_PROFILE" &&
                  (profilesLoading || !!profilesError || !draft.profileId))
              }
            >
              {busy ? "正在创建…" : "创建并执行"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
