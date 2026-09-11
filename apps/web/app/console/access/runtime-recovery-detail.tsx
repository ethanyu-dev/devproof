"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import type {
  RuntimeRecoveryDetail,
  RuntimeRecoveryResolveWriteOutcome,
} from "@devproof/contracts";
import { PageHeader } from "@/components/page-header";
import { LoadingState } from "@/components/settings-layout";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { consoleApi } from "@/lib/api";
import { useRecoveryResource } from "./use-recovery-resource";
import {
  recoveryGuidance,
  recoveryNeedsWriteReview,
  recoveryWriteLabel,
  recoveryWriteReviewGuidance,
} from "./runtime-recovery-display";
import {
  CopyId,
  RecoveryBadges,
  RecoveryCard,
  RecoveryFeedback,
  evidenceRefs,
  recoveryDate,
  recoveryPath,
  runtimeRecoveryPath,
  useRecoveryAction,
} from "./recovery-ui";

const emptyReview = {
  note: "",
  evidence: "",
  outcome: "VERIFIED" as RuntimeRecoveryResolveWriteOutcome["outcome"],
};
export function RuntimeRecoveryDetailView({
  id,
  listQuery,
}: {
  id: string;
  listQuery: string;
}) {
  const action = useRecoveryAction();
  const resource = useRecoveryResource<RuntimeRecoveryDetail>(
    `/runtime-recoveries/${id}`,
    action.busy,
  );
  const [review, setReview] = useState(emptyReview);
  const [reviewVersion, setReviewVersion] = useState<number | null>(null);
  const item = resource.data;
  const changed =
    reviewVersion !== null && item !== null && reviewVersion !== item.version;
  function editReview(patch: Partial<typeof review>) {
    setReviewVersion((old) => old ?? item?.version ?? null);
    setReview((old) => ({ ...old, ...patch }));
  }
  return (
    <div className="grid min-w-0 gap-4 text-xs">
      <PageHeader
        title="恢复详情"
        description="分别查看关闭证明、业务结果与实际保护范围。未知结果不表示已发生写入；恢复操作需要当前团队管理员权限。"
        actions={
          <>
            <Button asChild variant="secondary">
              <Link href={`${recoveryPath}${listQuery ? `?${listQuery}` : ""}`}>
                <ArrowLeft />
                返回恢复记录
              </Link>
            </Button>
            <Button
              variant="secondary"
              disabled={resource.loading || action.busy}
              onClick={() => void resource.refresh()}
            >
              <RefreshCw />
              刷新状态
            </Button>
          </>
        }
      />
      <RecoveryFeedback
        error={action.error ?? resource.error}
        notice={action.notice}
      />
      {!item && resource.loading ? <LoadingState /> : null}
      {item ? (
        <>
          <RecoveryCard title="会话状态">
            <RecoveryBadges item={item} />
            <div className="grid gap-2">
              <CopyId label="会话 ID" value={item.sessionId} />
              <CopyId label="节点 ID" value={item.runtimeId} />
              <CopyId label="恢复记录 ID" value={item.id} />
            </div>
            <p className="text-muted-foreground">
              首次发现 {recoveryDate(item.createdAt)} · 最近变化{" "}
              {recoveryDate(item.updatedAt)} · 已尝试 {item.attempts} 次
            </p>
            {item.resolvedAt ? (
              <p className="text-success">
                已于 {recoveryDate(item.resolvedAt)} 完成恢复处理。
              </p>
            ) : null}
            {item.sourceRunId ? (
              <div>
                <Button asChild variant="secondary">
                  <Link href={`/console/executions/${item.sourceRunId}`}>
                    查看关联执行
                    <ArrowRight />
                  </Link>
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground">
                此会话没有关联执行记录，可根据会话和节点 ID 核对历史日志。
              </p>
            )}
          </RecoveryCard>
          <RecoveryCard title="浏览器关闭">
            <p className="leading-6">
              {recoveryGuidance(item.closureState, item.lastErrorCode)}
            </p>
            {item.nextAttemptAt && !item.resolvedAt ? (
              <p className="text-muted-foreground">
                下次检查：{recoveryDate(item.nextAttemptAt)}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {["NEEDS_OPERATOR", "RETRY_WAIT", "WAITING_RUNTIME"].includes(
                item.closureState,
              ) ? (
                <Button
                  variant="secondary"
                  disabled={action.busy || resource.loading}
                  onClick={() =>
                    void action.act(async () => {
                      try {
                        await consoleApi(
                          `/runtime-recoveries/${item.id}/retry`,
                          {
                            method: "POST",
                            body: JSON.stringify({
                              expectedVersion: item.version,
                            }),
                          },
                        );
                        action.setNotice(
                          "已请求重新检查，关闭证明要求保持不变。",
                        );
                      } finally {
                        await resource.refresh();
                      }
                    })
                  }
                >
                  条件变化后重试关闭
                </Button>
              ) : null}
              {item.closureState !== "OBSERVED" ? (
                <Button asChild variant="secondary">
                  <Link href={runtimeRecoveryPath(item.runtimeId)}>
                    查看节点排空与恢复
                    <ArrowRight />
                  </Link>
                </Button>
              ) : null}
            </div>
          </RecoveryCard>
          <RecoveryCard title="业务写入结果">
            <p className="font-medium">
              {recoveryWriteLabel(item.writeOutcomeState)}
            </p>
            {item.closureState !== "VERIFIED" &&
            ["UNKNOWN", "UNASSESSED"].includes(item.writeOutcomeState) ? (
              <p className="leading-6 text-muted-foreground">
                关闭尚未确认，暂不可提交业务核实。系统继续保留相关数据保护；这表示结果未知，并不代表数据已损坏。
              </p>
            ) : null}
            {recoveryNeedsWriteReview(item) ? (
              <form
                className="grid max-w-3xl gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (changed) return;
                  void action.act(async () => {
                    const body = {
                      expectedVersion: reviewVersion ?? item.version,
                      note: review.note.trim(),
                      outcome: review.outcome,
                      evidenceRefs: evidenceRefs(review.evidence),
                    };
                    try {
                      await consoleApi(
                        `/runtime-recoveries/${item.id}/resolve-write-outcome`,
                        {
                          method: "POST",
                          body: JSON.stringify({
                            ...body,
                            idempotencyKey: action.idempotencyKey(
                              `resolve:${item.id}`,
                              body,
                            ),
                          }),
                        },
                      );
                      setReview(emptyReview);
                      setReviewVersion(null);
                      action.setNotice(
                        "核实结果已保存，符合条件的数据保护已释放。",
                      );
                    } finally {
                      await resource.refresh();
                    }
                  });
                }}
              >
                <p className="leading-6 text-muted-foreground">
                  {recoveryWriteReviewGuidance(item.guards)}
                </p>
                {changed ? (
                  <Alert variant="warning">
                    <p>
                      恢复状态已变化，草稿已保留。请核对本页最新状态后继续。
                    </p>
                    <Button
                      className="mt-2"
                      type="button"
                      variant="secondary"
                      onClick={() => setReviewVersion(item.version)}
                    >
                      已核对最新状态，继续使用草稿
                    </Button>
                  </Alert>
                ) : null}
                <Field label="核实结果">
                  <Select
                    value={review.outcome}
                    disabled={action.busy}
                    onChange={(event) =>
                      editReview({
                        outcome: event.target.value as typeof review.outcome,
                      })
                    }
                  >
                    <option value="VERIFIED">已核对最终业务状态</option>
                    <option value="NO_WRITE">已证实没有写入</option>
                    <option value="COMPENSATED">已完成补偿并核对状态</option>
                  </Select>
                </Field>
                <Field
                  label="核实说明"
                  description="至少 10 个字符，说明核对了哪些业务状态及结果。"
                >
                  <Textarea
                    required
                    minLength={10}
                    maxLength={2000}
                    value={review.note}
                    disabled={action.busy}
                    onChange={(event) =>
                      editReview({ note: event.target.value })
                    }
                  />
                </Field>
                <Field
                  label="证据引用（每行一条）"
                  description="填写审计记录或运维工单引用；请勿填写口令、Cookie 或令牌。"
                >
                  <Textarea
                    required
                    value={review.evidence}
                    disabled={action.busy}
                    onChange={(event) =>
                      editReview({ evidence: event.target.value })
                    }
                  />
                </Field>
                <div>
                  <Button
                    type="submit"
                    disabled={
                      action.busy ||
                      changed ||
                      resource.loading ||
                      review.note.trim().length < 10 ||
                      !evidenceRefs(review.evidence).length
                    }
                  >
                    保存核实结果
                  </Button>
                </div>
              </form>
            ) : null}
          </RecoveryCard>
          <details className="rounded-lg border bg-card p-4">
            <summary className="cursor-pointer font-medium">
              诊断与审计信息
            </summary>
            <div className="mt-4 grid gap-3">
              <p>
                原因：{item.reason} · 版本：{item.version}
              </p>
              {item.lastErrorCode ? (
                <p>
                  最近错误码：<code>{item.lastErrorCode}</code>
                </p>
              ) : null}
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-[11px]">
                {JSON.stringify(
                  {
                    scope: item.scopeSnapshot,
                    evidence: item.evidence,
                    guards: item.guards,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}
