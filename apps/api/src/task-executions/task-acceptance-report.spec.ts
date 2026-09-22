import { describe, expect, it, vi } from "vitest";
import { buildTaskAcceptanceReport } from "./task-acceptance-report.js";
import { TaskExecutionService } from "./task-execution.service.js";

const at = new Date("2026-09-15T08:00:00Z");
function fixture() {
  const criterion = {
    id: "check-1",
    requirementId: "req-1",
    description: "启用开关按预期保存",
    required: true,
    requiredEvidenceKinds: ["DOM", "SCREENSHOT"],
  };
  const run = {
    id: "run-1",
    goal: "新增白名单",
    lifecycle: "COMPLETED",
    executionDisposition: "EXECUTED",
    verdict: "PASSED" as string | null,
    currentAttemptNumber: 1,
    criteriaSnapshot: [{ ...criterion, requirementId: undefined }],
    environmentSnapshot: { targetUrl: "https://test.example/whitelist" },
    attempts: [{ id: "attempt-1", number: 1, error: null }],
    tasks: [] as Array<{
      attemptId: string;
      error: unknown;
      result: unknown;
      recoveryStatus?: string;
    }>,
    criterionResults: [
      {
        attemptId: "attempt-1",
        criterionId: "check-1",
        status: "PASSED",
        blockingReason: null as string | null,
        summary: "已观察到启用状态",
        evidenceRefs: ["dom-1", "screen-1"],
      },
    ],
    evidences: [
      {
        id: "e1",
        externalId: "dom-1",
        kind: "DOM",
        attemptId: "attempt-1",
        runtimeArtifactId: "artifact1",
      },
      {
        id: "e2",
        externalId: "screen-1",
        kind: "SCREENSHOT",
        attemptId: "attempt-1",
        runtimeArtifactId: "artifact2",
      },
    ],
  };
  return {
    id: "task-1",
    title: "白名单需求",
    sourceRef: "PFRD-3551",
    kind: "ISSUE_SPEC",
    lifecycle: "COMPLETED",
    sourceSnapshotComplete: true,
    finishedAt: at,
    environmentSnapshot: {} as Record<string, unknown>,
    specificationSnapshots: [
      {
        id: "spec-1",
        sourceHash: "source-v1",
        primaryPullRequestUrl: null,
        completeness: "COMPLETE",
        diagnostics: [] as unknown[],
        context: {
          specification: {
            requirements: [
              {
                id: "req-1",
                description: "保存启用状态",
                sourceRef: "source-1",
              },
            ],
            uncoveredRequirements: [] as unknown[],
          },
        },
        cases: [
          {
            id: "case-1",
            name: "新增白名单",
            definition: { criteria: [criterion] },
          },
        ],
      },
    ],
    deployments: [
      {
        id: "env-1",
        name: "测试环境",
        targetUrl: "https://test.example/whitelist",
      },
    ],
    caseExecutions: [
      {
        caseId: "case-1",
        deploymentId: "env-1",
        executionOrdinal: 1,
        run,
        dispatchLastError: null,
      },
    ],
    executionRuns: [run],
    stages: [] as Array<{ status: string; type: string; lastError: unknown }>,
  };
}
const report = (row: ReturnType<typeof fixture>) =>
  buildTaskAcceptanceReport(row as never, at);

describe("AI acceptance report", () => {
  it("excludes the interrupted no-result case without classifying it as a product defect", () => {
    const row = fixture();
    const run = row.executionRuns[0]!;
    run.executionDisposition = "BLOCKED";
    run.verdict = null;
    run.criterionResults = [];
    run.tasks = [
      {
        attemptId: "attempt-1",
        error: { code: "WRITE_OUTCOME_UNKNOWN", message: "写入结果待核对" },
        result: null,
      },
    ];
    expect(report(row)).toMatchObject({
      verdict: "INCONCLUSIVE",
      aiAccepted: false,
      assessment: {
        score: null,
        total: 0,
        excluded: 1,
        findings: [],
        exclusions: [{ code: "WRITE_OUTCOME_UNKNOWN" }],
      },
    });
  });
  it.each([
    "SESSION_OPEN_FAILED",
    "RUNTIME_SESSION_UNAVAILABLE",
    "LOCATOR_RECOVERY_EXHAUSTED",
  ])("shows the original %s after write verification resolves", (code) => {
    const row = fixture();
    const run = row.executionRuns[0]!;
    run.executionDisposition = "BLOCKED";
    run.verdict = null;
    run.criterionResults = [];
    run.tasks = [
      {
        attemptId: "attempt-1",
        recoveryStatus: "RESOLVED",
        result: null,
        error: {
          code: "WRITE_OUTCOME_UNKNOWN",
          message: "写入结果待核对",
          details: { originalError: { code, message: "原始执行问题" } },
        },
      },
    ];
    const result = report(row);
    expect(result.cases[0]!.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code,
          message: "原始执行问题",
          nextStep: expect.stringContaining("写入核实已完成"),
        }),
      ]),
    );
    expect(result.assessment).toMatchObject({
      score: null,
      excluded: code === "LOCATOR_RECOVERY_EXHAUSTED" ? 0 : 1,
    });
    run.tasks[0]!.recoveryStatus = "WRITE_OUTCOME_UNKNOWN";
    expect(report(row).cases[0]!.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "WRITE_OUTCOME_UNKNOWN" }),
      ]),
    );
  });
  it("requires current-attempt evidence before excluding a structured data precondition", () => {
    const row = fixture();
    const run = row.executionRuns[0]!;
    const result = run.criterionResults[0]!;
    run.verdict = "INCONCLUSIVE";
    result.status = "INCONCLUSIVE";
    result.blockingReason = "DATA_PRECONDITION";
    result.summary =
      "MinerU cacheRead 当前价格 ¥1，红线价 ¥2，仅产品经理可保存。";
    expect(report(row)).toMatchObject({
      assessment: { score: null, total: 0, excluded: 1, findings: [] },
      cases: [
        {
          criteria: [
            {
              issues: expect.arrayContaining([
                expect.objectContaining({
                  category: "PRECONDITION",
                  code: "DATA_PRECONDITION",
                }),
              ]),
            },
          ],
        },
      ],
    });
    run.evidences = [];
    expect(report(row).assessment).toMatchObject({
      score: null,
      excluded: 0,
      total: 1,
    });
  });
  it("does not inherit an environmental error from an older attempt", () => {
    const row = fixture();
    const run = row.executionRuns[0]!;
    run.executionDisposition = "BLOCKED";
    run.verdict = null;
    run.criterionResults = [];
    run.tasks = [
      {
        attemptId: "old-attempt",
        error: { code: "WRITE_OUTCOME_UNKNOWN" },
        result: null,
      },
    ];
    expect(report(row).assessment).toMatchObject({
      score: null,
      total: 1,
      excluded: 0,
    });
  });
  it("preserves historical verified results and exposes cleanup as a reminder", () => {
    const row = fixture();
    const run = row.executionRuns[0]!;
    run.executionDisposition = "BLOCKED";
    run.verdict = null;
    row.stages.push({
      type: "SPEC_EXECUTION",
      status: "FAILED",
      lastError: null,
    });
    run.tasks = [
      {
        attemptId: "attempt-1",
        error: null,
        result: {
          kind: "VERIFICATION_COMPLETED",
          executionDisposition: "EXECUTED",
          verdict: "PASSED",
          cleanup: { status: "BLOCKED", note: "4 笔提交尚未确认记录归属。" },
        },
      },
    ];
    expect(report(row)).toMatchObject({
      verdict: "PASSED",
      aiAccepted: true,
      assessment: { score: 100, passed: 1 },
      cases: [
        {
          verdict: "PASSED",
          issues: [],
          cleanup: { note: "4 笔提交尚未确认记录归属。" },
        },
      ],
      issues: [],
    });
    run.criterionResults[0]!.status = "FAILED";
    expect(report(row).verdict).toBe("FAILED");
    run.criterionResults[0]!.status = "PASSED";
    run.evidences = [];
    expect(report(row).verdict).toBe("INCONCLUSIVE");
    run.tasks[0]!.attemptId = "old-attempt";
    expect(report(row).cases[0]!.issues[0]!.code).toBe("BLOCKED");
  });
  it("keeps unavailable optional CI checks informative without inventing an acceptance gate", () => {
    const row = fixture();
    row.specificationSnapshots[0]!.completeness = "PARTIAL";
    row.specificationSnapshots[0]!.diagnostics.push({
      code: "GITHUB_CHECKS_UNAVAILABLE",
      level: "WARNING",
      message: "GitHub checks API returned 403",
    });
    expect(report(row)).toMatchObject({
      verdict: "PASSED",
      aiAccepted: true,
      coverageComplete: true,
      issues: [expect.objectContaining({ category: "CONTEXT" })],
    });
  });
  it("accepts only complete requirement coverage with current-attempt evidence", () => {
    const result = report(fixture());
    expect(result).toMatchObject({
      verdict: "PASSED",
      aiAccepted: true,
      coverageComplete: true,
      final: true,
    });
    expect(result.requirements[0]).toMatchObject({
      verdict: "PASSED",
      caseIds: ["case-1"],
    });
    expect(result.cases[0]!.criteria[0]!.evidence).toHaveLength(2);
    expect(result.counts.criteria).toMatchObject({
      PASSED: 1,
      required: 1,
      total: 1,
    });
  });
  it.each([
    "partial-source",
    "uncovered-requirement",
    "legacy-map",
    "missing-case",
    "missing-deployment",
  ])("does not infer a requirement pass from %s", (reason) => {
    const row = fixture();
    if (reason === "partial-source")
      row.specificationSnapshots[0]!.completeness = "PARTIAL";
    if (reason === "uncovered-requirement")
      row.specificationSnapshots[0]!.context.specification.uncoveredRequirements.push(
        { requirementId: "req-1", reason: "缺少筛选场景" },
      );
    if (reason === "legacy-map")
      row.specificationSnapshots[0]!.context.specification.requirements = [];
    if (reason === "missing-case") row.caseExecutions = [];
    if (reason === "missing-deployment")
      row.deployments.push({
        id: "env-2",
        name: "另一个环境",
        targetUrl: "https://other.example",
      });
    expect(report(row)).toMatchObject({
      aiAccepted: false,
      verdict: "INCONCLUSIVE",
    });
  });
  it("keeps a confirmed product failure when another Case is blocked", () => {
    const row = fixture();
    row.executionRuns[0]!.verdict = "FAILED";
    row.executionRuns[0]!.criterionResults[0]!.status = "FAILED";
    row.specificationSnapshots[0]!.cases.push({
      ...row.specificationSnapshots[0]!.cases[0]!,
      id: "case-2",
      name: "编辑白名单",
    });
    expect(report(row)).toMatchObject({
      verdict: "FAILED",
      aiAccepted: false,
      counts: { cases: { FAILED: 1, INCONCLUSIVE: 1 } },
    });
  });
  it.each(["missing", "wrong-attempt", "unknown-ref"])(
    "requires evidence instead of trusting PASSED alone (%s)",
    (reason) => {
      const row = fixture();
      const run = row.executionRuns[0]!;
      if (reason === "missing") run.evidences.pop();
      if (reason === "wrong-attempt")
        run.evidences[0]!.attemptId = "old-attempt";
      if (reason === "unknown-ref")
        run.criterionResults[0]!.evidenceRefs.push("invented-proof");
      const result = report(row);
      expect(result.verdict).toBe("INCONCLUSIVE");
      expect(result.cases[0]!.criteria[0]).toMatchObject({
        recordedVerdict: "PASSED",
        verdict: "INCONCLUSIVE",
        issues: [expect.objectContaining({ category: "EVIDENCE" })],
      });
    },
  );
  it("does not reuse a previous attempt's successful criteria", () => {
    const row = fixture();
    row.executionRuns[0]!.currentAttemptNumber = 2;
    row.executionRuns[0]!.attempts = [
      { id: "attempt-2", number: 2, error: null },
    ];
    expect(report(row).verdict).toBe("INCONCLUSIVE");
  });
  it("uses the latest Case batch and excludes disabled or obsolete scope", () => {
    const row = fixture();
    const failed = structuredClone(row.caseExecutions[0]!);
    failed.executionOrdinal = 2;
    failed.run.verdict = "FAILED";
    failed.run.criterionResults[0]!.status = "FAILED";
    row.caseExecutions.push(
      failed,
      { ...failed, caseId: "obsolete-case" },
      { ...failed, deploymentId: "disabled-env" },
    );
    expect(report(row)).toMatchObject({
      verdict: "FAILED",
      counts: { cases: { total: 1 } },
      cases: [expect.objectContaining({ executionOrdinal: 2 })],
    });
  });
  it.each(["CANCELLED", "TIMED_OUT", "RUNNING"])(
    "does not grant acceptance to a %s task",
    (lifecycle) => {
      const row = fixture();
      row.lifecycle = lifecycle;
      expect(report(row).aiAccepted).toBe(false);
      expect(report(row).verdict).toBe(
        lifecycle === "RUNNING" ? "PENDING" : "INCONCLUSIVE",
      );
    },
  );
  it("preserves the real inconclusive explanation without inventing a product failure", () => {
    const row = fixture();
    const run = row.executionRuns[0]!;
    run.verdict = "INCONCLUSIVE";
    run.criterionResults[0]!.status = "INCONCLUSIVE";
    run.criterionResults[0]!.summary =
      "用户提供的业务账号不存在，无法执行正向新增";
    const result = report(row);
    expect(result.cases[0]!.criteria[0]!.issues[0]).toMatchObject({
      category: "UNDETERMINED",
      message: "用户提供的业务账号不存在，无法执行正向新增",
    });
    expect(result.verdict).toBe("INCONCLUSIVE");
  });
  it("makes report revisions stable until the underlying results change", () => {
    const row = fixture();
    const first = report(row);
    expect(
      buildTaskAcceptanceReport(row as never, new Date(at.getTime() + 10000))
        .revision,
    ).toBe(first.revision);
    row.executionRuns[0]!.criterionResults[0]!.summary = "新的实际观察";
    expect(report(row).revision).not.toBe(first.revision);
  });
  it("does not turn a direct task into whole-requirement acceptance", () => {
    const row = fixture();
    row.kind = "DIRECT_RUN";
    expect(report(row)).toMatchObject({
      scope: "DIRECT",
      verdict: "PASSED",
      aiAccepted: false,
    });
  });
});

it("scopes report reads to the caller's team and rejects missing tasks", async () => {
  const findFirst = vi.fn().mockResolvedValue(null);
  const service = new TaskExecutionService(
    { taskExecution: { findFirst } } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await expect(
    service.acceptanceReport({ team: { id: "team-1" } } as never, "task-1"),
  ).rejects.toThrow("not found");
  expect(findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "task-1", teamId: "team-1" } }),
  );
});

describe("task list acceptance scores", () => {
  const current = { team: { id: "team-1" } } as never;
  function listRow(id = "task-1") {
    const row = fixture();
    return {
      ...row,
      id,
      createdAt: at,
      updatedAt: at,
      caseExecutions: row.caseExecutions.map((execution) => ({
        ...execution,
        createdAt: at,
        updatedAt: at,
        dispatchStatus: "LINKED",
      })),
      specificationSnapshots: row.specificationSnapshots.map((spec) => ({
        ...spec,
        _count: { cases: spec.cases.length },
      })),
      sourceKind: "LINEAR_ISSUE",
      executionDisposition: "EXECUTED",
      verdict: "PASSED",
      currentStage: "SPEC_EXECUTION",
      waitingReason: null,
    };
  }

  it.each(["list", "listPage"] as const)(
    "%s batches scores and preserves proven criteria in a blocked Case",
    async (method) => {
      const row = listRow();
      const run = row.caseExecutions[0]!.run;
      const criterion =
        row.specificationSnapshots[0]!.cases[0]!.definition.criteria[0]!;
      const passed = run.criterionResults[0]!;
      run.criteriaSnapshot = Array.from({ length: 5 }, (_, i) => ({
        ...run.criteriaSnapshot[0]!,
        id: `check-${i + 1}`,
      }));
      row.specificationSnapshots[0]!.cases[0]!.definition.criteria =
        run.criteriaSnapshot.map((item) => ({ ...criterion, id: item.id }));
      run.criterionResults = run.criteriaSnapshot.slice(0, 4).map((item) => ({
        ...passed,
        criterionId: item.id,
      }));
      run.executionDisposition = "BLOCKED";
      const active = { ...listRow("active"), lifecycle: "RUNNING" };
      const findMany = vi
        .fn()
        .mockResolvedValueOnce([row, active])
        .mockResolvedValueOnce([row]);
      const service = new TaskExecutionService(
        {
          taskExecution: { findMany, count: vi.fn().mockResolvedValue(2) },
          $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
        } as never,
        {} as never,
        {} as never,
      );
      const result =
        method === "list"
          ? await service.list(current)
          : (await service.listPage(current, 1, 10)).items;
      expect(result[0]!.acceptanceScore).toMatchObject({
        score: 80,
        passed: 4,
        total: 5,
        failed: 0,
        unknown: 1,
        recommendation: "NEEDS_VALIDATION",
      });
      expect(result[0]!.acceptanceScore).not.toHaveProperty("findings");
      expect(result[1]!.acceptanceScore).toBeNull();
      expect(findMany).toHaveBeenCalledTimes(2);
      expect(findMany.mock.calls[1]![0].where).toEqual({
        teamId: "team-1",
        id: { in: ["task-1"] },
      });
    },
  );

  it("does not reuse a score when the task changes between list and report reads", async () => {
    const row = listRow();
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([
        { ...row, updatedAt: new Date(at.getTime() + 1) },
      ]);
    const service = new TaskExecutionService(
      { taskExecution: { findMany } } as never,
      {} as never,
      {} as never,
    );
    expect((await service.list(current))[0]).toMatchObject({
      acceptanceScore: null,
      cleanupPending: false,
    });
  });

  it("keeps cleanup reminders separate from list verdicts", async () => {
    const row = listRow();
    const run = row.executionRuns[0]!;
    run.executionDisposition = "BLOCKED";
    run.verdict = null;
    row.executionDisposition = "BLOCKED";
    run.tasks = [
      {
        attemptId: "attempt-1",
        error: null,
        result: {
          kind: "VERIFICATION_COMPLETED",
          executionDisposition: "EXECUTED",
          verdict: "PASSED",
          cleanup: { status: "BLOCKED", note: "写入归属待核对" },
        },
      },
    ];
    const findMany = vi.fn().mockResolvedValue([row]);
    const service = new TaskExecutionService(
      { taskExecution: { findMany } } as never,
      {} as never,
      {} as never,
    );
    expect((await service.list(current))[0]).toMatchObject({
      cleanupPending: true,
      verdict: "PASSED",
      executionDisposition: "EXECUTED",
      acceptanceScore: { score: 100 },
    });
    run.evidences = [];
    expect((await service.list(current))[0]).toMatchObject({
      cleanupPending: true,
      verdict: "INCONCLUSIVE",
    });
  });

  it("keeps tasks without verified evidence unscored", async () => {
    const row = listRow();
    row.caseExecutions[0]!.run.evidences = [];
    const empty = {
      ...listRow("empty"),
      specificationSnapshots: [],
      caseExecutions: [],
      executionRuns: [],
    };
    const findMany = vi.fn().mockResolvedValue([row, empty]);
    const service = new TaskExecutionService(
      { taskExecution: { findMany } } as never,
      {} as never,
      {} as never,
    );
    const result = await service.list(current);
    expect(result[0]!.acceptanceScore).toMatchObject({
      score: null,
      passed: 0,
      unknown: 1,
    });
    expect(result[1]!.acceptanceScore?.score).toBeNull();
  });

  it.each(["PASSED", "INCONCLUSIVE", "BLOCKED", "EXECUTION_FAILED"] as const)(
    "filters historical cleanup reminders before pagination for %s",
    async (status) => {
      const row = {
        ...listRow(),
        executionDisposition: "BLOCKED",
        verdict: null,
      };
      const run = row.executionRuns[0]!;
      run.executionDisposition = "BLOCKED";
      run.verdict = null;
      run.tasks = [
        {
          attemptId: "attempt-1",
          error: null,
          result: {
            kind: "VERIFICATION_COMPLETED",
            executionDisposition: "EXECUTED",
            verdict: "PASSED",
            cleanup: { status: "BLOCKED", note: "写入归属待核对" },
          },
        },
      ];
      if (status === "INCONCLUSIVE") run.evidences = [];
      const findMany = vi
        .fn()
        .mockImplementation((args) => (args.take ? [] : [row]));
      const count = vi.fn().mockResolvedValue(0);
      const service = new TaskExecutionService(
        {
          taskExecution: { findMany, count },
          $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
        } as never,
        {} as never,
        {} as never,
      );
      await service.listPage(current, 2, 10, { status, query: "PFRD" });
      const where = count.mock.calls[0]![0].where;
      expect(findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
          where,
        }),
      );
      expect(where.AND[0]).toMatchObject({
        teamId: "team-1",
        OR: expect.any(Array),
      });
      expect(where.AND[1].OR[0].AND[1]).toEqual({ id: { notIn: [row.id] } });
      expect(where.AND[1].OR[1]).toEqual({
        id: { in: ["PASSED", "INCONCLUSIVE"].includes(status) ? [row.id] : [] },
      });
    },
  );
});

it("keeps a recorded session-loss gap in the score and excludes only an unrecorded one", () => {
  const row = fixture();
  const run = row.caseExecutions[0]!.run;
  run.executionDisposition = "RUNTIME_LOST";
  run.verdict = null;
  run.tasks = [
    {
      attemptId: "attempt-1",
      result: null,
      error: {
        code: "RUNTIME_SESSION_UNAVAILABLE",
        message: "浏览器会话已失效。",
      },
    },
  ];
  const recorded = run.criterionResults[0]!;
  recorded.status = "INCONCLUSIVE";
  recorded.evidenceRefs = [];
  expect(report(row).assessment).toMatchObject({
    score: null,
    excluded: 0,
    unknown: 1,
    total: 1,
    findings: [expect.objectContaining({ kind: "VALIDATION_GAP" })],
  });
  run.criterionResults = [];
  expect(report(row).assessment).toMatchObject({
    score: null,
    excluded: 1,
    total: 0,
    findings: [],
    exclusions: [{ code: "RUNTIME_SESSION_UNAVAILABLE" }],
  });
  run.criterionResults = [recorded];
  recorded.status = "FAILED";
  recorded.evidenceRefs = ["dom-1", "screen-1"];
  expect(report(row).assessment).toMatchObject({
    failed: 1,
    excluded: 0,
    score: 0,
  });
});
