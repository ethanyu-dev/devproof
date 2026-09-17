"use client";

import { useState } from "react";
import type {
  SpecAnalysisInputRequest,
  TaskAnalysisInput,
} from "@devproof/contracts";
import { taskAnalysisInputSchema } from "@devproof/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function TaskAnalysisInputCard({
  issueOwnerSelected = false,
  request,
  busy,
  onSubmit,
}: {
  issueOwnerSelected?: boolean;
  request: SpecAnalysisInputRequest & { attemptId: string };
  busy: boolean;
  onSubmit: (input: TaskAnalysisInput) => Promise<unknown>;
}) {
  const [issueRef, setIssueRef] = useState(request.issueRef);
  const [pullRequests, setPullRequests] = useState(
    request.pullRequestUrls.join("\n"),
  );
  const [goal, setGoal] = useState(request.goal ?? "");
  const [targets, setTargets] = useState("");
  const [error, setError] = useState<string | null>(null);
  const missing = new Set(request.missing);
  const needsContext = request.missing.some(
    (item) => item !== "DEPLOYMENT_TARGET",
  );
  const lines = (value: string) => [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  async function submit() {
    const parsed = taskAnalysisInputSchema.safeParse({
      expectedAttemptId: request.attemptId,
      ...(needsContext
        ? {
            issueRef: issueRef.trim() || null,
            pullRequestUrls: lines(pullRequests),
            ...(goal.trim() ? { goal: goal.trim() } : {}),
          }
        : {}),
      ...(missing.has("DEPLOYMENT_TARGET")
        ? {
            deployments: lines(targets).map((targetUrl, index) => ({
              key: `deployment-${index + 1}`,
              name: `验证环境 ${index + 1}`,
              targetUrl,
              environment: {},
            })),
          }
        : {}),
    });
    if (!parsed.success) {
      setError(
        "请检查输入：PR 使用完整 GitHub Pull Request 链接，测试环境使用完整 HTTP(S) 地址，每行填写一个。",
      );
      return;
    }
    setError(null);
    await onSubmit(parsed.data);
  }
  return (
    <Card className="dp-task-input-card">
      <div className="dp-section-head">
        <b>补齐任务信息</b>
        <Badge tone="warning">等待人工补充</Badge>
      </div>
      <p className="whitespace-pre-line text-sm">{request.message}</p>
      {issueOwnerSelected && (
        <p className="text-sm">
          当前使用 Issue 负责人身份。若要移除
          Issue，请先在下方切换浏览器身份；分析等待会保留。
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Issue、PR
        或测试说明均可作为测试依据。可修正无法读取的来源，或移除它并提供其他依据；执行前需要明确测试环境。
      </p>
      <div className="dp-task-form">
        {needsContext && (
          <Field
            label="Issue 链接或编号"
            description="确认需求正文可读取；修复访问权限后也可以提交原编号重试。"
          >
            <Input
              aria-label="Issue 链接或编号"
              value={issueRef}
              onChange={(event) => setIssueRef(event.target.value)}
              disabled={busy}
            />
          </Field>
        )}
        {needsContext && (
          <Field
            label="关联 PR（每行一个）"
            description="请确保 DevProof 可以读取所有关联 PR 的内容与代码。"
          >
            <Textarea
              aria-label="关联 PR"
              value={pullRequests}
              onChange={(event) => setPullRequests(event.target.value)}
              placeholder="https://github.com/组织/仓库/pull/123"
              disabled={busy}
            />
          </Field>
        )}
        {needsContext && (
          <Field
            label="测试说明"
            description="说明需要验证的业务结果；移除来源后仍需保留至少一种有效依据。"
          >
            <Textarea
              aria-label="测试说明"
              value={goal}
              maxLength={20_000}
              onChange={(event) => setGoal(event.target.value)}
              disabled={busy}
            />
          </Field>
        )}
        {missing.has("DEPLOYMENT_TARGET") && (
          <Field
            label="测试环境地址（每行一个）"
            description={[
              "填写本次需要实际验证的环境，可指定多个。",
              request.deploymentCandidates.length > 0
                ? `发现的候选地址：${request.deploymentCandidates.join("、")}。请确认后填写。`
                : null,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <Textarea
              aria-label="测试环境地址"
              value={targets}
              onChange={(event) => setTargets(event.target.value)}
              placeholder="https://preview.example.com"
              disabled={busy}
            />
          </Field>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          disabled={
            busy ||
            (needsContext && issueOwnerSelected && !issueRef.trim()) ||
            (needsContext &&
              !issueRef.trim() &&
              !pullRequests.trim() &&
              !goal.trim()) ||
            (missing.has("TEST_INTENT") && !goal.trim()) ||
            (missing.has("DEPLOYMENT_TARGET") && !targets.trim())
          }
          onClick={() => void submit()}
        >
          提交并继续分析
        </Button>
      </div>
    </Card>
  );
}
