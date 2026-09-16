import { z } from "zod";
import {
  visualObservationSchema,
  type VisualObservation,
} from "@devproof/runtime-protocol";
import {
  boundCriterionError,
  observationBindingSchema,
  observationCoverage,
  visualComparisonReviewSchema,
  type ObservationBinding,
  type ObservationContract,
  type VisualComparisonReview,
} from "@devproof/agent-runtime-protocol";
import { observationDigest } from "@devproof/agent-runtime-protocol/observation-digest";

export const referenceImageSchema = visualObservationSchema.extend({
  bindingId: z.string().uuid(),
  purpose: z.literal("REFERENCE_EVIDENCE"),
});
export type ReferenceImage = z.infer<typeof referenceImageSchema>;
const envelopeSchema = z.object({
  bindings: z.array(observationBindingSchema).default([]),
});
const diagnosticSchema = z.object({
  criterionId: z.string(),
  targetId: z.string(),
  observationId: z.string().uuid(),
  error: z.string().max(100),
});

/** Durable facts are distinct from current, actionable DOM references. */
export class BoundEvidence {
  private readonly bindings = new Map<string, ObservationBinding>();
  private readonly reviews = new Map<string, VisualComparisonReview>();
  private readonly delivered = new Set<string>();
  private readonly diagnostics = new Map<
    string,
    z.infer<typeof diagnosticSchema>
  >();
  private imageRead:
    { deliveryId: string; images: ReferenceImage[] } | undefined;
  private currentImageDelivered = false;
  constructor(
    readonly criteria: readonly {
      id: string;
      observationContract?: ObservationContract | undefined;
    }[],
    readonly runId: string,
    readonly attemptId: string,
  ) {}
  get enabled() {
    return this.criteria.some((c) => c.observationContract);
  }
  ingest(value: unknown) {
    const parsed = envelopeSchema.safeParse(value);
    if (!parsed.success) return;
    if (
      value &&
      typeof value === "object" &&
      "coverage" in value &&
      Array.isArray(value.coverage)
    ) {
      for (const item of value.coverage.slice(0, 200)) {
        const diagnostic = diagnosticSchema.safeParse(item);
        if (!diagnostic.success) continue;
        const data = diagnostic.data;
        if (
          this.criteria.some(
            (c) =>
              c.id === data.criterionId &&
              c.observationContract?.targets.some(
                (t) => t.targetId === data.targetId,
              ),
          )
        )
          this.diagnostics.set(`${data.criterionId}:${data.targetId}`, data);
      }
    }
    for (const binding of parsed.data.bindings) {
      const criterion = this.criteria.find((c) => c.id === binding.criterionId);
      if (
        binding.runId === this.runId &&
        binding.attemptId === this.attemptId &&
        criterion?.observationContract &&
        binding.contractDigest ===
          observationDigest(criterion.observationContract)
      )
        this.bindings.set(binding.id, binding);
    }
    const reviews =
      value && typeof value === "object" && "reviews" in value
        ? value.reviews
        : undefined;
    if (Array.isArray(reviews))
      for (const item of reviews) {
        const review = visualComparisonReviewSchema.safeParse(item);
        const contract = review.success
          ? this.criteria.find((c) => c.id === review.data.criterionId)
              ?.observationContract
          : undefined;
        if (
          review.success &&
          contract &&
          review.data.contractDigest === observationDigest(contract)
        )
          this.reviews.set(review.data.id, review.data);
      }
  }
  imageResponse(value: unknown) {
    this.imageRead = z
      .object({
        deliveryId: z.string().uuid(),
        images: z.array(referenceImageSchema).min(1).max(2),
      })
      .parse(value);
    this.currentImageDelivered = false;
    return {
      deliveryId: this.imageRead.deliveryId,
      images: this.imageRead.images.map(
        ({ dataBase64: _data, ...metadata }) => metadata,
      ),
      nextAction:
        "Images will be attached to the next model request. Compare the declared dimensions and call record_visual_comparison.",
    };
  }
  review(value: unknown) {
    const review = visualComparisonReviewSchema.parse(value);
    this.reviews.set(review.id, review);
    return review;
  }
  referenceImages() {
    return this.imageRead?.images;
  }
  clearImages() {
    this.imageRead = undefined;
  }
  canUseCurrentImage() {
    return !this.enabled || this.currentImageDelivered;
  }
  ids() {
    return [
      ...new Set(
        this.criteria.flatMap((c) =>
          c.observationContract
            ? observationCoverage(
                c.observationContract,
                [...this.bindings.values()].filter(
                  (b) => b.criterionId === c.id,
                ),
              ).flatMap((t) => t.bindingIds)
            : [],
        ),
      ),
    ];
  }
  reviewIds() {
    return [...this.reviews.keys()];
  }
  hasDelivered(ids: readonly string[]) {
    return ids.every((id) => this.delivered.has(id) && this.bindings.has(id));
  }
  get(id: string) {
    return this.bindings.get(id);
  }

  view(maxBytes = 12 * 1024) {
    const coverage = this.criteria
      .filter((c) => c.observationContract)
      .flatMap((c) =>
        observationCoverage(
          c.observationContract!,
          [...this.bindings.values()].filter((b) => b.criterionId === c.id),
        ).map((t) => {
          const last = this.diagnostics.get(`${c.id}:${t.targetId}`);
          const target = c.observationContract!.targets.find(
            (target) => target.targetId === t.targetId,
          )!;
          return {
            criterionId: c.id,
            ...t,
            ...(t.readiness === "MISSING" && last
              ? {
                  lastObservation: {
                    observationId: last.observationId,
                    error: last.error,
                  },
                  nextAction:
                    last.error === "SCOPE_NOT_OBSERVED"
                      ? `尚未观察到区域 ${target.scope.names.join(" / ")}；先进入该区域。当前筛选或背景列表不能证明该区域的状态。`
                      : last.error === "SCOPE_AMBIGUOUS"
                        ? "存在多个候选区域，需根据当前观察确认唯一目标区域。"
                        : "核对目标对象的实际选中值、阶段和控件关系；保留名称或状态差异，不重复搜索已观察到的选项。",
                }
              : {}),
          };
        }),
      );
    const selected: ObservationBinding[] = [];
    const ids = new Set(coverage.flatMap((c) => c.bindingIds));
    for (const binding of this.bindings.values()) {
      if (
        ids.has(binding.id) &&
        Buffer.byteLength(JSON.stringify(selected)) +
          Buffer.byteLength(JSON.stringify(binding)) <=
          8 * 1024
      )
        selected.push(binding);
    }
    const visibleCoverage = [];
    for (const row of coverage) {
      if (
        Buffer.byteLength(JSON.stringify([...visibleCoverage, row])) >
        4 * 1024
      )
        break;
      visibleCoverage.push(row);
    }
    const comparisons = this.criteria.flatMap(
      (c) =>
        c.observationContract?.comparisons.map((requirement) => ({
          criterionId: c.id,
          ...requirement,
          reviews: [...this.reviews.values()].filter(
            (r) => r.comparisonId === requirement.comparisonId,
          ),
        })) ?? [],
    );
    const view = {
      coverage: visibleCoverage,
      bindings: selected,
      comparisons,
      omittedBindings: this.bindings.size - selected.length,
      omittedTargets: coverage.length - visibleCoverage.length,
      nextAction:
        coverage.length && coverage.every((c) => c.readiness === "READY")
          ? "REVIEW: compare required images, then submit bindingIds and comparisonReviewIds."
          : "Observe the missing object, region, phase or state. Repeating the same selected type does not add coverage.",
      guidance:
        "Historical bindings are evidence, never current click references. read_observation_bindings can retrieve omitted facts.",
    };
    while (
      Buffer.byteLength(JSON.stringify(view)) > maxBytes &&
      view.comparisons.length
    )
      view.comparisons.pop();
    return view;
  }
  /** Called only after a model request completed; budget-discarded views never count. */
  deliveredRequest(
    messages: unknown[],
    currentImage: VisualObservation | undefined,
  ) {
    const text = JSON.stringify(messages);
    const found = new Set<string>();
    const inspect = (value: unknown, depth = 0) => {
      if (depth > 30 || !value) return;
      if (typeof value === "string") {
        if (value.startsWith("{") || value.startsWith("["))
          try {
            inspect(JSON.parse(value), depth + 1);
          } catch {}
        return;
      }
      if (typeof value !== "object") return;
      if (
        "id" in value &&
        typeof value.id === "string" &&
        this.bindings.has(value.id)
      ) {
        const parsed = observationBindingSchema.safeParse(value);
        if (
          parsed.success &&
          observationDigest(parsed.data) ===
            observationDigest(this.bindings.get(value.id))
        )
          found.add(value.id);
      }
      for (const child of Object.values(value)) inspect(child, depth + 1);
    };
    inspect(messages);
    const bindingIds = [...found];
    bindingIds.forEach((id) => this.delivered.add(id));
    const imageDeliveryId =
      this.imageRead &&
      this.imageRead.images.every((image) => text.includes(image.dataBase64))
        ? this.imageRead.deliveryId
        : undefined;
    this.currentImageDelivered = Boolean(
      currentImage &&
      !imageDeliveryId &&
      text.includes(currentImage.dataBase64),
    );
    return { bindingIds, ...(imageDeliveryId ? { imageDeliveryId } : {}) };
  }
  resolve(
    criterionId: string,
    status: string,
    bindingIds: string[],
    comparisonReviewIds: string[],
  ) {
    const criterion = this.criteria.find((c) => c.id === criterionId);
    if (!criterion?.observationContract)
      return { evidenceRefs: [] as string[] };
    if (!this.hasDelivered(bindingIds))
      return {
        error:
          "BINDING_NOT_DELIVERED: read the saved bindings before submitting.",
      };
    const error = boundCriterionError({
      contract: criterion.observationContract,
      contractDigest: observationDigest(criterion.observationContract),
      criterionId,
      status,
      bindingIds,
      comparisonReviewIds,
      bindings: [...this.bindings.values()],
      reviews: [...this.reviews.values()],
    });
    return error
      ? { error }
      : {
          evidenceRefs: [
            ...new Set(
              bindingIds.flatMap(
                (id) => this.bindings.get(id)?.evidenceRefs ?? [],
              ),
            ),
          ],
        };
  }
}
