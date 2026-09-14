import { z } from "zod";
import {
  browserExecutionCriterion,
  missingRequiredEvidenceKinds,
  observedValueMatches,
  runtimeCriterionResultSchema,
  type RuntimeEvidenceRef,
  type RuntimeTaskLease,
} from "@devproof/agent-runtime-protocol";
import type { BrowserObservations } from "./browser-observation.js";
import {
  schemaCorrection,
  toolCorrection,
  type ToolCorrection,
} from "./tool-correction.js";

// Keep short, segment-local node references out of the durable result protocol.
export const criterionSubmissionSchema = runtimeCriterionResultSchema.extend({
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
):
  | { result: z.infer<typeof runtimeCriterionResultSchema>; error?: undefined }
  | { error: ToolCorrection } {
  const issues: {
    code: ToolCorrection["code"];
    path: string;
    expected: string;
  }[] = [];
  const quotes = [...(submitted.observations ?? [])];
  const refs = new Set(submitted.evidenceRefs);
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
  if (result.status !== "INCONCLUSIVE") {
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
      criterion.requireObservedEvidence ||
      criterion.observationTargets?.length
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
          !quotes.some(
            (item) =>
              item.target === target.label &&
              [target.expectedText, ...(target.alternatives ?? [])].some(
                (text) => observedValueMatches(item.quote, text),
              ) &&
              observations?.hasDeliveredQuote(
                item.observationId,
                item.cursor,
                item.quote,
              ),
          )
        )
          issues.push({
            code: "QUOTE_NOT_EXACT",
            path: "observations",
            expected: `通过结论缺少已观察原文覆盖：${target.label}。选择包含「${target.expectedText}」且属于验收区域的节点，通过 citations 提交；手填 quote 必须是连续原文，不能拼接或改写。`,
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
          "优先使用 citations: [{target: 验收对象 label, ref: 当前快照的完整 ref}]；执行器会填入原文、观察编号及同次采集的证据。核对所有缺失项后再提交；无法确认则记录 INCONCLUSIVE。",
      }),
    };
  return { result };
}
