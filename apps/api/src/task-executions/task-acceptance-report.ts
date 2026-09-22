import { isSpecTask } from "@devproof/contracts";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type {
  AcceptanceCase,
  AcceptanceCriterion,
  AcceptanceIssue,
  AcceptanceVerdict,
  TaskAcceptanceReport,
} from "@devproof/contracts";
import { assessAcceptance } from "@devproof/contracts";
import { caseRerunSource } from "./task-case-rerun.js";
import { redactText } from "../observability/observability.service.js";
import {
  executionCleanup,
  executionVerification,
} from "../execution-runs/execution-cleanup.js";

const runInclude = {
  attempts: { orderBy: { number: "desc" as const }, take: 1 },
  tasks: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: {
      attemptId: true,
      error: true,
      recoveryStatus: true,
      result: true,
    },
  },
  criterionResults: true,
  evidences: {
    orderBy: { id: "asc" as const },
    select: {
      id: true,
      externalId: true,
      kind: true,
      attemptId: true,
      runtimeArtifactId: true,
    },
  },
} satisfies Prisma.ExecutionRunInclude;

export const acceptanceReportInclude = {
  specificationSnapshots: {
    orderBy: { generatedAt: "desc" as const },
    take: 1,
    include: { cases: { orderBy: { position: "asc" as const } } },
  },
  deployments: {
    where: { enabled: true },
    orderBy: { createdAt: "asc" as const },
  },
  caseExecutions: { include: { run: { include: runInclude } } },
  executionRuns: {
    include: runInclude,
    orderBy: { createdAt: "asc" as const },
  },
  stages: { orderBy: { type: "asc" as const } },
} satisfies Prisma.TaskExecutionInclude;

type ReportRow = Prisma.TaskExecutionGetPayload<{
  include: typeof acceptanceReportInclude;
}>;
type ReportRun = ReportRow["executionRuns"][number];
const terminal = (s: string) =>
  ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(s);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const rows = (v: unknown) => (Array.isArray(v) ? v.map(obj) : []);
const text = (v: unknown) => (typeof v === "string" ? redactText(v) : "");
const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const issue = (
  category: AcceptanceIssue["category"],
  code: string,
  message: string,
  nextStep: string,
): AcceptanceIssue => ({ category, code, message, nextStep });

export function taskVerificationPresentation<
  T extends {
    lifecycle: string;
    executionDisposition: string | null;
    verdict: string | null;
    counts: {
      passed: number;
      failed: number;
      inconclusive: number;
      blocked: number;
    };
  },
>(task: T, report: TaskAcceptanceReport | null) {
  const cleanupPending = report?.cases.some((c) => c.cleanup) ?? false;
  const legacyCleanup =
    task.lifecycle === "COMPLETED" &&
    task.executionDisposition === "BLOCKED" &&
    cleanupPending &&
    report!.cases.every(
      (c) =>
        c.lifecycle === "COMPLETED" && c.executionDisposition === "EXECUTED",
    );
  return {
    ...task,
    cleanupPending,
    ...(legacyCleanup
      ? {
          executionDisposition: "EXECUTED",
          verdict: report!.verdict,
          counts: {
            ...task.counts,
            passed: report!.counts.cases.PASSED,
            failed: report!.counts.cases.FAILED,
            inconclusive: report!.counts.cases.INCONCLUSIVE,
            blocked: 0,
          },
        }
      : {}),
  };
}

function executionIssue(
  run: ReportRun | null,
  lifecycle: string,
  error: unknown,
): AcceptanceIssue | null {
  const storedFailure = obj(error);
  const currentAttempt = run?.attempts.find(
    (a) => a.number === run.currentAttemptNumber,
  );
  const recoveryResolved =
    storedFailure.code === "WRITE_OUTCOME_UNKNOWN" &&
    run?.tasks.some(
      (t) =>
        t.attemptId === currentAttempt?.id && t.recoveryStatus === "RESOLVED",
    );
  const originalFailure = obj(obj(storedFailure.details).originalError);
  const failure = recoveryResolved
    ? typeof originalFailure.code === "string"
      ? originalFailure
      : {
          code: "RUNTIME_EXECUTION_INTERRUPTED",
          message: "执行已中断，写入核实已完成；未完成的验收点需重新验证。",
        }
    : storedFailure;
  const code = text(failure.code);
  const original = obj(obj(failure.details).originalError);
  const environmentMessage: Record<string, string> = {
    RUNTIME_LEASE_LOST: "执行节点租约丢失，验证中断，未形成验收结论。",
    WRITE_OUTCOME_UNKNOWN:
      "执行中断后无法确认业务写入结果；请先只读核对相关数据，再决定是否重试。",
  };
  const message = [
    environmentMessage[code] ?? text(failure.message),
    text(original.code)
      ? `${text(original.code)}: ${text(original.message)}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (lifecycle === "CANCELLED")
    return issue(
      "CANCELLED",
      "CANCELLED",
      "执行已取消，未完成部分不视为通过。",
      "保留已有发现，按需重新执行未完成部分。",
    );
  if (lifecycle === "TIMED_OUT")
    return issue(
      "TIMEOUT",
      code || "TIMEOUT",
      message || "执行超过时限，验证未完成。",
      "检查耗时步骤或模型响应，再执行未完成部分。",
    );
  if (!run || run.executionDisposition !== "EXECUTED") {
    const prerequisite =
      /^(TEST_ACCOUNT|AUTH_|PROFILE_|DEPLOYMENT_|DATA_PRECONDITION|ENVIRONMENT_)/u.test(
        code,
      );
    return issue(
      prerequisite ? "PRECONDITION" : "EXECUTION",
      code || run?.executionDisposition || "NOT_RUN",
      message || "执行未完成，当前没有足够的验收结论。",
      prerequisite
        ? "补齐说明中的账号、登录、环境或需求条件后重新验证。"
        : recoveryResolved
          ? "写入核实已完成；处理上述原始执行问题后重新验证。"
          : "查看执行记录并处理阻塞；存在未确认写入时先核对实际业务结果。",
    );
  }
  return null;
}

function criterionReport(
  def: Record<string, unknown>,
  run: ReportRun | null,
  final: boolean,
): AcceptanceCriterion {
  const id = text(def.id);
  const attempt = run?.attempts.find(
    (a) => a.number === run.currentAttemptNumber,
  );
  const result = attempt
    ? run?.criterionResults.find(
        (r) => r.attemptId === attempt.id && r.criterionId === id,
      )
    : null;
  const evidence = result
    ? (run?.evidences ?? [])
        .filter(
          (e) =>
            e.attemptId === attempt?.id &&
            result.evidenceRefs.includes(e.externalId),
        )
        .map((e) => ({
          id: e.id,
          ref: e.externalId,
          kind: e.kind,
          downloadPath: e.runtimeArtifactId
            ? `/console/api/runs/${run!.id}/evidences/${e.id}/download`
            : null,
        }))
    : [];
  const requiredKinds = strings(def.requiredEvidenceKinds);
  const hasProof =
    Boolean(result?.evidenceRefs.length) &&
    result!.evidenceRefs.every((ref) => evidence.some((e) => e.ref === ref)) &&
    requiredKinds.every((kind) => evidence.some((e) => e.kind === kind));
  const issues: AcceptanceIssue[] = [];
  let verdict: AcceptanceVerdict = final ? "INCONCLUSIVE" : "PENDING";
  if (result && ["PASSED", "FAILED"].includes(result.status) && hasProof)
    verdict = result.status as AcceptanceVerdict;
  else if (result || final) {
    verdict = "INCONCLUSIVE";
    issues.push(
      issue(
        result?.status === "INCONCLUSIVE" ? "UNDETERMINED" : "EVIDENCE",
        result?.status === "INCONCLUSIVE"
          ? "INCONCLUSIVE"
          : "EVIDENCE_INCOMPLETE",
        text(result?.summary) || "尚无当前执行尝试的完整判定与证据。",
        "根据记录的原因补齐前置条件或实际证据，再验证受影响的验收点。",
      ),
    );
  }
  if (verdict === "FAILED")
    issues.push(
      issue(
        "PRODUCT",
        "CRITERION_FAILED",
        text(result?.summary) || "实际行为不满足验收要求。",
        "根据对应证据修复产品行为，再验证该验收点。",
      ),
    );
  // A classification alone is insufficient: require evidence from this attempt.
  if (
    verdict === "INCONCLUSIVE" &&
    result?.status === "INCONCLUSIVE" &&
    ["DATA_PRECONDITION", "ENVIRONMENT_UNAVAILABLE"].includes(
      result.blockingReason ?? "",
    ) &&
    evidence.length > 0 &&
    result.evidenceRefs.every((ref) => evidence.some((e) => e.ref === ref))
  ) {
    issues.push(
      issue(
        "PRECONDITION",
        result.blockingReason!,
        text(result.summary),
        "核对并准备符合前置条件的测试数据、权限或环境后重跑；既有数据需经授权处置，写入结果未确认时先只读核对。",
      ),
    );
  }
  return {
    id,
    requirementId: text(def.requirementId) || null,
    description: text(def.description) || id,
    required: def.required !== false,
    verdict,
    recordedVerdict: result?.status ?? null,
    summary: text(result?.summary) || "尚未形成判定",
    evidence,
    issues,
  };
}

function aggregate(
  verdicts: AcceptanceVerdict[],
  final: boolean,
): AcceptanceVerdict {
  if (verdicts.includes("FAILED")) return "FAILED";
  if (!final) return "PENDING";
  return verdicts.length > 0 && verdicts.every((v) => v === "PASSED")
    ? "PASSED"
    : "INCONCLUSIVE";
}

function caseReport(
  input: {
    caseId: string;
    name: string;
    deployment: string;
    targetUrl: string | null;
    executionOrdinal: number;
    run: ReportRun | null;
    definition: unknown;
    dispatchError?: unknown;
  },
  final: boolean,
): AcceptanceCase {
  const { run: storedRun, definition, dispatchError, ...meta } = input;
  const run = storedRun
    ? { ...storedRun, ...executionVerification(storedRun) }
    : null;
  const attempt = run?.attempts.find(
    (a) => a.number === run.currentAttemptNumber,
  );
  const cleanup = executionCleanup(
    run?.tasks.find((t) => t.attemptId === attempt?.id)?.result,
  );
  const lifecycle = run?.lifecycle ?? (final ? "COMPLETED" : "QUEUED");
  // The immutable Run snapshot is the acceptance contract for this attempt.
  const declared = rows(obj(definition).criteria);
  const definitions: Record<string, unknown>[] = run
    ? rows(run.criteriaSnapshot).map((d) => ({
        ...d,
        requirementId: declared.find((k) => k.id === d.id)?.requirementId,
      }))
    : declared;
  for (const declaredCriterion of declared)
    if (!definitions.some((d) => d.id === declaredCriterion.id))
      definitions.push(declaredCriterion);
  const criteria = definitions.map((d) =>
    criterionReport(d, run, final || terminal(lifecycle)),
  );
  const required = criteria.filter((c) => c.required);
  const errors =
    run?.tasks.find((t) => t.attemptId === attempt?.id)?.error ??
    attempt?.error ??
    dispatchError;
  const blocker = executionIssue(run, lifecycle, errors);
  const issues = blocker && (final || terminal(lifecycle)) ? [blocker] : [];
  if (!required.length)
    issues.push(
      issue(
        "COVERAGE",
        "NO_REQUIRED_CRITERIA",
        "没有可追溯的必需验收点。",
        "补充有需求来源的验收标准后重新验证。",
      ),
    );
  let verdict = aggregate(
    required.map((c) => c.verdict),
    final || terminal(lifecycle),
  );
  if (
    verdict === "PASSED" &&
    (run?.executionDisposition !== "EXECUTED" ||
      run.verdict !== "PASSED" ||
      lifecycle !== "COMPLETED")
  ) {
    verdict = "INCONCLUSIVE";
    if (!blocker)
      issues.push(
        issue(
          "EVIDENCE",
          "VERDICT_NOT_CONFIRMED",
          "验收点记录与执行最终判定尚未一致。",
          "核对执行最终结果，必要时重新验证。",
        ),
      );
  }
  return {
    ...meta,
    cleanup,
    lifecycle,
    executionDisposition: run?.executionDisposition ?? null,
    runId: run?.id ?? null,
    attemptNumber: run?.currentAttemptNumber ?? null,
    verdict,
    criteria,
    issues,
  };
}

export function buildTaskAcceptanceReport(
  row: ReportRow,
  generatedAt = new Date(),
): TaskAcceptanceReport {
  const final = terminal(row.lifecycle);
  const snapshot = row.specificationSnapshots[0];
  const specification = obj(obj(snapshot?.context).specification);
  const scope: TaskAcceptanceReport["scope"] = caseRerunSource(
    row.environmentSnapshot,
  )
    ? "CASE"
    : isSpecTask(row)
      ? "REQUIREMENT"
      : "DIRECT";
  const cases: AcceptanceCase[] = [];
  if (isSpecTask(row)) {
    for (const testCase of snapshot?.cases ?? [])
      for (const deployment of row.deployments) {
        const execution = row.caseExecutions
          .filter(
            (e) => e.caseId === testCase.id && e.deploymentId === deployment.id,
          )
          .sort((a, b) => b.executionOrdinal - a.executionOrdinal)[0];
        cases.push(
          caseReport(
            {
              caseId: testCase.id,
              name: testCase.name,
              deployment: deployment.name,
              targetUrl: deployment.targetUrl,
              executionOrdinal: execution?.executionOrdinal ?? 1,
              run: execution?.run ?? null,
              definition: testCase.definition,
              dispatchError: execution?.dispatchLastError,
            },
            final,
          ),
        );
      }
  } else {
    for (const run of row.executionRuns)
      cases.push(
        caseReport(
          {
            caseId: run.id,
            name: run.goal.split("\n")[0] || row.title,
            deployment: "指定环境",
            targetUrl: text(obj(run.environmentSnapshot).targetUrl) || null,
            executionOrdinal: 1,
            run,
            definition: {},
          },
          final,
        ),
      );
  }
  const uncovered = rows(specification.uncoveredRequirements);
  const requirements = rows(specification.requirements).map((req) => {
    const matches = cases.flatMap((c) =>
      c.criteria
        .filter((k) => k.required && k.requirementId === req.id)
        .map((k) => ({ caseId: c.caseId, verdict: k.verdict })),
    );
    const missing = uncovered.find((u) => u.requirementId === req.id);
    return {
      id: text(req.id),
      description: text(req.description),
      sourceRef: text(req.sourceRef) || null,
      verdict: missing
        ? ("INCONCLUSIVE" as const)
        : aggregate(
            matches.map((m) => m.verdict),
            final,
          ),
      caseIds: [...new Set(matches.map((m) => m.caseId))],
      reason:
        text(missing?.reason) || (matches.length ? null : "尚无关联的验收结果"),
    };
  });
  const issues: AcceptanceIssue[] = [];
  const diagnostics = rows(snapshot?.diagnostics).filter(
    (d) => d.level !== "INFO",
  );
  const supplemental = (d: Record<string, unknown>) =>
    d.code === "GITHUB_CHECKS_UNAVAILABLE";
  const onlySupplementalGaps =
    diagnostics.length > 0 && diagnostics.every(supplemental);
  if (scope === "REQUIREMENT") {
    if (
      !snapshot ||
      (snapshot.completeness !== "COMPLETE" && !onlySupplementalGaps) ||
      !row.sourceSnapshotComplete
    )
      issues.push(
        issue(
          "COVERAGE",
          "SOURCE_INCOMPLETE",
          "需求或变更来源不完整，不能据此认定整个需求通过。",
          "补齐需求与关联变更来源，重新确认测试范围。",
        ),
      );
    if (!requirements.length)
      issues.push(
        issue(
          "COVERAGE",
          "REQUIREMENT_MAPPING_MISSING",
          "历史规格缺少结构化的需求与验收点映射。",
          "重新分析需求并补齐可追溯的验收覆盖。",
        ),
      );
    if (requirements.some((r) => r.reason))
      issues.push(
        issue(
          "COVERAGE",
          "REQUIREMENT_UNCOVERED",
          "存在尚未覆盖的需求。",
          "查看需求覆盖表，补充缺失的用例或验证条件。",
        ),
      );
    if (
      cases.some((c) =>
        c.criteria.some(
          (k) =>
            k.required && !requirements.some((r) => r.id === k.requirementId),
        ),
      )
    )
      issues.push(
        issue(
          "COVERAGE",
          "CRITERION_REQUIREMENT_MISSING",
          "部分必需验收点未关联到本次需求。",
          "核对规格来源和需求映射后重新验证。",
        ),
      );
    for (const diagnostic of diagnostics)
      issues.push(
        issue(
          supplemental(diagnostic) ? "CONTEXT" : "COVERAGE",
          text(diagnostic.code) || "SPEC_DIAGNOSTIC",
          text(diagnostic.message),
          "检查 Spec 分析来源与覆盖说明。",
        ),
      );
  }
  if (!cases.length)
    issues.push(
      issue(
        "COVERAGE",
        "NO_EXECUTION_SCOPE",
        "当前没有完整的用例与执行环境范围。",
        "先完成 Spec 分析并指定验证环境。",
      ),
    );
  for (const stage of row.stages.filter((s) => s.status === "FAILED")) {
    const legacyCleanupProjection = [
      ...row.executionRuns,
      ...row.caseExecutions.flatMap((c) => (c.run ? [c.run] : [])),
    ].some(
      (run) =>
        run.executionDisposition === "BLOCKED" &&
        executionVerification(run).executionDisposition === "EXECUTED",
    );
    if (
      stage.type === "SPEC_EXECUTION" &&
      !stage.lastError &&
      legacyCleanupProjection &&
      cases.length > 0 &&
      cases.every(
        (c) =>
          c.lifecycle === "COMPLETED" && c.executionDisposition === "EXECUTED",
      )
    )
      continue;
    const e = obj(stage.lastError);
    issues.push(
      issue(
        "EXECUTION",
        text(e.code) || "STAGE_FAILED",
        text(e.message) || `${stage.type} 阶段未完成。`,
        "查看任务日志，处理对应阶段的问题。",
      ),
    );
  }
  if (row.lifecycle === "CANCELLED" || row.lifecycle === "TIMED_OUT")
    issues.push(executionIssue(null, row.lifecycle, null)!);
  const coverageComplete =
    cases.length > 0 && !issues.some((i) => i.category === "COVERAGE");
  let verdict = aggregate(
    cases.map((c) => c.verdict),
    final,
  );
  if (
    verdict === "PASSED" &&
    (!coverageComplete ||
      row.lifecycle !== "COMPLETED" ||
      issues.some((i) => i.category !== "CONTEXT"))
  )
    verdict = "INCONCLUSIVE";
  // Active reports are progress snapshots, including any already confirmed defects.
  if (!final) verdict = "PENDING";
  const aiAccepted = verdict === "PASSED" && scope === "REQUIREMENT";
  const count = (values: AcceptanceVerdict[]) => ({
    total: values.length,
    PASSED: values.filter((v) => v === "PASSED").length,
    FAILED: values.filter((v) => v === "FAILED").length,
    INCONCLUSIVE: values.filter((v) => v === "INCONCLUSIVE").length,
    PENDING: values.filter((v) => v === "PENDING").length,
  });
  const criteria = cases.flatMap((c) => c.criteria);
  const summary = !final
    ? "验证尚未结束；当前报告保留已确认的发现，暂不授予 AI 验收通过。"
    : verdict === "FAILED"
      ? "已有必需验收点的证据表明产品不满足要求；同时保留其余未完成项。"
      : aiAccepted
        ? "本次需求范围已完整覆盖，所有必需验收点均有证据支持通过。"
        : verdict === "PASSED"
          ? "本次选定范围的验收点已通过；该报告不代表整个需求已获 AI 验收通过。"
          : "现有覆盖、执行结果或证据不足，不能认定本次需求已通过 AI 验收。";
  const content = {
    version: 2 as const,
    taskId: row.id,
    title: row.title,
    sourceRef: row.sourceRef,
    scope,
    specificationId: snapshot?.id ?? null,
    sourceHash: snapshot?.sourceHash ?? null,
    pullRequestUrl: snapshot?.primaryPullRequestUrl ?? null,
    lifecycle: row.lifecycle,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    final,
    verdict,
    aiAccepted,
    summary,
    coverageComplete,
    counts: {
      cases: count(cases.map((c) => c.verdict)),
      criteria: {
        ...count(criteria.map((c) => c.verdict)),
        required: criteria.filter((c) => c.required).length,
      },
    },
    requirements,
    cases,
    issues,
  };
  const assessed = { ...content, assessment: assessAcceptance(content) };
  const revision = createHash("sha256")
    .update(JSON.stringify(assessed))
    .digest("hex")
    .slice(0, 16);
  return { ...assessed, generatedAt: generatedAt.toISOString(), revision };
}
