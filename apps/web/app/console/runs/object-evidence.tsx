import {
  observationBindingSchema,
  observationCoverage,
  runtimeCriterionSchema,
  visualComparisonReviewSchema,
} from "@devproof/agent-runtime-protocol";

const readiness: Record<string, string> = {
  READY: "证据齐全",
  PARTIAL: "证据待补充",
  MISSING: "尚未观察",
  CONFLICT: "状态有冲突",
};
const evaluation: Record<string, string> = {
  MATCHED: "符合预期",
  MISMATCHED: "不符合预期",
  UNKNOWN: "尚不能确认",
};
const reason: Record<string, string> = {
  PHASE_UNPROVEN: "尚未证明默认状态",
  EVIDENCE_UNAVAILABLE: "证据未保存完整",
  OBSERVATION_DRIFTED: "截图期间状态发生变化",
  OBSERVATION_SCOPE_INCOMPLETE: "观察范围不完整",
  STATE_UNREADABLE: "尚未读到明确状态",
};

export function ObjectEvidence(props: {
  criterionId: string;
  criteria: unknown;
  rows: Array<{ id: string; facts: unknown }>;
  historyTruncated?: boolean | undefined;
  attemptId?: string | undefined;
  events?: Array<{ id: string; attemptId: string | null; payload: unknown }>;
  evidence: Array<{
    externalId: string;
    kind: string;
    downloadUrl: string | null;
  }>;
}) {
  const criteria = runtimeCriterionSchema.array().safeParse(props.criteria);
  const criterion = criteria.success
    ? criteria.data.find((c) => c.id === props.criterionId)
    : undefined;
  const contract = criterion?.observationContract;
  if (!contract) return null;
  const bindings = props.rows
    .flatMap((row) => {
      const parsed = observationBindingSchema.safeParse({
        ...(row.facts && typeof row.facts === "object" ? row.facts : {}),
        id: row.id,
      });
      return parsed.success &&
        parsed.data.criterionId === props.criterionId &&
        parsed.data.attemptId === props.attemptId
        ? [parsed.data]
        : [];
    })
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const reviews = (props.events ?? []).flatMap((event) => {
    const parsed = visualComparisonReviewSchema.safeParse({
      ...(event.payload && typeof event.payload === "object"
        ? event.payload
        : {}),
      id: event.id,
    });
    return parsed.success &&
      event.attemptId === props.attemptId &&
      parsed.data.criterionId === props.criterionId
      ? [parsed.data]
      : [];
  });
  return (
    <div className="my-3 space-y-3 text-sm" aria-label="对象验证证据">
      {props.historyTruncated && (
        <p role="status">
          仅展示最近 1000
          条观察或比较记录，以下覆盖情况可能不完整；最终验收使用完整历史。
        </p>
      )}
      {observationCoverage(contract, bindings).map((target) => {
        const selected = bindings.filter((b) =>
          target.bindingIds.includes(b.id),
        );
        const latest = selected.at(-1);
        const refs = new Set(selected.flatMap((b) => b.evidenceRefs));
        return (
          <section key={target.targetId} className="rounded-md border p-3">
            <b>{target.label}</b>
            <p>
              {readiness[target.readiness]} · {evaluation[target.evaluation]}
            </p>
            {latest?.facts.map((f) => (
              <p key={f.assertionId}>
                {
                  contract.targets
                    .find((t) => t.targetId === target.targetId)
                    ?.assertions.find((a) => a.assertionId === f.assertionId)
                    ?.subject.label
                }
                ：
                {f.actual === undefined
                  ? "未知"
                  : typeof f.actual === "boolean"
                    ? f.actual
                      ? "是"
                      : "否"
                    : f.actual}
              </p>
            ))}
            {target.reasons.length > 0 && (
              <p className="text-muted-foreground">
                {target.reasons
                  .map((r) => reason[r.split(":")[0]!] ?? "需要进一步观察")
                  .join("；")}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              {props.evidence
                .filter((e) => refs.has(e.externalId) && e.downloadUrl)
                .map((e, i) => (
                  <a
                    key={e.externalId}
                    href={e.downloadUrl!}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    {e.kind === "SCREENSHOT" ? "截图" : "页面证据"} {i + 1}
                  </a>
                ))}
            </div>
            <details className="mt-2 text-xs text-muted-foreground">
              <summary>诊断信息</summary>
              <pre className="overflow-auto whitespace-pre-wrap">
                {JSON.stringify(
                  { targetId: target.targetId, bindings: selected },
                  null,
                  2,
                )}
              </pre>
            </details>
          </section>
        );
      })}
      {contract.comparisons.map((comparison) => {
        const history = reviews.filter(
          (r) => r.comparisonId === comparison.comparisonId,
        );
        const superseded = new Set(history.map((r) => r.supersedesReviewId));
        const active = history.filter((r) => !superseded.has(r.id));
        const verdicts = new Set(active.map((r) => r.verdict));
        const review = active.at(-1);
        return (
          <section
            key={comparison.comparisonId}
            className="rounded-md border p-3"
          >
            <b>
              {
                contract.targets.find(
                  (t) => t.targetId === comparison.subjectTargetId,
                )?.label
              }{" "}
              /{" "}
              {
                contract.targets.find(
                  (t) => t.targetId === comparison.referenceTargetId,
                )?.label
              }
            </b>
            <p>
              {!review
                ? "尚未比较"
                : verdicts.size > 1
                  ? "比较结论有冲突"
                  : review.verdict === "EQUIVALENT"
                    ? "比较结果一致"
                    : review.verdict === "DIFFERENT"
                      ? "比较结果有差异"
                      : "比较结果尚不能确认"}{" "}
              · {comparison.dimensions.join("、")}
            </p>
            {review && (
              <>
                <p>{review.rationale}</p>
                <div className="grid grid-cols-2 gap-3">
                  {review.bindingIds.map((id) => {
                    const binding = bindings.find((b) => b.id === id);
                    const screenshot = props.evidence.find(
                      (e) =>
                        e.kind === "SCREENSHOT" &&
                        binding?.evidenceRefs.includes(e.externalId) &&
                        e.downloadUrl,
                    );
                    return (
                      screenshot && (
                        <a
                          key={id}
                          href={screenshot.downloadUrl!}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img
                            src={screenshot.downloadUrl!}
                            alt={
                              contract.targets.find(
                                (t) => t.targetId === binding?.targetId,
                              )?.label ?? "比较截图"
                            }
                            loading="lazy"
                            className="max-h-64 w-full object-contain"
                          />
                        </a>
                      )
                    );
                  })}
                </div>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
