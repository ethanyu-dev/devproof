"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Circle,
  ExternalLink,
  FileSearch,
  GitPullRequest,
  MonitorUp,
  Play,
  RefreshCw,
  Route,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/native-select";
import { Toggle } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { PageHeader } from "@/components/page-header";
import {
  ErrorState,
  FormMessage,
  LoadingState,
} from "@/components/settings-layout";
import { consoleApi } from "@/lib/api";
import { displayLabel } from "@/lib/display-text";
import type { TaskDetail, TaskEvent } from "../runs/task-types";

interface Readiness {
  components: {
    agentRuntime: { ready: boolean; status: string };
    execution: { ready: boolean; status: string };
    specification: {
      github: { configured: boolean };
      knowledge: { configured: boolean; optional?: boolean };
      linear: { configured: boolean };
      ready: boolean;
    };
  };
  runners: Array<{ id: string; name: string; status: string }>;
  status: "READY" | "DEGRADED";
}

interface BrowserProfileOption {
  displayName: string;
  id: string;
  status: string;
}

interface DeploymentDraft {
  id: number;
  name: string;
  targetUrl: string;
}

const terminalLifecycles = new Set(["COMPLETED", "CANCELLED", "TIMED_OUT"]);

function tone(
  status: string | null,
): "success" | "warning" | "danger" | "neutral" {
  if (["PASSED", "READY", "SUCCEEDED", "EXECUTED"].includes(status ?? ""))
    return "success";
  if (["FAILED", "CANCELLED", "TIMED_OUT", "NOT_RUN"].includes(status ?? ""))
    return "danger";
  if (
    [
      "QUEUED",
      "RUNNING",
      "WAITING_INPUT",
      "WAITING_HUMAN",
      "DEGRADED",
    ].includes(status ?? "")
  )
    return "warning";
  return "neutral";
}

export function PlaygroundClient() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [readinessStatus, setReadinessStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [mode, setMode] = useState<"ISSUE_SPEC" | "DIRECT_RUN">("ISSUE_SPEC");
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [taskLoadStatus, setTaskLoadStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [taskLoadError, setTaskLoadError] = useState<string | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [issueRef, setIssueRef] = useState("");
  const [casePolicyReviewRequired, setCasePolicyReviewRequired] =
    useState(false);
  const [profiles, setProfiles] = useState<BrowserProfileOption[]>([]);
  const [profileStrategy, setProfileStrategy] = useState<
    "EPHEMERAL" | "REQUESTER" | "ISSUE_ASSIGNEE" | "EXPLICIT_PROFILE"
  >("EPHEMERAL");
  const [profileId, setProfileId] = useState("");
  const [specDeployments, setSpecDeployments] = useState<DeploymentDraft[]>([
    { id: 1, name: "Preview", targetUrl: "" },
  ]);
  const [directTargetUrl, setDirectTargetUrl] = useState("https://example.com");
  const [goal, setGoal] = useState(
    "打开目标页面，确认页面可以访问并检查页面标题，然后采集截图作为证据。",
  );
  const [acceptanceCriterion, setAcceptanceCriterion] = useState(
    "目标页面成功打开，标题与页面内容符合预期，并提供截图证据。",
  );
  const [hitlEnabled, setHitlEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const pendingSubmissionRef = useRef<{
    fingerprint: string;
    id: string;
  } | null>(null);
  const submittingRef = useRef(false);
  const [message, setMessage] = useState<{
    text: string;
    tone: "error" | "success";
  } | null>(null);

  const loadReadiness = useCallback(async () => {
    setReadinessStatus("loading");
    setReadinessError(null);
    try {
      const [nextReadiness, nextProfiles] = await Promise.all([
        consoleApi<Readiness>("/playground/readiness"),
        consoleApi<BrowserProfileOption[]>("/browser-profiles"),
      ]);
      setReadiness(nextReadiness);
      setProfiles(nextProfiles);
      setReadinessStatus("ready");
    } catch (error) {
      setReadinessStatus("error");
      setReadinessError((error as Error).message);
      throw error;
    }
  }, []);

  const loadTask = useCallback(async (id: string) => {
    setTaskLoadStatus("loading");
    setTaskLoadError(null);
    try {
      const [detail, timeline] = await Promise.all([
        consoleApi<TaskDetail>(`/tasks/${id}`),
        consoleApi<TaskEvent[]>(`/tasks/${id}/events`),
      ]);
      setTask(detail);
      setEvents(timeline);
      setTaskLoadStatus("ready");
      return detail;
    } catch (error) {
      setTaskLoadError((error as Error).message);
      setTaskLoadStatus("error");
      throw error;
    }
  }, []);

  useEffect(() => {
    void loadReadiness().catch(() => undefined);
  }, [loadReadiness]);

  useEffect(() => {
    const requestedTaskId = searchParams.get("task");
    if (!requestedTaskId || requestedTaskId === task?.id) return;
    void loadTask(requestedTaskId).catch((error: Error) =>
      setMessage({ text: error.message, tone: "error" }),
    );
  }, [loadTask, searchParams, task?.id]);

  useEffect(() => {
    if (!task || terminalLifecycles.has(task.lifecycle)) return;
    const timer = window.setInterval(() => {
      void loadTask(task.id).catch((error: Error) =>
        setMessage({ text: error.message, tone: "error" }),
      );
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [loadTask, task?.id, task?.lifecycle]);

  useEffect(() => {
    if (task && terminalLifecycles.has(task.lifecycle)) {
      pendingSubmissionRef.current = null;
    }
  }, [task?.id, task?.lifecycle]);

  async function createTask() {
    if (submittingRef.current) return;
    const deployments = specDeployments
      .filter((deployment) => deployment.targetUrl.trim())
      .map((deployment, index) => ({
        environment: {},
        key: `deployment-${index + 1}`,
        name: deployment.name.trim() || `验证环境 ${index + 1}`,
        targetUrl: deployment.targetUrl.trim(),
      }));
    const request =
      mode === "ISSUE_SPEC"
        ? {
            issueRef,
            casePolicyReviewRequired,
            profilePolicy: {
              onUnavailable: "WAIT_FOR_PROFILE" as const,
              ...(profileStrategy === "EXPLICIT_PROFILE" && profileId
                ? { profileId }
                : {}),
              scope: { authRole: "default", environmentKey: "default" },
              strategy: profileStrategy,
            },
            ...(deployments.length ? { deployments } : {}),
          }
        : {
            acceptanceCriterion,
            goal,
            hitlEnabled,
            targetUrl: directTargetUrl,
          };
    const fingerprint = JSON.stringify({ mode, request });
    const pending = pendingSubmissionRef.current;
    const submission =
      pending?.fingerprint === fingerprint
        ? pending
        : { fingerprint, id: crypto.randomUUID() };
    pendingSubmissionRef.current = submission;
    submittingRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const created =
        mode === "ISSUE_SPEC"
          ? await consoleApi<TaskDetail>("/playground/specifications/resolve", {
              body: JSON.stringify({
                ...request,
                submissionId: submission.id,
              }),
              method: "POST",
            })
          : await consoleApi<TaskDetail>("/playground/runs", {
              body: JSON.stringify({
                ...request,
                submissionId: submission.id,
              }),
              method: "POST",
            });
      setTask(created);
      setTaskLoadStatus("ready");
      const next = new URLSearchParams(searchParams.toString());
      next.set("task", created.id);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
      try {
        await loadTask(created.id);
      } catch (error) {
        setMessage({
          text: `任务已创建（${created.id}），但详情刷新失败：${(error as Error).message}`,
          tone: "error",
        });
        return;
      }
      setMessage({
        text:
          mode === "ISSUE_SPEC"
            ? "任务已创建，正在异步分析 Issue 并生成 Spec Case。"
            : "任务已创建，Spec 分析阶段已跳过，正在执行。",
        tone: "success",
      });
    } catch (error) {
      setMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        actions={
          <Button
            disabled={readinessStatus === "loading"}
            onClick={() => void loadReadiness().catch(() => undefined)}
            variant="secondary"
          >
            <RefreshCw /> 刷新环境
          </Button>
        }
        description="管理员用于验证 Issue、模型和执行节点是否已经正确接入。"
        title="任务试验场"
      />
      {readinessError ? (
        <div className="dp-runtime-message">
          <FormMessage message={readinessError} tone="error" />
        </div>
      ) : null}
      {message && !(taskLoadStatus === "error" && !task) ? (
        <div className="dp-runtime-message">
          <FormMessage message={message.text} tone={message.tone} />
        </div>
      ) : null}

      <Card className="dp-playground-flow">
        <div>
          <FileSearch />
          <span>
            <b>ISSUE</b>
            <small>Linear / PR / Knowledge</small>
          </span>
        </div>
        <ArrowRight />
        <div>
          <Route />
          <span>
            <b>SPEC 分析生成</b>
            <small>不可变任务快照</small>
          </span>
        </div>
        <ArrowRight />
        <div>
          <Bot />
          <span>
            <b>SPEC 执行</b>
            <small>Case → 执行</small>
          </span>
        </div>
        <ArrowRight />
        <div>
          <MonitorUp />
          <span>
            <b>EVIDENCE</b>
            <small>执行与证据聚合</small>
          </span>
        </div>
      </Card>

      <div className="dp-playground-grid">
        <Card className="dp-playground-control">
          <div className="dp-section-head">
            <span>
              <Play />
              <b>新建任务</b>
            </span>
            <Badge tone={tone(readiness?.status ?? "CHECKING")}>
              {readinessStatus === "error"
                ? "环境读取失败"
                : displayLabel(readiness?.status ?? "CHECKING")}
            </Badge>
          </div>
          <div className="dp-playground-readiness">
            <ReadinessLine
              label="Spec Context"
              ready={
                readinessStatus === "error"
                  ? false
                  : readiness?.components.specification.ready
              }
              text={
                readinessStatus === "error"
                  ? "无法读取环境状态，请重试"
                  : `Linear ${readiness?.components.specification.linear.configured ? "已配置" : "未配置"} · GitHub ${readiness?.components.specification.github.configured ? "已配置" : "未配置"} · Knowledge ${readiness?.components.specification.knowledge.configured ? "已配置" : "可选"}`
              }
            />
            <ReadinessLine
              label="Agent Runtime"
              ready={
                readinessStatus === "error"
                  ? false
                  : readiness?.components.agentRuntime.ready
              }
              text={
                readinessStatus === "error"
                  ? "无法读取环境状态，请重试"
                  : (readiness?.components.agentRuntime.status ?? "检查中…")
              }
            />
            <ReadinessLine
              label="浏览器执行节点"
              ready={
                readinessStatus === "error"
                  ? false
                  : readiness?.components.execution.ready
              }
              text={
                readinessStatus === "error"
                  ? "无法读取环境状态，请重试"
                  : readiness?.runners.length
                    ? readiness.runners.map((runner) => runner.name).join(", ")
                    : "没有在线节点；任务仍可提交并排队"
              }
            />
          </div>
          <form
            className="dp-playground-form"
            onSubmit={(event) => {
              event.preventDefault();
              void createTask();
            }}
          >
            <Field label="任务入口">
              <Select
                onChange={(event) => setMode(event.target.value as typeof mode)}
                value={mode}
              >
                <option value="ISSUE_SPEC">从 Issue 分析并执行</option>
                <option value="DIRECT_RUN">直接执行（跳过 Spec 分析）</option>
              </Select>
            </Field>
            {mode === "ISSUE_SPEC" ? (
              <>
                <Field label="Linear Issue ID 或 URL">
                  <Input
                    onChange={(event) => setIssueRef(event.target.value)}
                    placeholder="ENG-123"
                    value={issueRef}
                  />
                </Field>
                <label>
                  <input
                    type="checkbox"
                    checked={casePolicyReviewRequired}
                    onChange={(event) =>
                      setCasePolicyReviewRequired(event.target.checked)
                    }
                  />{" "}
                  生成后核对执行策略
                  <small style={{ display: "block" }}>
                    生成 Case
                    后先等待，在任务详情核对只读、写入及前置依赖后逐项开始执行。
                  </small>
                </label>
                <Field label="验证环境（可选，可添加多个）">
                  <div className="dp-deployment-editor">
                    {specDeployments.map((deployment, index) => (
                      <div className="dp-deployment-row" key={deployment.id}>
                        <Input
                          aria-label={`验证环境 ${index + 1} 名称`}
                          onChange={(event) =>
                            setSpecDeployments((current) =>
                              current.map((item) =>
                                item.id === deployment.id
                                  ? { ...item, name: event.target.value }
                                  : item,
                              ),
                            )
                          }
                          placeholder="环境名称，例如 Staging"
                          value={deployment.name}
                        />
                        <Input
                          aria-label={`验证环境 ${index + 1} URL`}
                          onChange={(event) =>
                            setSpecDeployments((current) =>
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
                        {specDeployments.length > 1 ? (
                          <Button
                            onClick={() =>
                              setSpecDeployments((current) =>
                                current.filter(
                                  (item) => item.id !== deployment.id,
                                ),
                              )
                            }
                            type="button"
                            variant="secondary"
                          >
                            删除
                          </Button>
                        ) : null}
                      </div>
                    ))}
                    <Button
                      disabled={specDeployments.length >= 20}
                      onClick={() =>
                        setSpecDeployments((current) => [
                          ...current,
                          {
                            id:
                              Math.max(0, ...current.map((item) => item.id)) +
                              1,
                            name: `验证环境 ${current.length + 1}`,
                            targetUrl: "",
                          },
                        ])
                      }
                      type="button"
                      variant="secondary"
                    >
                      添加验证环境
                    </Button>
                    <small>
                      全部留空时，系统仍会尝试使用 Pull Request 的 Deployment
                      URL。
                    </small>
                  </div>
                </Field>
                <Field label="浏览器登录身份">
                  <Select
                    onChange={(event) =>
                      setProfileStrategy(
                        event.target.value as typeof profileStrategy,
                      )
                    }
                    value={profileStrategy}
                  >
                    <option value="EPHEMERAL">临时会话（不保留登录）</option>
                    <option value="REQUESTER">使用我的浏览器身份</option>
                    <option value="ISSUE_ASSIGNEE">
                      使用 Issue 负责人的浏览器身份
                    </option>
                    <option value="EXPLICIT_PROFILE">指定我的浏览器身份</option>
                  </Select>
                </Field>
                {profileStrategy === "EXPLICIT_PROFILE" ? (
                  <Field label="选择浏览器身份">
                    <Select
                      onChange={(event) => setProfileId(event.target.value)}
                      value={profileId}
                    >
                      <option value="">请选择可用的浏览器身份</option>
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
                    !issueRef ||
                    readinessStatus !== "ready" ||
                    (profileStrategy === "EXPLICIT_PROFILE" && !profileId) ||
                    readiness?.components.specification.ready === false
                  }
                  type="submit"
                >
                  <GitPullRequest /> {busy ? "创建中…" : "创建 Issue 任务"}
                </Button>
              </>
            ) : (
              <>
                <Field label="目标 URL">
                  <Input
                    onChange={(event) => setDirectTargetUrl(event.target.value)}
                    value={directTargetUrl}
                  />
                </Field>
                <Field label="Agent 目标">
                  <Textarea
                    onChange={(event) => setGoal(event.target.value)}
                    value={goal}
                  />
                </Field>
                <Field label="验收标准">
                  <Textarea
                    onChange={(event) =>
                      setAcceptanceCriterion(event.target.value)
                    }
                    value={acceptanceCriterion}
                  />
                </Field>
                <Toggle
                  checked={hitlEnabled}
                  label="允许人工接管"
                  onChange={setHitlEnabled}
                />
                <Button
                  disabled={
                    busy || !goal || !directTargetUrl || !acceptanceCriterion
                  }
                  type="submit"
                >
                  <Play /> {busy ? "创建中…" : "创建直接任务"}
                </Button>
              </>
            )}
          </form>
        </Card>

        <Card className="dp-playground-run">
          <div className="dp-section-head">
            <span>
              <Bot />
              <b>任务追踪</b>
            </span>
            <Badge tone={tone(task?.verdict ?? task?.lifecycle ?? "EMPTY")}>
              {displayLabel(task?.verdict ?? task?.lifecycle ?? "暂无任务")}
            </Badge>
          </div>
          {!task && taskLoadStatus === "loading" ? (
            <LoadingState />
          ) : !task && taskLoadStatus === "error" && taskLoadError ? (
            <ErrorState
              message={taskLoadError}
              onRetry={() => {
                const requestedTaskId = searchParams.get("task");
                if (requestedTaskId)
                  void loadTask(requestedTaskId).catch((error: Error) =>
                    setMessage({ text: error.message, tone: "error" }),
                  );
              }}
            />
          ) : !task ? (
            <div className="dp-playground-empty">
              <Bot />
              <b>等待一次任务执行</b>
              <span>分析、浏览器身份解析和 Case 执行会显示在这里。</span>
            </div>
          ) : (
            <>
              <div className="dp-playground-run-meta">
                <span>
                  <small>{displayLabel(task.kind)}</small>
                  <b>{task.title}</b>
                </span>
                <span>
                  <small>当前阶段</small>
                  <b>{displayLabel(task.currentStage)}</b>
                </span>
                <Link href={`/console/runs/${task.id}`}>
                  查看完整任务 <ExternalLink />
                </Link>
              </div>
              {task.specification ? (
                <p className="dp-playground-spec-summary">
                  {task.specification.summary}
                </p>
              ) : null}
              <div className="dp-playground-trace">
                {task.stages.map((stage, index) => (
                  <div key={stage.id}>
                    <i>{index + 1}</i>
                    <span>
                      <b>{displayLabel(stage.type)}</b>
                      <small>
                        {displayLabel(stage.status)} · 尝试{" "}
                        {stage.currentAttemptNumber}/{stage.maxAttempts}
                      </small>
                    </span>
                  </div>
                ))}
                {task.cases.map((testCase) => {
                  const execution = testCase.executions.at(-1);
                  return (
                    <div key={testCase.id}>
                      <i>{testCase.position + 1}</i>
                      <span>
                        <b>{testCase.name}</b>
                        <small>
                          {displayLabel(
                            execution?.run?.verdict ??
                              execution?.run?.lifecycle ??
                              execution?.dispatch.status ??
                              "PENDING",
                          )}
                        </small>
                      </span>
                    </div>
                  );
                })}
                {events.slice(-8).map((event) => (
                  <div key={event.sequence}>
                    <i>{event.sequence}</i>
                    <span>
                      <b>{displayLabel(event.kind)}</b>
                      <small>
                        {displayLabel(event.actor)} ·{" "}
                        {new Date(event.occurredAt).toLocaleTimeString("zh-CN")}
                      </small>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>
    </>
  );
}

function ReadinessLine({
  label,
  ready,
  text,
}: {
  label: string;
  ready: boolean | undefined;
  text: string;
}) {
  return (
    <div>
      {ready ? <CheckCircle2 /> : <Circle />}
      <span>
        <b>{label}</b>
        <small>{text}</small>
      </span>
    </div>
  );
}
