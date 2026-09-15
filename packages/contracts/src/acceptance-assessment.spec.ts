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
