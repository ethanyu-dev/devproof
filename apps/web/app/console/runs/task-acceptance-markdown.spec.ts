import { describe, expect, it } from "vitest";
import type { TaskAcceptanceReport } from "@devproof/contracts";
import {
  acceptanceTitle,
  taskAcceptanceMarkdown,
} from "./task-acceptance-markdown";
const counts = { total: 1, PASSED: 0, FAILED: 0, INCONCLUSIVE: 1, PENDING: 0 };
function fixture(): TaskAcceptanceReport {
  return {
    version: 1,
    revision: "revision-1",
    generatedAt: "2026-09-15T08:00:00Z",
    taskId: "task-1",
    title: "需求 <script> | [test]",
    sourceRef: "PFRD-3551",
    scope: "REQUIREMENT",
    specificationId: "spec-1",
    sourceHash: "source-1",
    pullRequestUrl: null,
    lifecycle: "COMPLETED",
    finishedAt: "2026-09-15T08:00:00Z",
    final: true,
    verdict: "INCONCLUSIVE",
    aiAccepted: false,
    summary: "证据不足，无法判断",
    assessment: {
      method: "REQUIRED_CRITERIA_V1",
      score: 0,
      passed: 0,
      failed: 0,
      unknown: 1,
      pending: 0,
      total: 1,
      recommendation: "NEEDS_VALIDATION",
      reason: "补齐开关证据后再决定上线",
      findings: [],
    },
    coverageComplete: true,
    counts: { cases: counts, criteria: { ...counts, required: 1 } },
    requirements: [],
    cases: [
      {
        caseId: "case-1",
        name: "新增白名单",
        deployment: "测试环境",
        targetUrl: "https://test.example/whitelist",
        runId: "run-1",
        executionOrdinal: 2,
        attemptNumber: 1,
        lifecycle: "COMPLETED",
        executionDisposition: "EXECUTED",
        verdict: "INCONCLUSIVE",
        issues: [],
        criteria: [
          {
            id: "c1",
            requirementId: "r1",
            description: "应显示启用",
            required: true,
            verdict: "INCONCLUSIVE",
            recordedVerdict: "INCONCLUSIVE",
            summary: "缺少证据\n|不能判断",
            issues: [],
            evidence: [
              {
                id: "e1",
                ref: "artifact://a1",
                kind: "DOM",
                downloadPath: "/console/api/runs/run-1/evidences/e1/download",
              },
            ],
          },
        ],
      },
    ],
    issues: [],
  };
}
describe("acceptance report export", () => {
  it("exports cleanup as follow-up work without changing the report verdict", () => {
    const row = fixture();
    row.verdict = "PASSED";
    row.aiAccepted = true;
    row.cases[0]!.cleanup = {
      status: "BLOCKED",
      note: "清理未完成：；4 笔提交尚未确认记录归属。",
    };
    expect(acceptanceTitle(row)).toBe("AI 验收通过");
    const markdown = taskAcceptanceMarkdown(row, "http://localhost:3344");
    expect(markdown).toContain("后续收尾提醒");
    expect(markdown).toContain("不影响验证结果");
    expect(markdown).not.toContain("清理未完成：；");
  });
  it("exports scoped results, current batch, revisions, and durable evidence links", () => {
    const markdown = taskAcceptanceMarkdown(fixture(), "http://localhost:3344");
    expect(markdown).toContain("AI 验收待补充验证");
    expect(markdown).toContain("批次 2");
    expect(markdown).toContain("证据评分：**0/100**");
    expect(markdown).toContain("补充验证后再上线");
    expect(markdown).toContain("修订 revision-1");
    expect(markdown).toContain(
      "http://localhost:3344/console/api/runs/run-1/evidences/e1/download",
    );
    expect(markdown).toContain("缺少证据 \\|不能判断");
    expect(markdown).not.toContain("<script>");
  });
  it("does not label a passing single-case rerun as whole-requirement acceptance", () => {
    const report = {
      ...fixture(),
      scope: "CASE" as const,
      verdict: "PASSED" as const,
    };
    expect(acceptanceTitle(report)).toBe("本次范围验收通过");
    expect(taskAcceptanceMarkdown(report, "https://console.example")).toContain(
      "单独 Case 重跑",
    );
  });
  it("exports in-progress reports explicitly and rejects unsafe source links", () => {
    const report = {
      ...fixture(),
      final: false,
      verdict: "PENDING" as const,
      pullRequestUrl: "javascript:alert(1)",
    };
    const markdown = taskAcceptanceMarkdown(report, "https://console.example");
    expect(markdown).toContain("执行中进度快照");
    expect(markdown).not.toContain("](javascript:");
  });
});
