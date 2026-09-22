import type {
  TaskAcceptanceReport,
  AcceptanceCriterion,
  AcceptanceCase,
  AcceptanceIssue,
} from "./task-acceptance-report.js";

export type ReleaseRecommendation =
  | "RECOMMENDED"
  | "NEEDS_VALIDATION"
  | "NOT_RECOMMENDED"
  | "SCOPED_ONLY"
  | "PENDING";
export interface AcceptanceAssessment {
  method: "REQUIRED_CRITERIA_V1" | "REQUIRED_CRITERIA_V2";
  score: number | null;
  passed: number;
  failed: number;
  unknown: number;
  pending: number;
  total: number;
  excluded?: number;
  exclusions?: Array<{
    caseId: string;
    caseName: string;
    deployment: string;
    runId: string | null;
    criterionId: string;
    required: boolean;
    reason: string;
    code: string;
    nextStep: string;
    evidence: AcceptanceCriterion["evidence"];
  }>;
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

/** Only explicit environment/precondition failures qualify; never infer from prose. */
export function isAcceptanceEnvironmentBlocker(issue: AcceptanceIssue) {
  return (
    issue.category === "PRECONDITION" ||
    (issue.category === "EXECUTION" &&
      /^(RUNTIME_|BROWSER_UNAVAILABLE$|SESSION_OPEN_FAILED$|PROVIDER_|WRITE_OUTCOME_UNKNOWN$)/u.test(
        issue.code,
      ))
  );
}

export function criterionScoringExclusion(
  testCase: AcceptanceCase,
  criterion: AcceptanceCriterion,
): AcceptanceIssue | null {
  if (
    criterion.verdict !== "INCONCLUSIVE" ||
    !["COMPLETED", "TIMED_OUT", "CANCELLED"].includes(testCase.lifecycle)
  )
    return null;
  // A lost/missing evidence reference must not erase an already recorded result.
  if (["PASSED", "FAILED"].includes(criterion.recordedVerdict ?? ""))
    return null;
  const own = criterion.issues.find(isAcceptanceEnvironmentBlocker);
  if (own) return own;
  // A recorded inconclusive, including a locator miss, stays in the score.
  // Only a criterion with no result follows the case-level environment failure.
  if (criterion.recordedVerdict) return null;
  return testCase.issues.find(isAcceptanceEnvironmentBlocker) ?? null;
}

/** Proven criteria remain valid; environmental blockers are reported separately. */
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
    .flatMap((c) => c.criteria.filter((k) => !criterionScoringExclusion(c, k)))
    .filter((k) => k.required);
  const count = (verdict: string) =>
    criteria.filter((k) => k.verdict === verdict).length;
  const passed = count("PASSED");
  const failed = count("FAILED");
  const unknown = count("INCONCLUSIVE");
  const pending = count("PENDING");
  const total = criteria.length;
  const exclusions = report.cases.flatMap((c) =>
    c.criteria.flatMap((k) => {
      const blocker = criterionScoringExclusion(c, k);
      return blocker
        ? [
            {
              caseId: c.caseId,
              caseName: c.name,
              deployment: c.deployment,
              runId: c.runId,
              criterionId: k.id,
              required: k.required,
              reason: blocker.message,
              code: blocker.code,
              nextStep: blocker.nextStep,
              evidence: k.evidence,
            },
          ]
        : [];
    }),
  );
  const excluded = exclusions.filter((e) => e.required).length;
  // Never round partial evidence up to a perfect score.
  const score =
    total && passed + failed > 0 ? Math.floor((passed * 100) / total) : null;
  const recommendation: ReleaseRecommendation = !report.final
    ? "PENDING"
    : failed
      ? "NOT_RECOMMENDED"
      : excluded
        ? "NEEDS_VALIDATION"
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
            : excluded
              ? `${excluded} 个必需验收点因环境或前置条件受阻，已排除评分，仅保留提示；恢复条件后补验，不代表需求已通过。`
              : !total
                ? "没有可评分的必需验收点，需先补齐验收范围。"
                : unknown || pending
                  ? `已验证通过 ${passed}/${total} 个必需验收点，仍有 ${unknown + pending} 个待确认；补齐相关验证后再决定上线。`
                  : !report.coverageComplete
                    ? "已定义的验收点通过，但需求来源或范围覆盖仍有缺口，需补齐后再决定上线。"
                    : "已有验收点结果与执行收尾状态尚未完全一致，核实执行结果后再决定上线。";
  const findings = report.cases.flatMap((c) =>
    c.criteria
      .filter(
        (k) =>
          (k.verdict === "FAILED" || k.verdict === "INCONCLUSIVE") &&
          !criterionScoringExclusion(c, k),
      )
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
    method: "REQUIRED_CRITERIA_V2",
    score,
    passed,
    failed,
    unknown,
    pending,
    total,
    excluded,
    exclusions,
    recommendation,
    reason,
    findings,
  };
}
