import type {
  ObservedNode,
  StructuredObservation,
} from "@devproof/runtime-protocol";
import type {
  ObservationBinding,
  ObservationContract,
  ObservationTargetV2,
  VisualComparisonReview,
} from "./observation-contract.js";

const normalize = (s: string) => s.replace(/\s+/gu, " ").trim();
const same = (a: string | undefined, b: string) =>
  a !== undefined && normalize(a) === normalize(b);
type Selection = {
  scopeRef: string;
  entityRef: string;
  assertionRefs: Record<string, string>;
};
export type BindingEvaluation = Omit<
  ObservationBinding,
  | "id"
  | "runId"
  | "attemptId"
  | "criterionId"
  | "contractDigest"
  | "observationId"
  | "captureId"
  | "sourceCommandId"
  | "capturedAt"
  | "evidenceRefs"
>;

/** The evaluator only resolves nodes already present in one canonical capture. */
export function evaluateObservationTarget(
  target: ObservationTargetV2,
  observation: StructuredObservation,
  evidenceKinds: readonly string[],
  selection?: Selection,
): { binding?: BindingEvaluation; error?: string; candidates?: string[] } {
  const nodes = observation.nodes;
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  function within(node: ObservedNode, root: ObservedNode) {
    if (
      node.frameId !== root.frameId ||
      node.documentEpoch !== root.documentEpoch
    )
      return false;
    let current: ObservedNode | undefined = node;
    const seen = new Set<string>();
    while (current && !seen.has(current.nodeId)) {
      if (current.nodeId === root.nodeId) return true;
      seen.add(current.nodeId);
      current = byId.get(current.parentId ?? "");
    }
    return false;
  }
  const directlyNamed = (node: ObservedNode | undefined, label: string) =>
    Boolean(
      node &&
      ((!node.truncatedProperties?.includes("NAME") &&
        same(node.name, label)) ||
        (!node.truncatedProperties?.includes("TEXT") &&
          same(node.text, label))),
    );
  const named = (node: ObservedNode, label: string) =>
    directlyNamed(node, label) ||
    node.relations.some(
      (r) =>
        r.kind === "LABELLED_BY" &&
        directlyNamed(byId.get(r.targetNodeId), label),
    );
  const isEntity = (n: ObservedNode) =>
    target.entity.controlKind === "SELECT"
      ? n.tag === "select" || n.role === "combobox"
      : target.entity.controlKind === "ROW"
        ? n.tag === "tr" || n.role === "row"
        : ["input", "textarea"].includes(n.tag) || n.role === "textbox";
  const entityValue = (n: ObservedNode) =>
    n.truncatedProperties?.includes(target.entity.property)
      ? undefined
      : target.entity.property === "SELECTED_LABEL"
        ? n.selectedLabelSource
          ? n.selectedLabel
          : undefined
        : target.entity.property === "VALUE"
          ? n.value
          : n.text;
  const entityCandidates = nodes.filter(
    (n) =>
      n.visible &&
      isEntity(n) &&
      named(n, target.entity.label) &&
      target.entity.oneOf.some((v) =>
        target.entity.property === "VALUE"
          ? entityValue(n) === v
          : same(entityValue(n), v),
      ),
  );
  const scopeKind = (n: ObservedNode) => {
    switch (target.scope.kind) {
      case "PAGE":
        return n.tag === "body";
      case "DIALOG":
        return (
          n.role === "dialog" || n.role === "alertdialog" || n.tag === "dialog"
        );
      case "FORM":
        return n.tag === "form" || n.role === "form";
      case "TABLE_ROW":
        return n.tag === "tr" || n.role === "row";
      case "POPOVER":
        return ["menu", "listbox", "tooltip"].includes(n.role ?? "");
    }
  };
  const hasTitle = (n: ObservedNode) =>
    target.scope.names.some(
      (label) =>
        named(n, label) ||
        nodes.some(
          (c) =>
            c.visible &&
            within(c, n) &&
            (/^h[1-6]$/u.test(c.tag) ||
              c.role === "heading" ||
              c.nameSource === "TITLE" ||
              c.text === label) &&
            named(c, label),
        ),
    );
  let scopes = nodes.filter((n) => n.visible && scopeKind(n) && hasTitle(n));
  if (
    !scopes.length &&
    ["DIALOG", "FORM", "POPOVER"].includes(target.scope.kind)
  ) {
    // Minimal titled container is a fallback for sites without accessibility roles.
    scopes = nodes.filter(
      (n) =>
        n.visible &&
        !["html", "body"].includes(n.tag) &&
        hasTitle(n) &&
        entityCandidates.some((e) => within(e, n)),
    );
    scopes = scopes.filter((n) => !scopes.some((c) => c !== n && within(c, n)));
  }
  if (selection) scopes = scopes.filter((n) => n.ref === selection.scopeRef);
  if (scopes.length !== 1)
    return {
      error: scopes.length ? "SCOPE_AMBIGUOUS" : "SCOPE_NOT_OBSERVED",
      candidates: scopes.flatMap((n) => (n.ref ? [n.ref] : [])),
    };
  const scope = scopes[0]!;
  const entities = entityCandidates.filter(
    (n) => within(n, scope) && (!selection || n.ref === selection.entityRef),
  );
  if (entities.length !== 1) return { error: "ENTITY_NOT_CONFIRMED" };
  const entity = entities[0]!;
  const facts: BindingEvaluation["facts"] = [];
  const reasons: string[] = [];
  for (const assertion of target.assertions) {
    const candidates = nodes.filter(
      (n) =>
        n.visible &&
        within(n, scope) &&
        named(n, assertion.subject.label) &&
        (assertion.subject.kind === "SWITCH"
          ? n.role === "switch" ||
            n.role === "checkbox" ||
            n.attributes.type === "checkbox"
          : assertion.subject.kind === "FIELD"
            ? ["input", "textarea", "select"].includes(n.tag) ||
              n.role === "textbox"
            : Boolean(n.ref)) &&
        (!selection ||
          n.ref === selection.assertionRefs[assertion.assertionId]),
    );
    if (candidates.length > 1)
      return {
        error: `STATE_AMBIGUOUS:${assertion.assertionId}`,
        candidates: candidates.flatMap((n) => (n.ref ? [n.ref] : [])),
      };
    if (candidates.length !== 1) {
      reasons.push(`STATE_UNREADABLE:${assertion.assertionId}`);
      continue;
    }
    const node = candidates[0]!;
    const actual =
      (assertion.property === "VALUE" || assertion.property === "TEXT") &&
      node.truncatedProperties?.includes(assertion.property)
        ? undefined
        : assertion.property === "CHECKED"
          ? node.checked
          : assertion.property === "VALUE"
            ? node.value
            : assertion.property === "TEXT"
              ? node.text
              : assertion.property === "VISIBLE"
                ? node.visible
                : node.enabled;
    const matched =
      typeof actual === "string"
        ? (Array.isArray(assertion.expected)
            ? assertion.expected
            : [assertion.expected]
          ).some(
            (v) =>
              typeof v === "string" &&
              (assertion.property === "VALUE" ? actual === v : same(actual, v)),
          )
        : actual === assertion.expected;
    facts.push({
      assertionId: assertion.assertionId,
      nodeId: node.nodeId,
      property: assertion.property,
      ...(actual !== undefined ? { actual } : {}),
      evaluation:
        actual === undefined ? "UNKNOWN" : matched ? "MATCHED" : "MISMATCHED",
    });
  }
  const region = observation.regions.find((r) => r.nodeId === scope.nodeId);
  const mutated = region?.modifiedNodeIds.some((id) => {
    const actionNode = byId.get(id);
    // An edited node may have been replaced or omitted from this capture. Its
    // disappearance does not prove that the current assertion was untouched.
    if (!actionNode) return true;
    return facts.some((f) => {
      const stateNode = byId.get(f.nodeId);
      return (
        id === f.nodeId ||
        Boolean(
          stateNode &&
          (within(stateNode, actionNode) || within(actionNode, stateNode)),
        )
      );
    });
  });
  const phaseProven =
    target.phase === "CURRENT" ||
    (target.phase === "AFTER_ACTION"
      ? Boolean(observation.sourceCommandId)
      : Boolean(
          region?.phaseProven &&
          !mutated &&
          (target.phase !== "REOPENED" || region.reopened),
        ));
  if (!phaseProven) reasons.push("PHASE_UNPROVEN");
  if (
    nodes.some(
      (n) =>
        n.visible &&
        within(n, scope) &&
        (n.attributes["aria-busy"] === "true" || n.role === "progressbar"),
    )
  )
    reasons.push("OBSERVATION_NOT_READY");
  if (
    !observation.coverage.completeWithinScope ||
    observation.coverage.truncated
  )
    reasons.push("OBSERVATION_SCOPE_INCOMPLETE");
  if (target.requiredEvidenceKinds.some((k) => !evidenceKinds.includes(k)))
    reasons.push("EVIDENCE_UNAVAILABLE");
  if (
    target.requiredEvidenceKinds.includes("SCREENSHOT") &&
    observation.consistency !== "VERIFIED"
  )
    reasons.push("OBSERVATION_DRIFTED");
  if (facts.some((f) => f.evaluation === "UNKNOWN"))
    reasons.push("STATE_UNREADABLE");
  const evaluation =
    facts.length !== target.assertions.length ||
    facts.some((f) => f.evaluation === "UNKNOWN")
      ? "UNKNOWN"
      : facts.some((f) => f.evaluation === "MISMATCHED")
        ? "MISMATCHED"
        : "MATCHED";
  return {
    binding: {
      targetId: target.targetId,
      scopeIdentity: scope.nodeId,
      entityKey: entityValue(entity)!,
      phase: target.phase,
      phaseProven,
      ...(region ? { regionEpoch: region.epoch } : {}),
      facts,
      evaluation,
      readiness: reasons.length ? "PARTIAL" : "READY",
      reasons,
    },
  };
}

export function observationCoverage(
  contract: ObservationContract,
  bindings: readonly ObservationBinding[],
) {
  return contract.targets.map((target) => {
    const facts = bindings.filter((b) => b.targetId === target.targetId);
    const ready = facts.filter((b) => b.readiness === "READY");
    const conflict = ready.some((a) =>
      ready.some(
        (b) =>
          a.entityKey === b.entityKey &&
          a.phase === b.phase &&
          a.evaluation !== b.evaluation,
      ),
    );
    return {
      targetId: target.targetId,
      label: target.label,
      readiness: conflict
        ? "CONFLICT"
        : ready.length
          ? "READY"
          : facts.length
            ? "PARTIAL"
            : "MISSING",
      evaluation: conflict
        ? "UNKNOWN"
        : (ready.at(-1)?.evaluation ?? "UNKNOWN"),
      bindingIds: [
        ...new Set(
          [
            ready[0]?.id,
            ready.at(-1)?.id,
            ...ready
              .filter((b) => b.evaluation === "MISMATCHED")
              .slice(0, 2)
              .map((b) => b.id),
            facts.at(-1)?.id,
          ].filter((id): id is string => Boolean(id)),
        ),
      ],
      reasons: [...new Set(facts.at(-1)?.reasons ?? [])],
    };
  });
}

export function boundCriterionError(input: {
  contract: ObservationContract;
  contractDigest: string;
  criterionId: string;
  status: string;
  bindingIds: readonly string[];
  comparisonReviewIds: readonly string[];
  bindings: readonly ObservationBinding[];
  reviews: readonly VisualComparisonReview[];
}) {
  const { contract, contractDigest, criterionId, status } = input;
  const own = input.bindings.filter(
    (b) => b.criterionId === criterionId && b.contractDigest === contractDigest,
  );
  const selected = own.filter((b) => input.bindingIds.includes(b.id));
  if (input.bindingIds.some((id) => !selected.some((b) => b.id === id)))
    return "BINDING_NOT_AVAILABLE: only this criterion's saved bindings may be used.";
  const superseded = new Set(
    input.reviews.flatMap((r) =>
      r.supersedesReviewId ? [r.supersedesReviewId] : [],
    ),
  );
  const activeReviews = input.reviews.filter(
    (r) =>
      r.criterionId === criterionId &&
      r.contractDigest === contractDigest &&
      !superseded.has(r.id),
  );
  const reviews = activeReviews.filter((r) =>
    input.comparisonReviewIds.includes(r.id),
  );
  if (input.comparisonReviewIds.some((id) => !reviews.some((r) => r.id === id)))
    return "COMPARISON_NOT_REVIEWED";
  if (status === "INCONCLUSIVE") return null;
  if (status === "FAILED")
    return selected.some(
      (b) => b.readiness === "READY" && b.evaluation === "MISMATCHED",
    ) || reviews.some((r) => r.verdict === "DIFFERENT")
      ? null
      : "COUNTEREXAMPLE_REQUIRED";
  const coverage = observationCoverage(contract, own);
  for (const target of contract.targets) {
    if (
      coverage.find((c) => c.targetId === target.targetId)?.readiness ===
      "CONFLICT"
    )
      return `BINDING_CONFLICT:${target.targetId}`;
    if (
      !selected.some(
        (b) =>
          b.targetId === target.targetId &&
          b.readiness === "READY" &&
          b.evaluation === "MATCHED",
      )
    )
      return `TARGET_NOT_CONFIRMED:${target.targetId}`;
  }
  for (const comparison of contract.comparisons) {
    // A fresh capture pair does not supersede an unresolved earlier judgment.
    if (
      activeReviews.some(
        (a) =>
          a.comparisonId === comparison.comparisonId &&
          activeReviews.some(
            (b) => b.comparisonId === a.comparisonId && a.verdict !== b.verdict,
          ),
      )
    )
      return `COMPARISON_REVIEW_CONFLICT:${comparison.comparisonId}`;
    const matching = reviews.filter(
      (r) => r.comparisonId === comparison.comparisonId,
    );
    if (!matching.length || matching.some((r) => r.verdict !== "EQUIVALENT"))
      return `COMPARISON_NOT_REVIEWED:${comparison.comparisonId}`;
    if (
      matching.some((r) =>
        r.bindingIds.some((id) => !selected.some((b) => b.id === id)),
      )
    )
      return `COMPARISON_BINDING_REQUIRED:${comparison.comparisonId}`;
  }
  return null;
}
