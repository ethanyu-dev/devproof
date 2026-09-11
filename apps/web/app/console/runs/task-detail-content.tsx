"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/native-select";
import type {
  ExecutionConcurrencyPolicy,
  RunTrajectoryRecord,
} from "@devproof/contracts";
import {
  ArrowRight,
  ChevronDown,
  ExternalLink,
  FileSearch,
  PlayCircle,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { FormMessage } from "@/components/settings-layout";
import { consoleApi } from "@/lib/api";
import { displayLabel } from "@/lib/display-text";
import { retainedProfilePolicy } from "./profile-policy";
import { TaskLogs } from "./task-logs";
import { caseDescription, latestTaskCaseExecutions } from "./task-case-display";
import styles from "./task-detail.module.css";
import { executionHref } from "./task-navigation";
import {
  executionSchedulingLabel,
  schedulingWaitText,
  taskOutcomeDisplay,
} from "./task-outcome";
import {
  terminalLifecycles,
  tone,
  errorMessage,
  prettyValue,
} from "./task-display";
import type {
  TaskCase,
  TaskCaseExecution,
  TaskDetail,
  TaskEvent,
  TaskScheduling,
  TaskStage,
} from "./task-types";

type ProfileStrategy =
  "EPHEMERAL" | "REQUESTER" | "ISSUE_ASSIGNEE" | "EXPLICIT_PROFILE";

const profileStrategyDescriptions = {
  EPHEMERAL: "使用全新临时会话，不读取或保留任何持久化登录状态。",
  EXPLICIT_PROFILE:
    "从你自己的可用浏览器身份中明确指定一个；系统不会自动创建。",
  ISSUE_ASSIGNEE:
    "使用 Linear Issue 当前负责人的浏览器身份；负责人需要已关联 DevProof 用户。",
  REQUESTER:
    "使用任务请求人的浏览器身份；如果当前任务没有请求人，你将认领该任务并自动创建所需身份。",
} as const;

function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function TaskDetailContent({
  busy,
  detail,
  onMutate,
  trajectory,
  view,
  events,
  eventsError,
  eventsLoading,
  onRetryEvents,
  taskHref,
}: {
  busy: boolean;
  detail: TaskDetail;
  onMutate: (path: string, body?: unknown) => Promise<TaskDetail | null>;
  trajectory: RunTrajectoryRecord[];
  view: "logs" | "specs";
  events: TaskEvent[];
  eventsError: string | null;
  eventsLoading: boolean;
  onRetryEvents: () => void;
  taskHref: string;
}) {
  const [profileError, setProfileError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [deploymentDrafts, setDeploymentDrafts] = useState([
    { id: 1, name: "Preview", targetUrl: "" },
  ]);
  const [profileStrategy, setProfileStrategy] =
    useState<ProfileStrategy>("EPHEMERAL");
  const [profileId, setProfileId] = useState("");
  const [profiles, setProfiles] = useState<
    Array<{ displayName: string; id: string; status: string }>
  >([]);
  const boundProfile =
    detail.profileBinding?.requestedProfile ??
    detail.profileBinding?.resolvedProfile ??
    null;
  const profileNeedsInput = detail.profileBinding?.status === "WAITING_INPUT";
  const explicitBoundProfile =
    detail.profileBinding?.strategy === "EXPLICIT_PROFILE"
      ? boundProfile
      : null;
  const stages = (
    ["SPEC_ANALYSIS", "PROFILE_RESOLUTION", "SPEC_EXECUTION"] as const
  ).flatMap((type) => {
    const stage = detail.stages.find((item) => item.type === type);
    return stage ? [stage] : [];
  });
  const analysis = detail.stages.find(
    (stage) => stage.type === "SPEC_ANALYSIS",
  );
  const analysisFailure =
    analysis?.lastError ??
    [...(analysis?.attempts ?? [])].reverse().find((attempt) => attempt.error)
      ?.error;
  const showStages =
    !terminalLifecycles.has(detail.lifecycle) ||
    Boolean(detail.waitingReason) ||
    stages.some((stage) => ["FAILED", "RUNNING"].includes(stage.status));

  useEffect(() => {
    if (
      detail.waitingReason !== "DEPLOYMENT_TARGET_REQUIRED" &&
      !profileNeedsInput
    )
      return;
    const controller = new AbortController();
    setProfileError(null);
    void consoleApi<Array<{ displayName: string; id: string; status: string }>>(
      "/browser-profiles",
      { signal: controller.signal },
    )
      .then((next) => {
        if (!controller.signal.aborted) setProfiles(next);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setProfileError((error as Error).message);
      });
    return () => controller.abort();
  }, [detail.waitingReason, profileNeedsInput]);

  useEffect(() => {
    const strategy = detail.profileBinding?.strategy;
    if (
      strategy &&
      ["EPHEMERAL", "REQUESTER", "ISSUE_ASSIGNEE", "EXPLICIT_PROFILE"].includes(
        strategy,
      )
    ) {
      setProfileStrategy(strategy as ProfileStrategy);
      setProfileId(
        strategy === "EXPLICIT_PROFILE" ? (boundProfile?.id ?? "") : "",
      );
    }
  }, [boundProfile?.id, detail.id, detail.profileBinding?.strategy]);

  const currentProfilePolicy = retainedProfilePolicy(detail.input);
  const profileSelection = (strategy: ProfileStrategy = profileStrategy) => ({
    profilePolicy: {
      onUnavailable: currentProfilePolicy.onUnavailable,
      ...(strategy === "EXPLICIT_PROFILE" ? { profileId } : {}),
      scope: currentProfilePolicy.scope,
      strategy,
    },
  });

  async function submitDeployments() {
    const deployments = deploymentDrafts
      .filter((deployment) => deployment.targetUrl.trim())
      .map((deployment, index) => ({
        environment: {},
        key: `deployment-${index + 1}`,
        name: deployment.name.trim() || `验证环境 ${index + 1}`,
        targetUrl: deployment.targetUrl.trim(),
      }));
    if (
      profileStrategy !== detail.profileBinding?.strategy ||
      (profileStrategy === "EXPLICIT_PROFILE" &&
        profileId !== (boundProfile?.id ?? ""))
    ) {
      const updated = await onMutate("/profile", profileSelection());
      if (!updated) return;
    }
    await onMutate("/deployments", { deployments });
  }

  async function exportAllLogs() {
    setExporting(true);
    setExportError(null);
    try {
      const exported = await consoleApi<unknown>(
        `/tasks/${detail.id}/logs/export`,
      );
      const timestamp = new Date().toISOString().replaceAll(":", "-");
      downloadJson(
        exported,
        `devproof-task-${detail.id}-logs-${timestamp}.json`,
      );
    } catch (error) {
      setExportError((error as Error).message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <section
        className="dp-task-detail-section"
        aria-label={detail.kind === "ISSUE_SPEC" ? "执行用例" : "执行记录"}
        hidden={view !== "specs"}
      >
        {profileError && <FormMessage message={profileError} tone="error" />}
        {showStages ? (
          <div className="dp-task-stage-grid">
            {stages.map((stage, index) => (
              <StageCard
                allowRetry={detail.kind === "ISSUE_SPEC"}
                busy={busy}
                index={index + 1}
                key={stage.id}
                onRetry={() =>
                  void onMutate(`/stages/${stage.type}/retry`, {
                    reason: "Manual retry from console",
                  })
                }
                stage={stage}
              />
            ))}
          </div>
        ) : null}

        {analysis?.status === "FAILED" && analysisFailure ? (
          <div className="dp-task-analysis-failure" role="alert">
            <div>
              <Badge tone="danger">Spec 分析失败</Badge>
              <strong>
                {errorMessage(analysisFailure) ??
                  "分析 Worker 未返回可读错误信息。"}
              </strong>
            </div>
            <details>
              <summary>查看完整失败原因</summary>
              <pre>{prettyValue(analysisFailure)}</pre>
            </details>
          </div>
        ) : null}

        {detail.waitingReason === "DEPLOYMENT_TARGET_REQUIRED" ? (
          <Card className="dp-task-input-card">
            <div className="dp-section-head">
              <span>
                <PlayCircle />
                <b>继续 Spec 执行</b>
              </span>
              <Badge tone="warning">等待部署地址</Badge>
            </div>
            <div className="dp-task-form">
              <Field label="验证环境（可添加多个）">
                <div className="dp-deployment-editor">
                  {deploymentDrafts.map((deployment, index) => (
                    <div className="dp-deployment-row" key={deployment.id}>
                      <Input
                        aria-label={`验证环境 ${index + 1} 名称`}
                        onChange={(event) =>
                          setDeploymentDrafts((current) =>
                            current.map((item) =>
                              item.id === deployment.id
                                ? { ...item, name: event.target.value }
                                : item,
                            ),
                          )
                        }
                        placeholder="环境名称"
                        value={deployment.name}
                      />
                      <Input
                        aria-label={`验证环境 ${index + 1} URL`}
                        onChange={(event) =>
                          setDeploymentDrafts((current) =>
                            current.map((item) =>
                              item.id === deployment.id
                                ? { ...item, targetUrl: event.target.value }
                                : item,
                            ),
                          )
                        }
                        placeholder="https://preview.example.com"
                        value={deployment.targetUrl}
                      />
                      {deploymentDrafts.length > 1 ? (
                        <Button
                          onClick={() =>
                            setDeploymentDrafts((current) =>
                              current.filter(
                                (item) => item.id !== deployment.id,
                              ),
                            )
                          }
                          variant="secondary"
                        >
                          删除
                        </Button>
                      ) : null}
                    </div>
                  ))}
                  <Button
                    disabled={deploymentDrafts.length >= 20}
                    onClick={() =>
                      setDeploymentDrafts((current) => [
                        ...current,
                        {
                          id:
                            Math.max(0, ...current.map((item) => item.id)) + 1,
                          name: `验证环境 ${current.length + 1}`,
                          targetUrl: "",
                        },
                      ])
                    }
                    variant="secondary"
                  >
                    添加验证环境
                  </Button>
                </div>
              </Field>
              <Field
                description={profileStrategyDescriptions[profileStrategy]}
                label="页面登录方式"
              >
                <Select
                  onChange={(event) =>
                    setProfileStrategy(event.target.value as ProfileStrategy)
                  }
                  value={profileStrategy}
                >
                  <option value="EPHEMERAL">不需要登录（临时会话）</option>
                  <option value="REQUESTER">使用我的浏览器身份</option>
                  <option value="ISSUE_ASSIGNEE">
                    使用 Issue 负责人的浏览器身份
                  </option>
                  <option value="EXPLICIT_PROFILE">指定我的浏览器身份</option>
                </Select>
              </Field>
              {profileStrategy === "EXPLICIT_PROFILE" ? (
                <Field label="可用浏览器身份">
                  <Select
                    value={profileId}
                    onChange={(event) => setProfileId(event.target.value)}
                  >
                    <option value="">请选择</option>
                    {explicitBoundProfile &&
                    !profiles.some(
                      (profile) =>
                        profile.id === explicitBoundProfile.id &&
                        profile.status === "READY",
                    ) ? (
                      <option value={explicitBoundProfile.id}>
                        {explicitBoundProfile.displayName}（
                        {displayLabel(explicitBoundProfile.status)}）
                      </option>
                    ) : null}
                    {profiles
                      .filter((profile) => profile.status === "READY")
                      .map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.displayName}
                        </option>
                      ))}
                  </Select>
                </Field>
              ) : null}
              <Button
                disabled={
                  busy ||
                  !deploymentDrafts.some((deployment) =>
                    Boolean(deployment.targetUrl.trim()),
                  ) ||
                  (profileStrategy === "EXPLICIT_PROFILE" && !profileId)
                }
                onClick={() => void submitDeployments()}
              >
                提交并执行全部 Spec × Deployment
              </Button>
            </div>
          </Card>
        ) : null}

        {profileNeedsInput && detail.profileBinding?.requestedProfile ? (
          <Card className="dp-task-input-card">
            <div className="dp-section-head">
              <span>
                <PlayCircle />
                <b>完成网页登录</b>
              </span>
              <Badge tone="warning">等待浏览器身份所有人</Badge>
            </div>
            <div className="dp-task-form">
              <p>
                系统已根据任务目标自动准备浏览器身份「
                {detail.profileBinding.requestedProfile.displayName}
                」。无需填写域名或验证规则，
                {detail.profileBinding.requestedProfile.owner.name}
                只需完成登录并确认授权。
              </p>
              <p>
                如果这个 Issue
                验证的是公开页面、不需要登录，可以直接改用临时会话。
              </p>
              <div className="dp-form-actions">
                <Button asChild>
                  <Link
                    href={`/console/profiles?profile=${detail.profileBinding.requestedProfile.id}`}
                  >
                    前往登录
                  </Link>
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void onMutate("/profile", profileSelection("EPHEMERAL"))
                  }
                  variant="secondary"
                >
                  无需登录，继续执行
                </Button>
              </div>
            </div>
          </Card>
        ) : profileNeedsInput ? (
          <Card className="dp-task-input-card">
            <div className="dp-section-head">
              <span>
                <PlayCircle />
                <b>选择浏览器登录身份</b>
              </span>
              <Badge tone="warning">等待浏览器身份</Badge>
            </div>
            <div className="dp-task-form">
              <Field
                description={profileStrategyDescriptions[profileStrategy]}
                label="浏览器身份策略"
              >
                <Select
                  onChange={(event) =>
                    setProfileStrategy(event.target.value as ProfileStrategy)
                  }
                  value={profileStrategy}
                >
                  <option value="REQUESTER">使用我的浏览器身份</option>
                  <option value="ISSUE_ASSIGNEE">
                    使用 Issue 负责人的浏览器身份
                  </option>
                  <option value="EXPLICIT_PROFILE">指定我的浏览器身份</option>
                  <option value="EPHEMERAL">改用临时会话</option>
                </Select>
              </Field>
              {profileStrategy === "EXPLICIT_PROFILE" ? (
                <Field label="可用浏览器身份">
                  <Select
                    value={profileId}
                    onChange={(event) => setProfileId(event.target.value)}
                  >
                    <option value="">请选择</option>
                    {explicitBoundProfile &&
                    !profiles.some(
                      (profile) =>
                        profile.id === explicitBoundProfile.id &&
                        profile.status === "READY",
                    ) ? (
                      <option value={explicitBoundProfile.id}>
                        {explicitBoundProfile.displayName}（
                        {displayLabel(explicitBoundProfile.status)}）
                      </option>
                    ) : null}
                    {profiles
                      .filter((profile) => profile.status === "READY")
                      .map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.displayName}
                        </option>
                      ))}
                  </Select>
                </Field>
              ) : null}
              <Button
                disabled={
                  busy || (profileStrategy === "EXPLICIT_PROFILE" && !profileId)
                }
                onClick={() => void onMutate("/profile", profileSelection())}
              >
                提交身份选择
              </Button>
            </div>
          </Card>
        ) : null}
        <div className="dp-specification-detail-layout dp-task-detail-layout">
          {detail.specification &&
            (detail.specification.completeness === "PARTIAL" ||
              detail.specification.diagnostics.some(
                (diagnostic) => diagnostic.level !== "INFO",
              )) && (
              <div className={styles.analysisNotice} role="status">
                <Badge tone="warning">分析提示</Badge>
                <p>
                  {detail.specification.completeness === "PARTIAL"
                    ? "分析来源不完整，用例可能未覆盖全部变更。请在任务日志的「Spec 分析」中查看原因。"
                    : "用例分析存在需关注的问题，请在任务日志的「Spec 分析」中查看原因。"}
                </p>
              </div>
            )}
          <div className="dp-specification-case-list">
            <h2 className="dp-task-section-title">
              {detail.kind === "ISSUE_SPEC"
                ? `执行用例 · ${detail.cases.length}`
                : `执行记录 · ${detail.runs.length}`}
            </h2>
            {detail.kind === "ISSUE_SPEC" && detail.cases.length === 0 && (
              <p className="dp-task-empty-copy">
                暂无执行用例，分析完成后将在这里显示。
              </p>
            )}
            {detail.kind !== "ISSUE_SPEC" && detail.runs.length === 0 && (
              <p className="dp-task-empty-copy">暂无执行记录。</p>
            )}
            {detail.kind === "DIRECT_RUN" || detail.kind === "LEGACY_RUN"
              ? detail.runs.map((run, index) => (
                  <RunLinkCard
                    key={run.runId}
                    name={`直接执行 #${index + 1}`}
                    run={run}
                    taskHref={taskHref}
                  />
                ))
              : detail.cases.map((testCase) => (
                  <CaseCard
                    allCases={detail.cases}
                    busy={busy}
                    canRerun={
                      detail.cancelRequestedAt === null &&
                      new Date(detail.deadlineAt).getTime() - Date.now() >=
                        30_000
                    }
                    key={testCase.id}
                    onRerun={() => void onMutate(`/cases/${testCase.id}/rerun`)}
                    onSavePolicy={(executionId, policy) =>
                      onMutate(`/cases/${executionId}/policy`, policy)
                    }
                    testCase={testCase}
                    taskHref={taskHref}
                  />
                ))}
          </div>
        </div>
      </section>

      <TaskLogs
        hidden={view !== "logs"}
        hasAnalysis={detail.kind === "ISSUE_SPEC"}
        analysisSnapshot={<SpecificationSnapshot detail={detail} />}
        trajectory={trajectory}
        events={events}
        eventsError={eventsError}
        eventsLoading={eventsLoading}
        onRetryEvents={onRetryEvents}
        exporting={exporting}
        exportError={exportError}
        onExport={() => void exportAllLogs()}
      />
    </>
  );
}

function summarizeCaseExecution(testCase: TaskCase) {
  const executions = latestTaskCaseExecutions(testCase.executions);
  const active = executions.find(
    (execution) =>
      execution.run && !terminalLifecycles.has(execution.run.lifecycle),
  );
  const pending = executions.find((execution) => !execution.run);
  const outcomes = executions.flatMap((execution) =>
    execution.run ? [taskOutcomeDisplay(execution.run)] : [],
  );
  const aggregateOutcome =
    outcomes.find((outcome) => outcome.toneStatus === "FAILED") ??
    outcomes.find((outcome) => outcome.toneStatus === "INCONCLUSIVE") ??
    outcomes[0];
  const status =
    active?.run?.lifecycle ??
    pending?.dispatch.status ??
    aggregateOutcome?.toneStatus ??
    "PENDING";
  return {
    active,
    aggregateOutcome,
    executions,
    pending,
    status,
  };
}

function SpecificationSnapshot({ detail }: { detail: TaskDetail }) {
  const analysis = detail.stages.find(
    (stage) => stage.type === "SPEC_ANALYSIS",
  );
  const emptyMessage =
    detail.kind === "DIRECT_RUN"
      ? "直接任务不需要生成 Spec。"
      : detail.lifecycle === "CANCELLED"
        ? "任务在分析完成前已取消；未完成的 Spec 不会保存或展示。"
        : analysis?.status === "FAILED"
          ? "Spec 分析失败，没有生成可执行的 Case。"
          : "分析 Worker 尚未生成 Spec。";
  return (
    <details className="dp-verification-detail dp-specification-snapshot">
      <summary className="dp-specification-snapshot-summary">
        <FileSearch />
        <span>
          <b>Spec 分析快照</b>
          <small>分析摘要、来源诊断与生成信息</small>
        </span>
        <Badge tone={tone(analysis?.status ?? "PENDING")}>
          分析{displayLabel(analysis?.status ?? "PENDING")}
        </Badge>
        <ChevronDown className="dp-specification-snapshot-chevron" />
      </summary>
      <div className="dp-specification-snapshot-body">
        {detail.specification ? (
          <>
            <div className="dp-specification-facts">
              <p>{detail.specification.summary}</p>
              <p>
                Generator: {detail.specification.generatorKind} ·{" "}
                {detail.specification.generatorVersion}
              </p>
              <code>{detail.specification.sourceHash}</code>
            </div>
            {detail.specification.diagnostics.length ? (
              <div className="dp-specification-diagnostics">
                {detail.specification.diagnostics.map((diagnostic, index) => (
                  <div
                    key={`${diagnostic.source}:${diagnostic.code}:${diagnostic.reference ?? "none"}:${index}`}
                  >
                    <span>
                      <Badge
                        tone={
                          diagnostic.level === "ERROR"
                            ? "danger"
                            : diagnostic.level === "WARNING"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {displayLabel(diagnostic.level)}
                      </Badge>
                      {diagnostic.source} · {diagnostic.code}
                    </span>
                    <p>{diagnostic.message}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="dp-task-empty-copy">{emptyMessage}</p>
        )}
      </div>
    </details>
  );
}

function CaseCard({
  allCases,
  busy,
  canRerun,
  onRerun,
  onSavePolicy,
  testCase,
  taskHref,
}: {
  allCases: TaskCase[];
  busy: boolean;
  canRerun: boolean;
  onRerun: () => void;
  onSavePolicy: (
    executionId: string,
    policy: ExecutionConcurrencyPolicy,
  ) => Promise<unknown>;
  testCase: TaskCase;
  taskHref: string;
}) {
  const { active, aggregateOutcome, executions, pending, status } =
    summarizeCaseExecution(testCase);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    testCase.executions.find((execution) => execution.id === selectedId) ??
    active ??
    pending ??
    executions[0];
  const latestIds = new Set(executions.map((execution) => execution.id));
  const history = testCase.executions
    .filter((execution) => !latestIds.has(execution.id))
    .sort((a, b) => b.executionOrdinal - a.executionOrdinal);
  const rerunnable =
    executions.length > 0 &&
    executions.every(
      (execution) =>
        execution.run && terminalLifecycles.has(execution.run.lifecycle),
    );
  const selectedFailure = selected && errorMessage(selected.dispatch.lastError);
  const executionOption = (execution: TaskCaseExecution) => (
    <option key={execution.id} value={execution.id}>
      {execution.deployment.name} · 第 {execution.executionOrdinal} 次 ·{" "}
      {executionSchedulingLabel(execution)}
    </option>
  );

  return (
    <article
      className={styles.caseCard}
      aria-labelledby={`case-${testCase.id}`}
    >
      <div className={styles.caseHeader}>
        <h3 id={`case-${testCase.id}`}>
          {testCase.position + 1}. {testCase.name}
        </h3>
        <Badge tone={tone(status)}>
          {active || pending
            ? executionSchedulingLabel(active ?? pending!)
            : (aggregateOutcome?.label ?? displayLabel(status))}
        </Badge>
      </div>
      <p className={styles.caseDescription}>
        {caseDescription(testCase.definition)}
      </p>
      <div className={styles.caseFooter}>
        <div className={styles.executionPicker}>
          <span>{testCase.definition.criteria?.length ?? 0} 条验收</span>
          {testCase.executions.length > 1 ? (
            <Select
              aria-label={`${testCase.name}的执行记录`}
              value={selected?.id ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <optgroup label="最新执行">
                {executions.map(executionOption)}
              </optgroup>
              {history.length > 0 && (
                <optgroup label="历史执行">
                  {history.map(executionOption)}
                </optgroup>
              )}
            </Select>
          ) : selected ? (
            <span className={styles.executionName}>
              {selected.deployment.name} · 第 {selected.executionOrdinal} 次执行
            </span>
          ) : (
            <span>等待创建执行记录</span>
          )}
        </div>
        <div className={styles.caseActions}>
          {rerunnable && (
            <Button
              disabled={busy || !canRerun}
              onClick={() => {
                if (
                  window.confirm(
                    "确认重跑此用例？当前执行及证据会保留，并新建一次执行。",
                  )
                ) {
                  onRerun();
                }
              }}
              size="sm"
              title={
                canRerun
                  ? "保留当前记录并重新执行用例"
                  : "任务已取消或剩余时间不足，无法重跑"
              }
              variant="ghost"
            >
              <RotateCcw /> 重跑
            </Button>
          )}
          {selected?.run ? (
            <Link
              className={styles.detailLink}
              href={executionHref(selected.run.runId, taskHref)}
              aria-label={`查看${testCase.name}的执行详情`}
            >
              详情 <ArrowRight />
            </Link>
          ) : null}
        </div>
      </div>
      {selected && !selected.run && (
        <div className={styles.pendingExecution}>
          <p>{executionSchedulingLabel(selected)}，执行创建后可查看详情。</p>
          <SchedulingExplanation scheduling={selected.scheduling} />
          {selectedFailure && <p>{selectedFailure}</p>}
          {["PENDING", "FAILED"].includes(selected.dispatch.status) &&
            selected.dispatch.attempts < 3 &&
            canRerun && (
              <CasePolicyEditor
                key={selected.id}
                busy={busy}
                execution={selected}
                otherCases={allCases.filter((peer) => peer.id !== testCase.id)}
                onSave={(policy) => onSavePolicy(selected.id, policy)}
              />
            )}
        </div>
      )}
      {selected?.run && (
        <SchedulingExplanation scheduling={selected.scheduling} />
      )}
    </article>
  );
}

function SchedulingExplanation({
  scheduling,
}: {
  scheduling: TaskScheduling | undefined;
}) {
  const waitText = schedulingWaitText(scheduling);
  if (!scheduling || !waitText) return null;
  return (
    <small className="dp-spec-dispatch-error">
      {waitText}
      {scheduling.queue?.position
        ? ` · 当前队列第 ${scheduling.queue.position} 位`
        : ""}
      {scheduling.blockedBy?.runId ? (
        <>
          {" "}
          ·{" "}
          <Link href={`/console/executions/${scheduling.blockedBy.runId}`}>
            查看占用执行
          </Link>
        </>
      ) : scheduling.blockedBy?.taskId ? (
        ` · 占用任务 ${scheduling.blockedBy.taskId.slice(0, 8)}`
      ) : (
        ""
      )}
      {scheduling.blockedBy?.recoveryId ? (
        <>
          {" "}
          ·{" "}
          <Link
            href={`/console/access/recoveries/${scheduling.blockedBy.recoveryId}`}
          >
            查看会话恢复
          </Link>
        </>
      ) : null}
      {scheduling.nextRetryAt &&
      scheduling.blockedBy?.recoveryPhase !== "NEEDS_OPERATOR"
        ? ` · 下次重试 ${new Date(scheduling.nextRetryAt).toLocaleTimeString("zh-CN")}`
        : ""}
    </small>
  );
}

function CasePolicyEditor({
  execution,
  otherCases,
  busy,
  onSave,
}: {
  execution: TaskCaseExecution;
  otherCases: TaskCase[];
  busy: boolean;
  onSave: (policy: ExecutionConcurrencyPolicy) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<ExecutionConcurrencyPolicy["accessMode"]>(
    execution.executionPolicy?.accessMode ?? "UNKNOWN",
  );
  const [scopes, setScopes] = useState(
    (execution.executionPolicy?.resourceScopes ?? []).join(", "),
  );
  const [dependencies, setDependencies] = useState(
    execution.executionPolicy?.dependsOnCaseIds ?? [],
  );
  return (
    <details className="dp-spec-runtime-policy">
      <summary>
        执行策略 ·{" "}
        {displayLabel(execution.executionPolicy?.accessMode ?? "UNKNOWN")}
      </summary>
      <div className="dp-task-form">
        <Field
          label="业务数据访问"
          description="只有已核对不会修改共享业务数据的 Case 才能共享读并发；未知 Case 按独占执行。"
        >
          <Select
            value={mode}
            onChange={(event) =>
              setMode(
                event.target.value as ExecutionConcurrencyPolicy["accessMode"],
              )
            }
          >
            <option value="UNKNOWN">尚未核对</option>
            <option value="READ_ONLY">已核对只读</option>
            <option value="MUTATING">会修改业务数据</option>
          </Select>
        </Field>
        <Field
          label="业务资源范围"
          description="留空保护整个业务环境；可填写配置中的资源路径，多个以逗号分隔。"
        >
          <Input
            value={scopes}
            onChange={(event) => setScopes(event.target.value)}
            placeholder="例如 whitelist/model-mapping"
          />
        </Field>
        {otherCases.length ? (
          <fieldset>
            <legend>前置 Case（须在同一部署成功完成）</legend>
            {otherCases.map((peer) => (
              <label key={peer.id} style={{ display: "block" }}>
                <input
                  type="checkbox"
                  checked={dependencies.includes(peer.id)}
                  onChange={(event) =>
                    setDependencies((current) =>
                      event.target.checked
                        ? [...current, peer.id]
                        : current.filter((id) => id !== peer.id),
                    )
                  }
                />{" "}
                {peer.position + 1}. {peer.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void onSave({
              accessMode: mode,
              resourceScopes: scopes
                .split(",")
                .map((scope) => scope.trim())
                .filter(Boolean),
              dependsOnCaseIds: dependencies,
            })
          }
        >
          保存执行策略
        </Button>
      </div>
    </details>
  );
}

function StageCard({
  allowRetry,
  busy,
  index,
  onRetry,
  stage,
}: {
  allowRetry: boolean;
  busy: boolean;
  index: number;
  onRetry: () => void;
  stage: TaskStage;
}) {
  const retryable =
    allowRetry &&
    stage.type !== "PROFILE_RESOLUTION" &&
    stage.status === "FAILED";
  return (
    <Card
      className={`dp-task-stage ${stage.status === "RUNNING" ? "is-active" : ""}`}
    >
      <div className="dp-task-stage-number">{index}</div>
      <div>
        <small>{displayLabel(stage.type)}</small>
        <b>
          {stage.type === "SPEC_ANALYSIS"
            ? "分析 Issue 并生成 Spec Case"
            : stage.type === "PROFILE_RESOLUTION"
              ? "解析用户、授权域名和浏览器登录身份"
              : "派发 Case 并聚合执行结果"}
        </b>
        <span>
          尝试 {stage.currentAttemptNumber}/{stage.maxAttempts}
          {stage.waitingReason ? ` · ${displayLabel(stage.waitingReason)}` : ""}
        </span>
      </div>
      <Badge tone={tone(stage.status)}>
        {displayLabel(
          stage.status === "RUNNING" && stage.waitingReason
            ? stage.waitingReason
            : stage.status,
        )}
      </Badge>
      {retryable ? (
        <Button disabled={busy} onClick={onRetry} variant="secondary">
          <RotateCcw /> 重试阶段
        </Button>
      ) : null}
    </Card>
  );
}

function RunLinkCard({
  name,
  run,
  taskHref,
}: {
  name: string;
  taskHref: string;
  run: TaskDetail["runs"][number];
}) {
  const outcome = taskOutcomeDisplay(run);
  return (
    <Card className="dp-verification-detail dp-specification-case">
      <div className="dp-section-head">
        <span>
          <b>{name}</b>
        </span>
        <Badge tone={tone(outcome.toneStatus)}>{outcome.label}</Badge>
      </div>
      <div className="dp-specification-case-body">
        <small>
          {displayLabel(run.lifecycle)} · 尝试 {run.currentAttemptNumber}/
          {run.maxAttempts} · 证据 {run.evidenceCount} · 人工操作{" "}
          {run.interventionCount}
          {run.infrastructureRecoveryCount
            ? ` · 失租恢复 ${run.infrastructureRecoveryCount}`
            : ""}
        </small>
        <Link href={executionHref(run.runId, taskHref)}>
          查看执行详情 <ExternalLink />
        </Link>
      </div>
    </Card>
  );
}
