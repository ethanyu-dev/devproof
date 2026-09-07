"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, CheckCircle2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { FormMessage, LoadingState } from "@/components/settings-layout";
import { consoleApi } from "@/lib/api";
import { displayLabel } from "@/lib/display-text";

interface RunDetail {
  artifacts: Array<{
    downloadUrl: string | null;
    id: string;
    kind: string;
  }>;
  assertions: Array<{
    criterionId: string;
    evidenceRefs: string[];
    id: string;
    status: string;
    summary: string;
  }>;
  checkpoints: Array<{
    expiresAt: string;
    id: string;
    prompt: string;
    response: unknown;
    status: string;
  }>;
  events: Array<{
    actor: string;
    kind: string;
    occurredAt: string;
    payload: unknown;
    sequence: string;
    status: string;
    durationMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    credentialId: string | null;
    requestId: string | null;
    traceId: string | null;
    toolInvocationId: string | null;
  }>;
  notificationOutbox: Array<{
    attempts: number;
    id: string;
    status: string;
  }>;
  requestSnapshot: Record<string, unknown> & {
    acceptanceCriteria: Array<{ description: string; id: string }>;
  };
  error: unknown;
  goal: string;
  id: string;
  result: unknown;
  runtimeSessionId: string | null;
  traceId: string;
  status: string;
  callerCredential: { id: string; name: string; tokenHint: string };
  toolInvocations: Array<{
    clientName: string | null;
    completedAt: string | null;
    credential: { name: string; tokenHint: string };
    durationMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    id: string;
    inputSummary: unknown;
    mcpRequestId: string | null;
    requestId: string;
    spanId: string;
    startedAt: string;
    status: string;
    toolName: string;
    traceId: string;
    transport: string;
  }>;
  runtimeSession: null | {
    commands: Array<{
      commandType: string;
      completedAt: string | null;
      createdAt: string;
      durationMs?: number;
      error: unknown;
      id: string;
      inputSummary: unknown;
      source: string;
      status: string;
    }>;
    events: Array<{
      id: string;
      kind: string;
      occurredAt: string;
      payload: unknown;
    }>;
    id: string;
    runtime: { id: string; name: string; status: string };
    status: string;
  };
}

function tone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "PASSED" || status === "DELIVERED" || status === "RESOLVED")
    return "success";
  if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(status)) return "danger";
  if (
    ["WAITING_EXECUTION", "RUNNING", "WAITING_HUMAN", "PENDING"].includes(
      status,
    )
  )
    return "warning";
  return "neutral";
}

export function VerificationsClient({ initialId }: { initialId: string }) {
  return <VerificationDetailClient id={initialId} />;
}

function VerificationDetailClient({ id }: { id: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [message, setMessage] = useState<{
    text: string;
    tone: "error" | "success";
  } | null>(null);

  const load = useCallback(async () => {
    setDetail(await consoleApi<RunDetail>(`/verifications/${id}`));
  }, [id]);

  useEffect(() => {
    void load().catch((error: Error) =>
      setMessage({ text: error.message, tone: "error" }),
    );
  }, [load]);

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button asChild variant="secondary">
              <Link href="/console/verifications">
                <ArrowLeft /> 返回列表
              </Link>
            </Button>
            <Button
              onClick={() =>
                void load().catch((error: Error) =>
                  setMessage({ text: error.message, tone: "error" }),
                )
              }
              variant="secondary"
            >
              <RefreshCw /> 刷新
            </Button>
          </>
        }
        description="历史验证记录，仅供查阅。新任务请通过统一 Task 入口创建。"
        title="历史验证详情"
      />
      {message ? (
        <div className="dp-runtime-message">
          <FormMessage message={message.text} tone={message.tone} />
        </div>
      ) : null}
      {!detail ? (
        <Card>
          <LoadingState />
        </Card>
      ) : (
        <div className="dp-verification-history">
          <Card className="dp-verification-detail">
            <div className="dp-section-head">
              <span>
                <CheckCircle2 />
                <b>{detail.id}</b>
              </span>
              <Badge tone={tone(detail.status)}>
                {displayLabel(detail.status)}
              </Badge>
            </div>
            <div className="dp-verification-actions">
              <p>{detail.goal}</p>
              <small>
                追踪 ID {detail.traceId} · 凭证 {detail.callerCredential.name}{" "}
                {detail.callerCredential.tokenHint}
              </small>
            </div>

            <section className="dp-observe-section">
              <h3>事件 Trace · {detail.events.length}</h3>
              <div className="dp-event-stream">
                {detail.events.map((event) => (
                  <div key={event.sequence}>
                    <i>{event.sequence}</i>
                    <span>
                      <strong>{displayLabel(event.kind)}</strong>
                      <small>
                        {displayLabel(event.actor)} ·{" "}
                        {displayLabel(event.status)} ·{" "}
                        {new Date(event.occurredAt).toLocaleString("zh-CN")}
                        {event.durationMs === null
                          ? ""
                          : ` · ${event.durationMs} ms`}
                      </small>
                      <details className="dp-trace-details">
                        <summary>关联信息与原始数据</summary>
                        <pre>{JSON.stringify(event, null, 2)}</pre>
                      </details>
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {detail.assertions.length > 0 ? (
              <TraceDetails
                items={detail.assertions}
                label="验收断言"
                toneFor={(item) => tone(item.status)}
              />
            ) : null}
            {detail.checkpoints.length > 0 ? (
              <TraceDetails
                items={detail.checkpoints}
                label="人工检查点"
                toneFor={(item) => tone(item.status)}
              />
            ) : null}
            {detail.toolInvocations.length > 0 ? (
              <section className="dp-observe-section">
                <h3>工具调用 · {detail.toolInvocations.length}</h3>
                <div className="dp-observe-table">
                  {detail.toolInvocations.map((invocation) => (
                    <details key={invocation.id}>
                      <summary>
                        <Badge tone={tone(invocation.status)}>
                          {displayLabel(invocation.status)}
                        </Badge>
                        <b>{invocation.toolName}</b>
                        <span className="dp-observe-meta">
                          {invocation.transport} ·{" "}
                          {invocation.durationMs ?? "—"} ms ·{" "}
                          {invocation.credential.name}
                        </span>
                      </summary>
                      <pre>{JSON.stringify(invocation, null, 2)}</pre>
                    </details>
                  ))}
                </div>
              </section>
            ) : null}
            {detail.runtimeSession ? (
              <>
                <section className="dp-observe-section">
                  <h3>
                    执行节点命令 · {detail.runtimeSession.runtime.name} ·{" "}
                    {displayLabel(detail.runtimeSession.status)}
                  </h3>
                  <div className="dp-observe-table">
                    {detail.runtimeSession.commands.map((command) => (
                      <details key={command.id}>
                        <summary>
                          <Badge tone={tone(command.status)}>
                            {displayLabel(command.status)}
                          </Badge>
                          <b>{displayLabel(command.commandType)}</b>
                          <span className="dp-observe-meta">
                            {displayLabel(command.source)}
                          </span>
                        </summary>
                        <pre>{JSON.stringify(command, null, 2)}</pre>
                      </details>
                    ))}
                  </div>
                </section>
                {detail.runtimeSession.events.length > 0 ? (
                  <TraceDetails
                    items={detail.runtimeSession.events}
                    label="执行节点事件"
                  />
                ) : null}
              </>
            ) : null}
            {detail.notificationOutbox.length > 0 ? (
              <TraceDetails
                items={detail.notificationOutbox}
                label="通知投递"
                toneFor={(item) => tone(item.status)}
              />
            ) : null}
            {detail.artifacts.length > 0 ? (
              <div className="dp-artifact-links">
                {detail.artifacts.map((artifact) =>
                  artifact.downloadUrl ? (
                    <a
                      href={artifact.downloadUrl}
                      key={artifact.id}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {displayLabel(artifact.kind)} · {artifact.id.slice(0, 8)}
                    </a>
                  ) : null,
                )}
              </div>
            ) : null}
            <section className="dp-observe-section">
              <h3>请求与执行结果</h3>
              <div className="dp-observe-table">
                <details>
                  <summary>
                    <b>原始请求快照</b>
                  </summary>
                  <pre>{JSON.stringify(detail.requestSnapshot, null, 2)}</pre>
                </details>
                {detail.result ? (
                  <details>
                    <summary>
                      <b>执行结果</b>
                    </summary>
                    <pre>{JSON.stringify(detail.result, null, 2)}</pre>
                  </details>
                ) : null}
                {detail.error ? (
                  <details open>
                    <summary>
                      <b>错误信息</b>
                    </summary>
                    <pre>{JSON.stringify(detail.error, null, 2)}</pre>
                  </details>
                ) : null}
              </div>
            </section>
          </Card>
        </div>
      )}
    </>
  );
}

function TraceDetails<T extends { id: string }>({
  items,
  label,
  toneFor,
}: {
  items: T[];
  label: string;
  toneFor?: (item: T) => "success" | "warning" | "danger" | "neutral";
}) {
  return (
    <section className="dp-observe-section">
      <h3>
        {label} · {items.length}
      </h3>
      <div className="dp-observe-table">
        {items.map((item, index) => (
          <details key={item.id}>
            <summary>
              {toneFor && "status" in item ? (
                <Badge tone={toneFor(item)}>
                  {displayLabel(String(item.status))}
                </Badge>
              ) : null}
              <b>
                {"kind" in item
                  ? displayLabel(String(item.kind))
                  : "summary" in item
                    ? String(item.summary)
                    : "prompt" in item
                      ? String(item.prompt)
                      : `${label} ${index + 1}`}
              </b>
            </summary>
            <pre>{JSON.stringify(item, null, 2)}</pre>
          </details>
        ))}
      </div>
    </section>
  );
}
