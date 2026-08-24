import { describe, expect, it } from "vitest";

import {
  effectiveRetryPolicy,
  generateBusinessTestSpec,
  projectTaskExecution,
  projectRuntimeOutcome,
  specificationDefinitionHash,
  testGenerationContextHash,
} from "./index.js";

describe("projectRuntimeOutcome", () => {
  it("retries a provider disconnect without manufacturing a verdict", () => {
    expect(
      projectRuntimeOutcome({
        attemptNumber: 1,
        outcome: {
          error: {
            code: "PROVIDER_STREAM_DISCONNECTED",
            details: {},
            failureClass: "PROVIDER",
            message: "stream disconnected",
          },
          executionDisposition: "PROVIDER_ERROR",
          kind: "RETRYABLE_FAILURE",
          summary: "Provider disconnected before verification.",
        },
        retryPolicy: { maxAttempts: 3, retryOn: ["PROVIDER"] },
      }),
    ).toEqual({
      attemptStatus: "FAILED",
      executionDisposition: null,
      lifecycle: "QUEUED",
      nextAttemptScheduled: true,
      taskStatus: "FAILED",
      verdict: null,
    });
  });

  it("does not stop after the second retryable lifecycle failure", () => {
    expect(
      projectRuntimeOutcome({
        attemptNumber: 2,
        outcome: {
          error: {
            code: "VERIFICATION_NOT_TERMINAL",
            details: {},
            failureClass: "LIFECYCLE_PROTOCOL",
            message: "The delegated verification was cancelled during cleanup.",
          },
          executionDisposition: "AGENT_ERROR",
          kind: "RETRYABLE_FAILURE",
          summary: "No product verdict was produced.",
        },
        retryPolicy: {
          maxAttempts: 3,
          retryOn: ["LIFECYCLE_PROTOCOL"],
        },
      }).nextAttemptScheduled,
    ).toBe(true);
  });

  it("keeps a terminal infrastructure failure verdictless", () => {
    const projection = projectRuntimeOutcome({
      attemptNumber: 3,
      outcome: {
        error: {
          code: "BROWSER_UNAVAILABLE",
          details: {},
          failureClass: "BROWSER_RUNTIME",
          message: "No browser runtime was available.",
        },
        executionDisposition: "BROWSER_UNAVAILABLE",
        kind: "RETRYABLE_FAILURE",
        summary: "The task exhausted its attempts.",
      },
      retryPolicy: { maxAttempts: 3, retryOn: ["BROWSER_RUNTIME"] },
    });

    expect(projection).toMatchObject({
      executionDisposition: "BROWSER_UNAVAILABLE",
      lifecycle: "COMPLETED",
      nextAttemptScheduled: false,
      verdict: null,
    });
  });

  it("lets the control plane enforce browser fail-fast", () => {
    expect(
      effectiveRetryPolicy({
        browserAvailabilityPolicy: "FAIL_FAST",
        outcome: {
          error: {
            code: "BROWSER_UNAVAILABLE",
            details: {},
            failureClass: "BROWSER_RUNTIME",
            message: "No browser slot is available.",
          },
          executionDisposition: "BROWSER_UNAVAILABLE",
          kind: "RETRYABLE_FAILURE",
          summary: "The browser was not acquired.",
        },
        retryPolicy: { maxAttempts: 3, retryOn: ["BROWSER_RUNTIME"] },
      }).retryOn,
    ).toEqual([]);
  });
});

describe("generateBusinessTestSpec", () => {
  const context = {
    issue: {
      description:
        "验收标准：\n- 页面应该显示 UTC 时间。\n- 用户必须可以清空时间。",
      id: "issue-1",
      identifier: "ENG-123",
      labels: ["frontend"],
      priority: 1,
      state: "In Review",
      title: "下架时间支持秒级输入",
      url: "https://linear.app/acme/issue/ENG-123",
    },
    knowledge: [],
    pullRequests: [
      {
        body: "",
        changedFiles: ["apps/admin/time-picker.tsx"],
        deploymentUrl: "https://preview.example.com",
        isPrimary: true,
        number: 42,
        repository: "acme/admin",
        title: "Add second precision",
        url: "https://github.com/acme/admin/pull/42",
      },
    ],
    resolution: { completeness: "COMPLETE" as const, diagnostics: [] },
  };

  it("generates stable executable cases from the normalized context", () => {
    const first = generateBusinessTestSpec(context);
    const second = generateBusinessTestSpec(context);

    expect(first).toEqual(second);
    expect(first.cases).toHaveLength(2);
    expect(first.cases[0]).toMatchObject({
      authRole: "default",
      expected: ["页面应该显示 UTC 时间。"],
    });
    expect(first.cases[0]?.evidence.map((item) => item.kind)).toContain(
      "SCREENSHOT",
    );
  });

  it("hashes equivalent object snapshots deterministically", () => {
    expect(testGenerationContextHash(context)).toMatch(/^[a-f0-9]{64}$/u);
    expect(testGenerationContextHash(context)).toBe(
      testGenerationContextHash({ ...context }),
    );
  });

  it("hashes generated definitions independently of object key order", () => {
    expect(specificationDefinitionHash({ a: 1, b: 2 })).toBe(
      specificationDefinitionHash({ b: 2, a: 1 }),
    );
  });

  it("normalizes trailing separators without inventing a knowledge source", () => {
    const generated = generateBusinessTestSpec({
      ...context,
      issue: {
        ...context.issue,
        description:
          "验收标准：\n1. 列表展示官方模型名称，字段 officialModelName，\n2. 支持切换可见性；",
      },
      pullRequests: [],
    });

    expect(generated.cases[0]).toMatchObject({
      expected: ["列表展示官方模型名称，字段 officialModelName。"],
      name: "ENG-123 · 列表展示官方模型名称，字段 officialModelName",
    });
    expect(generated.cases[0]?.steps[1]?.action).not.toContain("，。");
    expect(generated.cases[0]?.steps[2]?.action).toBe(
      "记录关键业务结果，并与 Issue 逐项核对",
    );
  });
});

describe("projectTaskExecution", () => {
  const base = {
    analysisStatus: "SUCCEEDED" as const,
    cancelRequested: false,
    executionStatus: "RUNNING" as const,
    targetAvailable: true,
  };

  it("waits for a deployment target after analysis succeeds", () => {
    expect(
      projectTaskExecution({
        ...base,
        caseExecutions: [],
        targetAvailable: false,
      }),
    ).toMatchObject({
      currentStage: "SPEC_EXECUTION",
      lifecycle: "WAITING_INPUT",
      waitingReason: "DEPLOYMENT_TARGET_REQUIRED",
    });
  });

  it("aggregates fully executed case verdicts", () => {
    expect(
      projectTaskExecution({
        ...base,
        caseExecutions: [
          {
            dispatchAttempts: 1,
            dispatchMaxAttempts: 3,
            dispatchStatus: "LINKED" as const,
            run: {
              executionDisposition: "EXECUTED" as const,
              lifecycle: "COMPLETED" as const,
              verdict: "PASSED" as const,
            },
          },
          {
            dispatchAttempts: 1,
            dispatchMaxAttempts: 3,
            dispatchStatus: "LINKED" as const,
            run: {
              executionDisposition: "EXECUTED" as const,
              lifecycle: "COMPLETED" as const,
              verdict: "FAILED" as const,
            },
          },
        ],
      }),
    ).toMatchObject({
      executionDisposition: "EXECUTED",
      executionStageStatus: "SUCCEEDED",
      lifecycle: "COMPLETED",
      verdict: "FAILED",
    });
  });

  it("keeps a partially executed task verdictless", () => {
    expect(
      projectTaskExecution({
        ...base,
        caseExecutions: [
          {
            dispatchAttempts: 1,
            dispatchMaxAttempts: 3,
            dispatchStatus: "LINKED" as const,
            run: {
              executionDisposition: "EXECUTED" as const,
              lifecycle: "COMPLETED" as const,
              verdict: "PASSED" as const,
            },
          },
          {
            dispatchAttempts: 3,
            dispatchMaxAttempts: 3,
            dispatchStatus: "FAILED" as const,
            run: null,
          },
        ],
      }),
    ).toMatchObject({
      executionDisposition: "BLOCKED",
      lifecycle: "COMPLETED",
      verdict: null,
    });
  });

  it("projects child HITL without changing a product verdict", () => {
    expect(
      projectTaskExecution({
        ...base,
        caseExecutions: [
          {
            dispatchAttempts: 1,
            dispatchMaxAttempts: 3,
            dispatchStatus: "LINKED" as const,
            run: {
              executionDisposition: "BLOCKED" as const,
              lifecycle: "WAITING_HUMAN" as const,
              verdict: null,
            },
          },
        ],
      }),
    ).toMatchObject({ lifecycle: "WAITING_HUMAN", verdict: null });
  });

  it("keeps a transient Case dispatch failure active while retries remain", () => {
    expect(
      projectTaskExecution({
        ...base,
        caseExecutions: [
          {
            dispatchAttempts: 1,
            dispatchMaxAttempts: 3,
            dispatchStatus: "FAILED" as const,
            run: null,
          },
        ],
      }),
    ).toMatchObject({
      executionDisposition: null,
      executionStageStatus: "RUNNING",
      lifecycle: "RUNNING",
      verdict: null,
    });
  });

  it("keeps timeout terminal even while child work is active", () => {
    expect(
      projectTaskExecution({
        ...base,
        caseExecutions: [
          {
            dispatchAttempts: 1,
            dispatchMaxAttempts: 3,
            dispatchStatus: "DISPATCHING" as const,
            run: null,
          },
        ],
        timedOut: true,
      }),
    ).toMatchObject({
      executionStageStatus: "FAILED",
      lifecycle: "TIMED_OUT",
      verdict: null,
    });
  });
});
