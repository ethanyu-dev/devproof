import { z } from "zod";
import {
  browserExecutionCriterion,
  structuredNetworkMatches,
  missingRequiredEvidenceKinds,
  observedValueMatches,
  runtimeCriterionResultSchema,
  type RuntimeEvidenceRef,
  type RuntimeTaskLease,
} from "@devproof/agent-runtime-protocol";
import type { BrowserObservations } from "./browser-observation.js";
import {
  networkRequestMatches,
  requiresStructuredNetworkTarget,
} from "./network-criterion.js";
import {
  schemaCorrection,
  toolCorrection,
  type ToolCorrection,
} from "./tool-correction.js";

// Keep short, segment-local node references out of the durable result protocol.
export const criterionSubmissionSchema = runtimeCriterionResultSchema.extend({
  networkCitations: z
    .array(
      z
        .object({
          target: z.string().trim().min(1).max(500),
          observationId: z.string().uuid(),
          cursor: z.number().int().nonnegative().default(0),
          requestIndex: z.number().int().nonnegative(),
        })
        .strict(),
    )
    .max(20)
    .optional(),
  savedObservationIds: z.array(z.string().uuid()).max(20).optional(),
  citations: z
    .array(
      z
        .object({
          target: z.string().trim().min(1).max(500),
          ref: z.string().regex(/^(?:f\d+)?e\d+$/u),
        })
        .strict(),
    )
    .max(20)
    .optional(),
});

export function resolveCriterionEvidence(
  submitted: z.infer<typeof criterionSubmissionSchema>,
  criterion: RuntimeTaskLease["snapshot"]["criteria"][number],
  observations: BrowserObservations | undefined,
  evidence: Map<string, RuntimeEvidenceRef>,
  accountRevisionStartedAt?: string,
):
  | { result: z.infer<typeof runtimeCriterionResultSchema>; error?: undefined }
  | { error: ToolCorrection } {
  const issues: {
    code: ToolCorrection["code"];
    path: string;
    expected: string;
  }[] = [];
  const automaticRefs = observations?.bound?.submissionRefs(criterion.id);
  submitted = {
    ...submitted,
    ...(submitted.bindingIds?.length
      ? {}
      : automaticRefs?.bindingIds
        ? { bindingIds: automaticRefs.bindingIds }
        : {}),
    ...(submitted.comparisonReviewIds?.length
      ? {}
      : automaticRefs?.comparisonReviewIds
        ? { comparisonReviewIds: automaticRefs.comparisonReviewIds }
        : {}),
  };
  const bound = criterion.observationContract
    ? observations?.bound?.resolve(
        criterion.id,
        submitted.status,
        submitted.bindingIds ?? [],
        submitted.comparisonReviewIds ?? [],
      )
    : undefined;
  if (criterion.observationContract && (!bound || bound.error))
    return {
      error: toolCorrection(bound?.error ?? "CONTRACT_UNSUPPORTED", {
        criterionId: criterion.id,
        nextAction:
          "Read saved bindings, resolve missing scope/entity/phase evidence, and review the required images before submitting.",
      }),
    };
  const quotes = [...(submitted.observations ?? [])];
  const networkQuotes = new Set<string>();
  const refs = new Set([
    ...submitted.evidenceRefs,
    ...(bound?.evidenceRefs ?? []),
  ]);
  // Exact delivered quotations already identify their artifacts; do not make the
  // model copy a second, unrelated UUID just to retain the same evidence.
  for (const quote of submitted.observations ?? []) {
    for (const ref of observations
      ?.accountRequestEvidence(quote.observationId, quote.cursor, quote.quote)
      .keys() ?? [])
      if (evidence.has(ref)) refs.add(ref);
  }
  for (const [index, citation] of (
    submitted.networkCitations ?? []
  ).entries()) {
    const resolved = observations?.networkCitation(
      citation.observationId,
      citation.cursor,
      citation.requestIndex,
    );
    if (!resolved) {
      issues.push({
        code: "CITATION_NOT_AVAILABLE",
        path: `networkCitations.${index}`,
        expected:
          "引用 page.network 已读取的请求条目（requestIndex 从 0 开始）；请求体和响应体分别校验，缺失部分不能用于证明该部分字段。",
      });
      continue;
    }
    const { evidenceRefs, ...quote } = resolved;
    quotes.push({ target: citation.target, ...quote });
    networkQuotes.add(
      JSON.stringify([
        citation.target,
        quote.observationId,
        quote.cursor,
        quote.quote,
      ]),
    );
    evidenceRefs.forEach((ref) => refs.add(ref));
  }
  for (const [index, citation] of (submitted.citations ?? []).entries()) {
    const resolved = observations?.citation(citation.ref);
    if (!resolved) {
      issues.push({
        code: "CITATION_NOT_AVAILABLE",
        path: `citations.${index}.ref`,
        expected:
          "引用当前快照中已交付的完整 ref；旧快照、未读分页和未观察的节点不能作为证据。",
      });
      continue;
    }
    const { evidenceRefs, ...quote } = resolved;
    quotes.push({ target: citation.target, ...quote });
    evidenceRefs.forEach((ref) => refs.add(ref));
  }
  for (const id of submitted.savedObservationIds ?? []) {
    const fact = observations?.savedCitation(id, criterion.id);
    if (!fact) {
      issues.push({
        code: "CITATION_NOT_AVAILABLE",
        path: "savedObservationIds",
        expected: "仅引用该验收标准已保存的观察编号。",
      });
      continue;
    }
    quotes.push({
      target: fact.target,
      observationId: fact.observationId,
      cursor: fact.cursor,
      quote: fact.quote,
    });
    fact.evidenceRefs.forEach((ref) => refs.add(ref));
  }
  const parsed = runtimeCriterionResultSchema.safeParse({
    ...submitted,
    observations: quotes,
    evidenceRefs: [...refs],
  });
  if (!parsed.success) {
    const correction = schemaCorrection(parsed.error);
    return {
      error: toolCorrection("合并节点引用后，验收证据超出协议限制。", {
        criterionId: criterion.id,
        issues: correction.issues,
        nextAction:
          "删除重复的 observations 或 evidenceRefs；使用 citations 时无需再手动重复提交同一节点的原文和证据。",
      }),
    };
  }
  const result = parsed.data;
  if (result.evidenceRefs.some((ref) => !evidence.has(ref)))
    issues.push({
      code: "UNKNOWN_EVIDENCE_REF",
      path: "evidenceRefs",
      expected:
        "验收标准引用了尚未观察到的证据；使用 citations 绑定当前节点的真实证据，不要手写或修补 artifact ID。",
    });
  if (result.status !== "INCONCLUSIVE" && !criterion.observationContract) {
    const stageError = observations?.verdictEvidenceError(result.evidenceRefs);
    if (stageError)
      issues.push({
        code: "INVALID_EVIDENCE_STAGE",
        path: "evidenceRefs",
        expected: stageError,
      });
  }
  if (result.status === "PASSED") {
    if (
      !criterion.observationContract &&
      (criterion.requireObservedEvidence ||
        criterion.observationTargets?.length)
    ) {
      if (!criterion.observationTargets?.length)
        issues.push({
          code: "QUOTE_NOT_EXACT",
          path: "observations",
          expected:
            "该 Spec 未定义逐对象的 observationTargets，不能确认覆盖完整；请记录 INCONCLUSIVE 并重新生成 Spec。",
        });
      for (const target of criterion.observationTargets ?? []) {
        if (
          !quotes.some((item) => {
            if (item.target !== target.label) return false;
            const networkQuote = networkQuotes.has(
              JSON.stringify([
                item.target,
                item.observationId,
                item.cursor,
                item.quote,
              ]),
            );
            if (networkQuote && accountRevisionStartedAt) {
              try {
                const request = JSON.parse(item.quote);
                if (
                  typeof request.timestamp !== "string" ||
                  !(
                    Date.parse(request.timestamp) >=
                    Date.parse(accountRevisionStartedAt)
                  )
                )
                  return false;
              } catch {
                return false;
              }
            }
            const needsNetwork =
              Boolean(target.network) ||
              networkQuote ||
              requiresStructuredNetworkTarget(target.label);
            const matched = [
              target.expectedText,
              ...(target.alternatives ?? []),
            ].some((text) =>
              needsNetwork
                ? networkQuote &&
                  (target.network
                    ? structuredNetworkMatches(item.quote, target.network)
                    : networkRequestMatches(item.quote, target.label, text))
                : observedValueMatches(item.quote, text),
            );
            return (
              matched &&
              observations?.hasDeliveredQuote(
                item.observationId,
                item.cursor,
                item.quote,
              )
            );
          })
        )
          issues.push({
            code: "QUOTE_NOT_EXACT",
            path: "observations",
            expected: `通过结论缺少已观察原文覆盖：${target.label}。需要确认「${target.expectedText}」。页面节点使用 citations；请求字段使用 page.network 的 networkCitations。手填 quote 必须是连续原文，不能拼接或改写。`,
          });
      }
    }
    const missing = missingRequiredEvidenceKinds(
      browserExecutionCriterion(criterion),
      result.evidenceRefs,
      evidence.values(),
    );
    if (missing.length)
      issues.push({
        code: "MISSING_EVIDENCE_KIND",
        path: "evidenceRefs",
        expected: `通过的验收标准缺少必需证据类型：${missing.join(", ")}。page.snapshot 同时保存 DOM 与截图；旧节点未返回 DOM 时，需采集 page.dom 并引用其真实证据。`,
      });
  }
  if (issues.length)
    return {
      error: toolCorrection(issues.map((issue) => issue.expected).join("\n"), {
        code: issues[0]!.code,
        criterionId: criterion.id,
        issues: issues.map(({ code, path, expected }) => ({
          path,
          expected: `${code}: ${expected}`,
        })),
        nextAction:
          "页面使用 citations: [{target, ref}]；网络使用 networkCitations: [{target, observationId, cursor, requestIndex}]，引用 page.network 已读取的请求（序号从 0 开始）。执行器会绑定真实原文及证据。核对所有缺失项后再提交；无法确认则记录 INCONCLUSIVE。",
      }),
    };
  return { result };
}
