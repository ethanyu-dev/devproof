"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import type {
  RuntimeDrainPreview,
  RuntimeDrainResumeToken,
} from "@devproof/contracts";
import { PageHeader } from "@/components/page-header";
import { LoadingState } from "@/components/settings-layout";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { consoleApi } from "@/lib/api";
import { useRecoveryResource } from "./use-recovery-resource";
import {
  CopyId,
  RecoveryCard,
  RecoveryFeedback,
  evidenceRefs,
  recoveryDate,
  recoveryPath,
  useRecoveryAction,
} from "./recovery-ui";

const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\"'\"'") + "'";
const runtimeApiUrl =
  process.env.NEXT_PUBLIC_RUNTIME_API_URL ?? "http://localhost:4433";
const drainLabel: Record<string, string> = {
  NONE: "正常准入",
  FROZEN: "已冻结，待排空核验",
  ATTESTED: "排空已核验，待恢复",
  RESUMING: "等待新进程连接",
};

export function RuntimeDrainPanel({ runtimeId }: { runtimeId: string }) {
  const action = useRecoveryAction();
  const resource = useRecoveryResource<RuntimeDrainPreview>(
    `/runtimes/${runtimeId}/drain-preview`,
    action.busy,
  );
  const runtimes = useRecoveryResource<
    Array<{ id: string; name: string; status: string }>
  >("/browser-runtimes", action.busy);
  const preview = resource.data;
  const drain = preview?.existingDrain;
  const runtime = runtimes.data?.find((item) => item.id === runtimeId);
  const [drainNote, setDrainNote] = useState("");
  const [drainEvidence, setDrainEvidence] = useState("");
  const [terminationScope, setTerminationScope] = useState<string | null>(null);
  const [resumeNote, setResumeNote] = useState("");
  const [resumeEvidence, setResumeEvidence] = useState("");
  const [storageScope, setStorageScope] = useState<string | null>(null);
  const [resumeToken, setResumeToken] =
    useState<RuntimeDrainResumeToken | null>(null);
  const scope = preview
    ? `${preview.snapshotDigest}:${drain?.id ?? ""}:${drain?.snapshotDigest ?? ""}`
    : "";
  const terminated = terminationScope === scope;
  const preserved = storageScope === scope;
  useEffect(() => {
    if (!resumeToken) return;
    const timer = window.setTimeout(
      () => {
        setResumeToken(null);
        action.setNotice("恢复票据已过期，请重新签发后使用。");
      },
      Math.max(0, new Date(resumeToken.expiresAt).getTime() - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [resumeToken, action.setNotice]);
  useEffect(() => {
    if (!preview) return;
    setResumeToken((token) =>
      token &&
      token.runtimeId === preview.runtimeId &&
      token.drainId === preview.existingDrain?.id &&
      ["ATTESTED", "RESUMING"].includes(preview.drainState)
        ? token
        : null,
    );
  }, [preview]);
  async function refresh() {
    await Promise.all([resource.refresh(), runtimes.refresh()]);
  }
  return (
    <div className="grid min-w-0 gap-4 text-xs">
      <PageHeader
        title="节点排空与恢复"
        description="核对整个节点的影响范围，处理冻结、排空证明和原宿主重新接入。"
        actions={
          <>
            <Button asChild variant="secondary">
              <Link href="/console/access">
                <ArrowLeft />
                返回节点配置
              </Link>
            </Button>
            <Button
              variant="secondary"
              disabled={resource.loading || action.busy}
              onClick={() => void refresh()}
            >
              <RefreshCw />
              刷新状态
            </Button>
          </>
        }
      />
      <RecoveryFeedback
        error={action.error ?? resource.error ?? runtimes.error}
        notice={action.notice}
      />
      {!preview && resource.loading ? <LoadingState /> : null}
      {preview ? (
        <>
          <RecoveryCard title={runtime?.name ?? "执行节点"}>
            <div className="flex flex-wrap gap-2">
              <Badge
                tone={preview.drainState === "NONE" ? "neutral" : "warning"}
              >
                {drainLabel[preview.drainState] ?? preview.drainState}
              </Badge>
              {runtime ? (
                <span className="text-muted-foreground">
                  连接状态：
                  {runtime.status === "ONLINE"
                    ? "在线"
                    : runtime.status === "REVOKED"
                      ? "已撤销"
                      : "离线"}
                </span>
              ) : null}
            </div>
            <CopyId label="节点 ID" value={runtimeId} />
            <p className="break-all text-muted-foreground">
              宿主：{preview.hostInstanceId ?? "尚未登记"}
            </p>
            <div>
              <Button asChild variant="secondary">
                <Link href={`${recoveryPath}?runtimeId=${runtimeId}`}>
                  查看此节点的待处理会话
                </Link>
              </Button>
            </div>
          </RecoveryCard>
          <RecoveryCard
            title={`当前影响范围 · ${preview.sessions.length} 个会话`}
          >
            <p className="leading-6 text-muted-foreground">
              排空作用于整个节点。仍合法运行的任务应先结束或由管理员另行取消；冻结新准入本身不会停止旧进程。
            </p>
            {preview.sessions.length ? (
              <div className="max-h-64 overflow-auto">
                <ul className="divide-y">
                  {preview.sessions.map((session) => (
                    <li
                      className="flex flex-wrap items-center gap-2 py-2"
                      key={session.sessionId}
                    >
                      <code className="break-all">{session.sessionId}</code>
                      <Badge
                        tone={session.closureVerifiedAt ? "success" : "warning"}
                      >
                        {session.closureVerifiedAt
                          ? "关闭已确认"
                          : "关闭未确认"}
                      </Badge>
                      <span className="text-muted-foreground">
                        {session.status}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-muted-foreground">
                当前没有待展示的会话。空列表不能替代旧会话的关闭证明。
              </p>
            )}
          </RecoveryCard>
          {preview.drainState === "NONE" ? (
            <RecoveryCard title="开始节点排空">
              <p className="leading-6">
                节点当前可正常准入。需要人工核验旧进程时，先检查上方范围，再冻结节点的新任务准入。
              </p>
              {drain?.resumedAt ? (
                <p className="text-muted-foreground">
                  上次恢复完成于 {recoveryDate(drain.resumedAt)}。
                </p>
              ) : null}
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer font-medium">
                  查看冻结影响与操作
                </summary>
                <div className="mt-3 grid gap-3">
                  <Alert variant="warning">
                    冻结后，整个节点将停止接收新任务。完成基础设施排空和证明核验后，还需使用恢复票据重新接入。
                  </Alert>
                  <div>
                    <Button
                      disabled={action.busy || resource.loading}
                      onClick={() =>
                        void action.act(async () => {
                          await consoleApi(`/runtimes/${runtimeId}/drain`, {
                            method: "POST",
                            body: JSON.stringify({
                              snapshotDigest: preview.snapshotDigest,
                            }),
                          });
                          setTerminationScope(null);
                          setStorageScope(null);
                          action.setNotice(
                            "已冻结节点的新任务准入。请按影响范围完成基础设施排空后提交证明。",
                          );
                          await refresh();
                        })
                      }
                    >
                      按当前范围冻结节点准入
                    </Button>
                  </div>
                </div>
              </details>
            </RecoveryCard>
          ) : null}
          {preview.drainState === "FROZEN" && drain?.state === "FROZEN" ? (
            <RecoveryCard title="提交排空证明">
              <p className="leading-6">
                请先停止原 Runtime
                服务，并核验原宿主对应的浏览器及网络进程范围已停止或销毁，且不会自动重启。节点离线后，再提交证据。
              </p>
              <form
                className="grid max-w-3xl gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!terminated) return;
                  void action.act(async () => {
                    const body = {
                      snapshotDigest: drain.snapshotDigest,
                      note: drainNote.trim(),
                      evidenceRefs: evidenceRefs(drainEvidence),
                      infrastructureTerminated: true,
                    };
                    try {
                      await consoleApi(
                        `/runtimes/${runtimeId}/drain/${drain.id}/attest`,
                        {
                          method: "POST",
                          body: JSON.stringify({
                            ...body,
                            idempotencyKey: action.idempotencyKey(
                              `drain:${drain.id}`,
                              body,
                            ),
                          }),
                        },
                      );
                      setDrainNote("");
                      setDrainEvidence("");
                      setTerminationScope(null);
                      action.setNotice(
                        "排空证明已提交。节点保持冻结，未知的业务写入仍需单独核实。",
                      );
                    } finally {
                      await refresh();
                    }
                  });
                }}
              >
                <Field
                  label="排空核验说明"
                  description="至少 10 个字符，说明已终止的服务和进程范围。"
                >
                  <Textarea
                    required
                    minLength={10}
                    maxLength={2000}
                    value={drainNote}
                    disabled={action.busy}
                    onChange={(event) => setDrainNote(event.target.value)}
                  />
                </Field>
                <Field label="基础设施证据引用（每行一条）">
                  <Textarea
                    required
                    value={drainEvidence}
                    disabled={action.busy}
                    onChange={(event) => setDrainEvidence(event.target.value)}
                  />
                </Field>
                {terminationScope && !terminated ? (
                  <Alert variant="warning">
                    节点范围已变化，说明与证据已保留。请重新核对并勾选确认。
                  </Alert>
                ) : null}
                <label className="flex items-start gap-2 leading-5">
                  <input
                    className="mt-1 size-3.5 shrink-0 accent-primary"
                    type="checkbox"
                    required
                    checked={terminated}
                    disabled={action.busy}
                    onChange={(event) =>
                      setTerminationScope(event.target.checked ? scope : null)
                    }
                  />
                  已核实当前范围内原宿主的浏览器及网络进程已停止或销毁，且不会自动重启。
                </label>
                {runtime?.status === "ONLINE" ? (
                  <p className="text-muted-foreground">
                    节点仍在线，请停止原服务并刷新状态后提交。
                  </p>
                ) : null}
                <div>
                  <Button
                    type="submit"
                    disabled={
                      action.busy ||
                      resource.loading ||
                      !runtime ||
                      runtime.status === "ONLINE" ||
                      !terminated ||
                      drainNote.trim().length < 10 ||
                      !evidenceRefs(drainEvidence).length
                    }
                  >
                    提交管理员排空证明
                  </Button>
                </div>
              </form>
            </RecoveryCard>
          ) : null}
          {drain?.state === "ATTESTED" &&
          ["ATTESTED", "RESUMING"].includes(preview.drainState) ? (
            <RecoveryCard title="恢复原节点">
              <Alert
                variant={
                  preview.drainState === "RESUMING" ? "default" : "success"
                }
                role="status"
              >
                {preview.drainState === "RESUMING"
                  ? "配对已受理，正在等待新的 Runtime 进程连接。请启动原服务，本页将自动更新状态。"
                  : "排空证明已核验。可签发一次性恢复票据，在原宿主重新配对。"}
              </Alert>
              <p className="leading-6 text-muted-foreground">
                恢复节点后，浏览器身份仍需重新验证，未知业务写入仍需分别核实。
              </p>
              <form
                className="grid max-w-3xl gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!preserved) return;
                  void action.act(async () => {
                    setResumeToken(null);
                    const token = await consoleApi<RuntimeDrainResumeToken>(
                      `/runtimes/${runtimeId}/drain/${drain.id}/resume-token`,
                      {
                        method: "POST",
                        body: JSON.stringify({
                          snapshotDigest: drain.snapshotDigest,
                          note: resumeNote.trim(),
                          evidenceRefs: evidenceRefs(resumeEvidence),
                          profileStoragePreserved: true,
                        }),
                      },
                    );
                    setResumeToken(token);
                    action.setNotice(
                      "恢复票据已签发，旧票据已废弃。请在 10 分钟内于原宿主使用。",
                    );
                    await refresh();
                  });
                }}
              >
                <p className="leading-6">
                  签发前先停止原 Runtime 服务并确认节点离线，保留原安装的
                  HOME、instanceKey 和 Profile 目录。重新签发会废弃此前票据。
                </p>
                <Field
                  label="恢复核验说明"
                  description="至少 10 个字符，说明原服务、保留的目录及恢复计划。"
                >
                  <Textarea
                    required
                    minLength={10}
                    maxLength={2000}
                    value={resumeNote}
                    disabled={action.busy}
                    onChange={(event) => setResumeNote(event.target.value)}
                  />
                </Field>
                <Field
                  label="原宿主与存储核验证据（每行一条）"
                  description="填写运维工单、存储检查等引用；勿填写口令、Cookie 或令牌。"
                >
                  <Textarea
                    required
                    value={resumeEvidence}
                    disabled={action.busy}
                    onChange={(event) => setResumeEvidence(event.target.value)}
                  />
                </Field>
                {storageScope && !preserved ? (
                  <Alert variant="warning">
                    节点范围已变化，草稿已保留。请重新核对存储与宿主。
                  </Alert>
                ) : null}
                <label className="flex items-start gap-2 leading-5">
                  <input
                    className="mt-1 size-3.5 shrink-0 accent-primary"
                    type="checkbox"
                    required
                    checked={preserved}
                    disabled={action.busy}
                    onChange={(event) =>
                      setStorageScope(event.target.checked ? scope : null)
                    }
                  />
                  已核实原宿主的 Profile 存储完整保留，将使用原安装的 HOME 和
                  instanceKey 恢复。
                </label>
                {runtime?.status === "ONLINE" ? (
                  <p className="text-muted-foreground">
                    节点仍在线，请停止原服务并刷新状态后签发。
                  </p>
                ) : null}
                <div>
                  <Button
                    type="submit"
                    disabled={
                      action.busy ||
                      resource.loading ||
                      !runtime ||
                      runtime.status === "ONLINE" ||
                      !preserved ||
                      resumeNote.trim().length < 10 ||
                      !evidenceRefs(resumeEvidence).length
                    }
                  >
                    {resumeToken || preview.drainState === "RESUMING"
                      ? "重新签发恢复票据"
                      : "签发一次性恢复票据"}
                  </Button>
                </div>
              </form>
              {resumeToken ? (
                <section
                  className="grid gap-3 rounded-lg border bg-muted/30 p-4"
                  aria-label="一次性恢复票据"
                >
                  <p>
                    票据有效期至 {recoveryDate(resumeToken.expiresAt)}
                    。仅在本页面临时显示，重新加载页面、离开或隐藏后无法再次查看。
                  </p>
                  <CopyId
                    label="原安装 instanceKey"
                    value={resumeToken.instanceKey}
                  />
                  <Field label="一次性恢复票据">
                    <Textarea
                      readOnly
                      autoComplete="off"
                      spellCheck={false}
                      value={resumeToken.pairingToken}
                    />
                  </Field>
                  <ol className="list-decimal space-y-2 pl-4 leading-6">
                    <li>
                      在原宿主使用原服务用户，保留原 HOME、DEVPROOF_RUNTIME_HOME
                      和 instanceKey；确认旧服务已停止。
                    </li>
                    <li>
                      运行下列命令，在标准输入中粘贴票据，换行后以 Ctrl-D
                      结束输入。
                      <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-[11px]">
                        {"DEVPROOF_INSTANCE_KEY=" +
                          shellQuote(resumeToken.instanceKey) +
                          ' "$HOME/.local/bin/devproof-browser-runtime" pair --api ' +
                          shellQuote(runtimeApiUrl) +
                          " --token-stdin"}
                      </pre>
                    </li>
                    <li>
                      配对成功后启动原 Runtime
                      服务，本页将检查新进程是否完成连接。
                    </li>
                  </ol>
                  <div>
                    <Button
                      variant="secondary"
                      onClick={() => setResumeToken(null)}
                    >
                      隐藏恢复票据
                    </Button>
                  </div>
                </section>
              ) : null}
            </RecoveryCard>
          ) : null}
          {drain ? (
            <details className="rounded-lg border bg-card p-4">
              <summary className="cursor-pointer font-medium">
                排空审计信息
              </summary>
              <div className="mt-3 grid gap-2">
                <CopyId label="排空操作 ID" value={drain.id} />
                <p>状态：{drainLabel[drain.state] ?? drain.state}</p>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-[11px]">
                  {JSON.stringify(drain.frozenSessions, null, 2)}
                </pre>
              </div>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
