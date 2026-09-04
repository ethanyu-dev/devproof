import { createHash } from "node:crypto";

const REPEATED_STEPS = 8;
const POLLING_GRACE_MS = 60_000;
const MAX_REPEATED_STEPS = 24;
const TEXT_ONLY_STEPS = 4;

const VOLATILE_KEYS = new Set([
  "commandId",
  "call_id",
  "sessionId",
  "artifactId",
  "artifacts",
  "evidenceRefs",
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "timestamp",
  "durationMs",
  "latencyMs",
  "deadlineAt",
  "fencingToken",
  "leaseToken",
  "locatorRecoveryToken",
  "timeoutSeconds",
  "timeoutMs",
  "ref",
  "nodeId",
  "backendNodeId",
  "byteSize",
  "dataBase64",
]);
const OBSERVATION_KEYS = new Set([
  "content",
  "text",
  "url",
  "title",
  "values",
  "value",
  "entries",
  "tabs",
  "activeTabId",
  "hit",
  "policies",
  "checked",
  "selected",
]);

/** Counts repeated work, not RPC ids, fresh screenshot ids, or prose rewrites. */
export class VerificationProgress {
  private readonly operations = new Set<string>();
  private readonly observations = new Set<string>();
  private readonly criteria = new Set<string>();
  private repeatedSteps = 0;
  private textOnlySteps = 0;
  private lastProgressAt: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.lastProgressAt = now();
  }

  textOnly() {
    this.textOnlySteps += 1;
    return this.textOnlySteps >= TEXT_ONLY_STEPS;
  }

  tool(input: {
    name: string;
    arguments: string;
    output: unknown;
    criteria: Array<{
      criterionId: string;
      status: string;
      evidenceKinds: string[];
    }>;
  }) {
    this.textOnlySteps = 0;
    let progress = false;
    for (const criterion of input.criteria) {
      const key = fingerprint(criterion);
      if (!this.criteria.has(key)) {
        this.criteria.add(key);
        progress = true;
      }
    }
    for (const observation of pageObservations(input.output)) {
      const key = fingerprint(observation);
      if (!this.observations.has(key)) {
        this.observations.add(key);
        progress = true;
      }
    }
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(input.arguments);
    } catch {
      argumentsValue = input.arguments;
    }
    const rejected =
      input.output !== null &&
      typeof input.output === "object" &&
      "accepted" in input.output &&
      input.output.accepted === false;
    const criterionId =
      argumentsValue !== null && typeof argumentsValue === "object"
        ? (argumentsValue as Record<string, unknown>).criterionId
        : undefined;
    const operation = fingerprint({
      name: input.name,
      // Rejected calls made no progress regardless of how their invalid
      // parameters were rewritten. Valid form actions retain their arguments.
      ...(rejected
        ? { rejected: true }
        : {
            arguments:
              input.name === "record_criterion"
                ? input.criteria.find(
                    (criterion) => criterion.criterionId === criterionId,
                  )
                : argumentsValue,
          }),
    });
    const repeated = this.operations.has(operation);
    this.operations.add(operation);
    if (progress) {
      this.repeatedSteps = 0;
      this.lastProgressAt = this.now();
    } else if (repeated) {
      this.repeatedSteps += 1;
    }
    // Give ordinary polling a minute to observe a change. A fast loop still
    // has a finite budget, and unique form actions do not consume this budget.
    return (
      this.repeatedSteps >= MAX_REPEATED_STEPS ||
      (this.repeatedSteps >= REPEATED_STEPS &&
        this.now() - this.lastProgressAt >= POLLING_GRACE_MS)
    );
  }
}

function pageObservations(output: unknown): unknown[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const record = output as Record<string, unknown>;
  const result = record.result;
  const observations: unknown[] = [];
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const content = Object.fromEntries(
      Object.entries(result).filter(([key]) => OBSERVATION_KEYS.has(key)),
    );
    if (Object.keys(content).length > 0) observations.push(content);
  }
  if (Array.isArray(record.artifacts)) {
    for (const artifact of record.artifacts) {
      if (
        artifact &&
        typeof artifact === "object" &&
        ["SCREENSHOT", "DOM_SNAPSHOT"].includes(artifact.kind) &&
        typeof artifact.sha256 === "string"
      ) {
        observations.push({
          kind: artifact.kind,
          contentHash: artifact.sha256,
        });
      }
    }
  }
  // Locator recovery can include the only fresh page observation in a step.
  const recovery = record.locatorRecovery;
  if (recovery && typeof recovery === "object") {
    observations.push(
      ...pageObservations((recovery as Record<string, unknown>).snapshot),
    );
  }
  return observations;
}

function fingerprint(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function stable(value: unknown): unknown {
  if (typeof value === "string")
    return value.replace(/\s*\[ref=(?:f\d+)?e\d+\]/gu, "");
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}
