import { z } from "zod";
import type { RuntimeEvidenceRef } from "@devproof/agent-runtime-protocol";
import type { BrowserObservations } from "./browser-observation.js";
import type { ExecutionJournal } from "./execution-journal.js";

export const DATA_PRECONDITION = "DATA_PRECONDITION";
const contextSchema = z
  .object({
    criterionIds: z.array(z.string().min(1)).min(1).max(100),
    records: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(500).optional(),
            account: z.string().trim().min(1).max(500),
            type: z.string().trim().min(1).max(500),
            evidenceRefs: z.array(z.string().min(1)).max(20).default([]),
            citations: z
              .array(z.object({ ref: z.string().min(1) }).strict())
              .max(20)
              .optional(),
            observations: z
              .array(
                z
                  .object({
                    observationId: z.string().uuid(),
                    cursor: z.number().int().nonnegative(),
                    quote: z.string().min(1).max(4000),
                  })
                  .strict(),
              )
              .max(6)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** Request scope is observed data. Permission comes only from the user's reply. */
export function prepareDataPrecondition(
  raw: unknown,
  policy: Record<string, unknown>,
  journal: ExecutionJournal | undefined,
  criterionIds: string[],
  evidence: ReadonlyMap<string, RuntimeEvidenceRef>,
  observations?: BrowserObservations,
) {
  const context = contextSchema.parse(raw);
  for (const id of context.criterionIds)
    if (!criterionIds.includes(id))
      throw new Error("数据处置必须关联当前验收标准。");
  for (const record of context.records) {
    const accounts = journal?.state.accounts ?? [];
    if (
      !accounts.some((a) =>
        [a.account, ...a.aliases].includes(record.account),
      ) &&
      journal?.state.account !== record.account
    )
      throw new Error("数据处置只能针对本任务已经提供的账号。");
    for (const citation of record.citations ?? []) {
      const resolved = observations?.citation(citation.ref);
      if (!resolved)
        throw new Error(
          `冲突记录引用不可用：${citation.ref}；请引用当前页面节点。`,
        );
      record.evidenceRefs.push(...resolved.evidenceRefs);
    }
    for (const quote of record.observations ?? []) {
      const refs = observations?.accountRequestEvidence(
        quote.observationId,
        quote.cursor,
        quote.quote,
      );
      if (!refs?.size) throw new Error("冲突记录必须引用已经读取的观察原文。");
      record.evidenceRefs.push(...refs.keys());
    }
    record.evidenceRefs = [...new Set(record.evidenceRefs)];
    const unknown = record.evidenceRefs.filter((ref) => !evidence.has(ref));
    if (unknown.length)
      throw new Error(
        `未知证据引用：${unknown.join("、")}。请使用 citations 或 observations 自动关联证据，不要手写 artifact ID。`,
      );
    if (
      !record.evidenceRefs.some((ref) =>
        ["DOM", "NETWORK"].includes(evidence.get(ref)!.kind),
      )
    )
      throw new Error(
        "冲突记录至少需要一份已观察的 DOM 或 NETWORK 证据；截图可作为补充。",
      );
    if (
      journal?.state.records.some(
        (r) =>
          (record.id
            ? r.id === record.id
            : [r.account, ...r.accountAliases].includes(record.account)) &&
          r.type === record.type &&
          r.ownership === "CREATED_THIS_RUN",
      )
    )
      throw new Error(
        "这是本次创建的记录，请继续验证及清理，不能重复请求数据处置。",
      );
  }
  const conflictKey = JSON.stringify(
    context.records
      .map((r) => [r.account, r.type, r.id ?? "UNIDENTIFIED"].join("|"))
      .sort(),
  );
  const history = Array.isArray(policy.humanResolutions)
    ? policy.humanResolutions
    : [];
  if (
    [...history, policy.resume].some((v) => {
      const resolution = object(v);
      return (
        resolution.kind === DATA_PRECONDITION &&
        object(resolution.context).conflictKey === conflictKey
      );
    })
  )
    throw new Error(
      "此组冲突已收到人工答复。按原处置意见重新核验并继续；无法执行时记录受影响项无法判定，不重复请求同一处置。",
    );
  return { ...context, conflictKey, reason: "DATA_PRECONDITION_CONFLICT" };
}
