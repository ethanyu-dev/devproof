import type {
  TaskAcceptanceReport,
  AcceptanceCriterion,
} from "./task-acceptance-report.js";

export type ReleaseRecommendation =
  | "RECOMMENDED"
  | "NEEDS_VALIDATION"
  | "NOT_RECOMMENDED"
  | "SCOPED_ONLY"
  | "PENDING";
export interface AcceptanceAssessment {
  method: "REQUIRED_CRITERIA_V1";
  score: number | null;
  passed: number;
  failed: number;
  unknown: number;
  pending: number;
  total: number;
  recommendation: ReleaseRecommendation;
  reason: string;
  findings: Array<{
    key: string;
    caseId: string;
    caseName: string;
    runId: string | null;
    criterionId: string;
    requirement: string;
    expected: string;
    observed: string;
    required: boolean;
    kind: "PRODUCT" | "VALIDATION_GAP";
    evidence: AcceptanceCriterion["evidence"];
    nextStep: string;
  }>;
}

/** Scoring is reproducible; a blocked Case retains its proven criteria. */
export function assessAcceptance(
  report: Pick<
    TaskAcceptanceReport,
    | "cases"
    | "requirements"
    | "final"
    | "verdict"
    | "aiAccepted"
    | "scope"
    | "coverageComplete"
    | "lifecycle"
  >,
): AcceptanceAssessment {
  const criteria = report.cases
    .flatMap((c) => c.criteria)
    .filter((k) => k.required);
  const count = (verdict: string) =>
    criteria.filter((k) => k.verdict === verdict).length;
  const passed = count("PASSED");
  const failed = count("FAILED");
  const unknown = count("INCONCLUSIVE");
  const pending = count("PENDING");
  const total = criteria.length;
  // Never round partial evidence up to a perfect score.
  const score = total ? Math.floor((passed * 100) / total) : null;
  const recommendation: ReleaseRecommendation = !report.final
    ? "PENDING"
    : failed
      ? "NOT_RECOMMENDED"
      : report.aiAccepted
        ? "RECOMMENDED"
        : report.verdict === "PASSED" && report.scope !== "REQUIREMENT"
          ? "SCOPED_ONLY"
          : "NEEDS_VALIDATION";
  const reason =
    recommendation === "PENDING"
      ? "用例尚未全部结束，当前为进度评分；最终建议将在执行结束后生成。"
      : recommendation === "NOT_RECOMMENDED"
        ? `${failed} 个必需验收点已确认不符合需求，建议修复并复验后再上线。`
        : recommendation === "RECOMMENDED"
          ? "完整需求范围内的必需验收点均有证据支持通过，建议进入上线流程。"
          : recommendation === "SCOPED_ONLY"
            ? "本次指定范围已通过；需要结合整个需求的验证结果决定是否上线。"
            : !total
              ? "没有可评分的必需验收点，需先补齐验收范围。"
              : unknown || pending
                ? `已验证通过 ${passed}/${total} 个必需验收点，仍有 ${unknown + pending} 个待确认；补齐相关验证后再决定上线。`
                : !report.coverageComplete
                  ? "已定义的验收点通过，但需求来源或范围覆盖仍有缺口，需补齐后再决定上线。"
                  : "已有验收点结果与执行收尾状态尚未完全一致，核实执行结果后再决定上线。";
  const findings = report.cases.flatMap((c) =>
    c.criteria
      .filter((k) => k.verdict === "FAILED" || k.verdict === "INCONCLUSIVE")
      .map((k) => ({
        key: `${c.runId ?? c.caseId}/${c.deployment}/${k.id}`,
        caseId: c.caseId,
        caseName: c.name,
        runId: c.runId,
        criterionId: k.id,
        requirement:
          report.requirements.find((r) => r.id === k.requirementId)
            ?.description ?? k.description,
        expected: k.description,
        observed: k.summary,
        required: k.required,
        kind:
          k.verdict === "FAILED"
            ? ("PRODUCT" as const)
            : ("VALIDATION_GAP" as const),
        evidence: k.evidence,
        nextStep:
          k.issues[0]?.nextStep ??
          (k.verdict === "FAILED"
            ? "修复与需求不符的行为并重新验证。"
            : "补齐实际证据，重新验证该验收点。"),
      })),
  );
  return {
    method: "REQUIRED_CRITERIA_V1",
    score,
    passed,
    failed,
    unknown,
    pending,
    total,
    recommendation,
    reason,
    findings,
  };
}
