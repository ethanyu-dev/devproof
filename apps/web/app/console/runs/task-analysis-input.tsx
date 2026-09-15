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
  request,
  busy,
  onSubmit,
}: {
  request: SpecAnalysisInputRequest & { attemptId: string };
  busy: boolean;
  onSubmit: (input: TaskAnalysisInput) => Promise<unknown>;
}) {
  const [issueRef, setIssueRef] = useState(request.issueRef);
  const [pullRequests, setPullRequests] = useState(
    request.pullRequestUrls.join("\n"),
  );
  const [targets, setTargets] = useState("");
  const [error, setError] = useState<string | null>(null);
  const missing = new Set(request.missing);
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
      ...(missing.has("ISSUE") ? { issueRef } : {}),
      ...(missing.has("PULL_REQUEST")
        ? { pullRequestUrls: lines(pullRequests) }
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
      <p className="text-sm text-muted-foreground">
        Issue、关联 PR
        内容和明确的测试环境均为必需信息。补齐后继续分析并生成用例。
      </p>
      <div className="dp-task-form">
        {missing.has("ISSUE") && (
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
        {missing.has("PULL_REQUEST") && (
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
            (missing.has("ISSUE") && !issueRef.trim()) ||
            (missing.has("PULL_REQUEST") && !pullRequests.trim()) ||
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
