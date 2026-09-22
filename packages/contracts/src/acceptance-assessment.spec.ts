import { describe, expect, it } from "vitest";
import { assessAcceptance } from "./acceptance-assessment.js";
import type {
  AcceptanceCase,
  AcceptanceVerdict,
} from "./task-acceptance-report.js";
const input = (statuses: AcceptanceVerdict[]) => ({
  final: true,
  aiAccepted: false,
  verdict: "INCONCLUSIVE" as AcceptanceVerdict,
  scope: "REQUIREMENT" as const,
  lifecycle: "COMPLETED",
  coverageComplete: true,
  requirements: [],
  cases: [
    {
      caseId: "case-1",
      name: "白名单开关",
      runId: "run-1",
      deployment: "test",
      targetUrl: "https://test.example/whitelist",
      attemptNumber: 1,
      executionOrdinal: 1,
      lifecycle: "COMPLETED",
      executionDisposition: "EXECUTED",
      verdict: "INCONCLUSIVE",
      issues: [],
      criteria: statuses.map((verdict, i) => ({
        id: `c${i}`,
        requirementId: null,
        required: true,
        description: "开关默认开启",
        summary: "实际观察",
        verdict,
        recordedVerdict: verdict,
        evidence: [],
        issues: [],
      })),
    },
  ] as AcceptanceCase[],
});
describe("evidence scoring and release gates", () => {
  const environmentIssue = {
    category: "PRECONDITION" as const,
    code: "DATA_PRECONDITION",
    message: "MinerU cacheRead 当前价格低于红线，无法创建测试记录。",
    nextStep: "准备可用的测试 SKU 后补验。",
  };
  it("excludes environmental blockers from scores and findings while retaining a warning", () => {
    const report = input(["INCONCLUSIVE"]);
    report.cases[0]!.criteria[0]!.issues = [environmentIssue];
    expect(assessAcceptance(report)).toMatchObject({
      method: "REQUIRED_CRITERIA_V2",
      score: null,
      total: 0,
      excluded: 1,
      unknown: 0,
      findings: [],
      recommendation: "NEEDS_VALIDATION",
      exclusions: [
        { code: "DATA_PRECONDITION", reason: environmentIssue.message },
      ],
    });
  });
  it("keeps a recorded locator gap when the case also lost its runtime", () => {
    const report = input(["PASSED", "FAILED", "INCONCLUSIVE"]);
    report.cases[0]!.issues = [
      {
        ...environmentIssue,
        category: "EXECUTION",
        code: "RUNTIME_LEASE_LOST",
      },
    ];
    expect(assessAcceptance(report)).toMatchObject({
      score: 33,
      total: 3,
      passed: 1,
      failed: 1,
      unknown: 1,
      excluded: 0,
      recommendation: "NOT_RECOMMENDED",
      findings: [{ kind: "PRODUCT" }, { kind: "VALIDATION_GAP" }],
    });
  });
  it("excludes an unrecorded criterion when the case failed for an environment reason", () => {
    const report = input(["PASSED", "INCONCLUSIVE"]);
    report.cases[0]!.criteria[1]!.recordedVerdict = null;
    report.cases[0]!.issues = [
      {
        ...environmentIssue,
        category: "EXECUTION",
        code: "RUNTIME_LEASE_LOST",
      },
    ];
    expect(assessAcceptance(report)).toMatchObject({
      score: 100,
      total: 1,
      passed: 1,
      excluded: 1,
      unknown: 0,
      findings: [],
      recommendation: "NEEDS_VALIDATION",
    });
  });
  it.each([
    "RUNTIME_LEASE_LOST",
    "RUNTIME_SESSION_UNAVAILABLE",
    "SESSION_OPEN_FAILED",
    "WRITE_OUTCOME_UNKNOWN",
    "PROVIDER_UNAVAILABLE",
  ])(
    "excludes unverified criteria for explicit execution environment failure %s",
    (code) => {
      const report = input(["INCONCLUSIVE"]);
      report.cases[0]!.criteria[0]!.recordedVerdict = null;
      report.cases[0]!.issues = [
        { ...environmentIssue, category: "EXECUTION", code },
      ];
      expect(assessAcceptance(report)).toMatchObject({
        score: null,
        total: 0,
        excluded: 1,
      });
    },
  );
  it.each([
    "BLOCKED",
    "REPEATED_OPERATIONS",
    "LOCATOR_RECOVERY_EXHAUSTED",
    "ANALYSIS_INPUT_MISSING",
  ])("does not infer environment exclusion for %s", (code) => {
    const report = input(["INCONCLUSIVE"]);
    report.cases[0]!.issues = [
      { ...environmentIssue, category: "EXECUTION", code },
    ];
    expect(assessAcceptance(report)).toMatchObject({
      score: null,
      total: 1,
      excluded: 0,
    });
  });
  it("does not exclude missing evidence for a recorded failure or an active case", () => {
    const report = input(["INCONCLUSIVE"]);
    const c = report.cases[0]!;
    c.issues = [environmentIssue];
    c.criteria[0]!.recordedVerdict = "FAILED";
    expect(assessAcceptance(report)).toMatchObject({
      score: null,
      excluded: 0,
    });
    c.criteria[0]!.recordedVerdict = "INCONCLUSIVE";
    c.lifecycle = "RUNNING";
    expect(assessAcceptance(report)).toMatchObject({
      score: null,
      excluded: 0,
    });
  });
  it("keeps unverified scopes unscored while retaining confirmed failure scores", () => {
    for (const statuses of [
      ["PENDING"],
      ["INCONCLUSIVE"],
      ["PENDING", "INCONCLUSIVE"],
    ] as AcceptanceVerdict[][]) {
      expect(assessAcceptance(input(statuses))).toMatchObject({
        score: null,
        total: statuses.length,
        excluded: 0,
      });
    }
    expect(assessAcceptance(input(["FAILED"]))).toMatchObject({
      score: 0,
      failed: 1,
      recommendation: "NOT_RECOMMENDED",
    });
  });
  it("does not count optional environment checks as excluded required criteria", () => {
    const report = input(["PASSED", "INCONCLUSIVE"]);
    const k = report.cases[0]!.criteria[1]!;
    k.required = false;
    k.issues = [environmentIssue];
    expect(assessAcceptance(report)).toMatchObject({
      score: 100,
      total: 1,
      excluded: 0,
    });
  });
  it("preserves four proven criteria when one Case is partly blocked", () => {
    const report = input([
      "PASSED",
      "PASSED",
      "PASSED",
      "PASSED",
      "INCONCLUSIVE",
    ]);
    expect(assessAcceptance(report)).toMatchObject({
      score: 80,
      passed: 4,
      total: 5,
      failed: 0,
      unknown: 1,
      recommendation: "NEEDS_VALIDATION",
    });
  });
  it("blocks release for confirmed required failure even at a high score", () => {
    const report = input([
      ...Array<AcceptanceVerdict>(99).fill("PASSED"),
      "FAILED",
    ]);
    expect(assessAcceptance(report)).toMatchObject({
      score: 99,
      recommendation: "NOT_RECOMMENDED",
      findings: [
        expect.objectContaining({
          kind: "PRODUCT",
          expected: "开关默认开启",
          observed: "实际观察",
        }),
      ],
    });
  });
  it("does not inflate scores with optional checks or remove unknowns from the denominator", () => {
    const report = input(["PASSED", "INCONCLUSIVE", "PASSED"]);
    report.cases[0]!.criteria[2]!.required = false;
    expect(assessAcceptance(report)).toMatchObject({
      score: 50,
      total: 2,
      unknown: 1,
    });
  });
  it("never rounds incomplete evidence to 100 or assigns a score to an empty scope", () => {
    expect(
      assessAcceptance(
        input([
          ...Array<AcceptanceVerdict>(999).fill("PASSED"),
          "INCONCLUSIVE",
        ]),
      ).score,
    ).toBe(99);
    expect(assessAcceptance(input([]))).toMatchObject({
      score: null,
      recommendation: "NEEDS_VALIDATION",
    });
  });
  it("separates full acceptance, progress, and single-case completion", () => {
    const report = input(["PASSED"]);
    expect(
      assessAcceptance({ ...report, verdict: "PASSED", aiAccepted: true })
        .recommendation,
    ).toBe("RECOMMENDED");
    expect(assessAcceptance({ ...report, final: false }).recommendation).toBe(
      "PENDING",
    );
    expect(
      assessAcceptance({ ...report, scope: "CASE", verdict: "PASSED" })
        .recommendation,
    ).toBe("SCOPED_ONLY");
    expect(
      assessAcceptance({ ...report, coverageComplete: false }).recommendation,
    ).toBe("NEEDS_VALIDATION");
  });
});
