import { createHash } from "node:crypto";
import {
  observationContractSchema,
  type ObservationContract,
} from "./observation-contract.js";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function observationDigest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
/** Allocate stable IDs at the API boundary, retaining the model's local references. */
export function freezeObservationContract(
  contract: ObservationContract,
  criterionId: string,
): ObservationContract {
  const keys = new Map(
    contract.targets.map((t, i) => [
      t.targetId,
      `target-${observationDigest([criterionId, i, t.label]).slice(0, 24)}`,
    ]),
  );
  return observationContractSchema.parse({
    ...contract,
    targets: contract.targets.map((t) => ({
      ...t,
      targetId: keys.get(t.targetId),
      assertions: t.assertions.map((a, i) => ({
        ...a,
        assertionId: `assertion-${i + 1}`,
      })),
    })),
    comparisons: contract.comparisons.map((c, i) => ({
      ...c,
      comparisonId: `comparison-${observationDigest([criterionId, i]).slice(0, 24)}`,
      subjectTargetId: keys.get(c.subjectTargetId),
      referenceTargetId: keys.get(c.referenceTargetId),
    })),
  });
}
