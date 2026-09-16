import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { PrismaService } from "../apps/api/dist/database/prisma.service.js";
import { ObservationBindingService } from "../apps/api/dist/agent-runtime/observation-binding.service.js";
import { runtimeTaskSnapshotSchema } from "../packages/agent-runtime-protocol/dist/index.js";
const db = new PrismaService();
const marker = randomUUID();
const rollback = new Error("FIXTURE_ROLLBACK");
try {
  await db.$transaction(
    async (tx) => {
      const team = await tx.team.findFirstOrThrow({ select: { id: true } });
      const runId = randomUUID(),
        attemptId = randomUUID(),
        taskId = randomUUID(),
        captureId = randomUUID(),
        commandId = randomUUID(),
        artifactId = randomUUID();
      const deadline = new Date(Date.now() + 60_000);
      const contract = {
        version: 2,
        targets: [
          {
            targetId: "type",
            label: "Mapping default",
            scope: { kind: "DIALOG", names: ["New"] },
            entity: {
              controlKind: "SELECT",
              label: "Type",
              property: "SELECTED_LABEL",
              oneOf: ["Mapping"],
            },
            phase: "INITIAL_AFTER_OPEN",
            assertions: [
              {
                assertionId: "enabled",
                subject: { kind: "SWITCH", label: "Enabled" },
                property: "CHECKED",
                operator: "EQ",
                expected: true,
              },
            ],
            requiredEvidenceKinds: ["DOM"],
            temporal: "SAME_OBSERVATION",
          },
        ],
        comparisons: [],
      };
      const snapshot = runtimeTaskSnapshotSchema.parse({
        runId,
        attemptId,
        attemptNumber: 1,
        teamId: team.id,
        traceId: "f".repeat(32),
        deadlineAt: deadline.toISOString(),
        goal: "Isolated database rollback fixture",
        criteria: [
          {
            id: "defaults",
            description: "Default enabled",
            requiredEvidenceKinds: ["DOM"],
            observationContract: contract,
          },
        ],
      });
      await tx.executionRun.create({
        data: {
          id: runId,
          teamId: team.id,
          idempotencyKey: marker,
          goal: "Fixture rollback",
          criteriaSnapshot: snapshot.criteria,
          lifecycle: "RUNNING",
          traceId: "f".repeat(32),
          initialDeadlineAt: deadline,
          deadlineAt: deadline,
          hardDeadlineAt: deadline,
        },
      });
      await tx.runAttempt.create({
        data: {
          id: attemptId,
          runId,
          number: 1,
          status: "RUNNING",
          inputSnapshot: snapshot,
        },
      });
      const task = await tx.agentRuntimeTask.create({
        data: {
          id: taskId,
          runId,
          attemptId,
          capability: "BROWSER_VERIFICATION",
          snapshot,
          status: "RUNNING",
          leaseToken: randomUUID(),
          leaseOwner: "database-fixture",
          fencingToken: 1n,
          leaseExpiresAt: deadline,
          deadlineAt: deadline,
        },
      });
      const node = (nodeId, extra) => ({
        nodeId,
        frameId: "frame",
        documentEpoch: "doc",
        tag: "div",
        visible: true,
        attributes: {},
        relations: [],
        textLocation: { start: 0, end: 0 },
        ...extra,
      });
      const observation = {
        version: 2,
        captureId,
        capturedFrom: new Date().toISOString(),
        capturedUntil: new Date().toISOString(),
        pageIdentity: "fixture",
        frames: [{ frameId: "frame", documentEpoch: "doc" }],
        nodes: [
          node("dialog", { role: "dialog", name: "New" }),
          node("type", {
            parentId: "dialog",
            tag: "select",
            name: "Type",
            selectedLabel: "Mapping",
            selectedLabelSource: "NATIVE_SELECT",
          }),
          node("switch", {
            parentId: "dialog",
            role: "switch",
            name: "Enabled",
            checked: true,
          }),
        ],
        renderedText: "",
        regions: [
          {
            nodeId: "dialog",
            epoch: "open-1",
            phaseProven: true,
            reopened: false,
            modifiedNodeIds: [],
          },
        ],
        consistency: "DOM_ONLY",
        coverage: {
          scope: "VIEWPORT",
          completeWithinScope: true,
          truncated: false,
          unavailableFrames: [],
        },
      };
      const body = Buffer.from(JSON.stringify(observation));
      const adapter = new Proxy(tx, {
        get: (object, key) =>
          key === "$transaction" ? (fn) => fn(tx) : Reflect.get(object, key),
      });
      const service = new ObservationBindingService(adapter, {
        get: async () => ({ body }),
      });
      const command = {
        id: commandId,
        status: "SUCCEEDED",
        artifacts: [
          {
            id: artifactId,
            kind: "DOM",
            metadata: { captureId, observationSchemaVersion: 2 },
            contentType: "application/json",
            storageKey: "fixture",
            byteSize: body.length,
            sha256: createHash("sha256").update(body).digest("hex"),
          },
        ],
      };
      const first = await service.capture(task, command),
        second = await service.capture(task, command);
      assert.equal(first.bindings[0].id, second.bindings[0].id);
      assert.equal(
        await tx.runObservationBinding.count({ where: { runId } }),
        1,
      );
      await service.validateReferences(task, [first.bindings[0].id], []);
      await assert.rejects(
        service.validateReferences(
          { ...task, attemptId: randomUUID() },
          [first.bindings[0].id],
          [],
        ),
        /CHECKPOINT_BINDING_NOT_AVAILABLE/,
      );
      await tx.agentRuntimeTask.update({
        where: { id: task.id },
        data: { fencingToken: 2n },
      });
      await assert.rejects(
        service.capture(task, command),
        /RUNTIME_LEASE_LOST/,
      );
      throw rollback;
    },
    { timeout: 30_000 },
  );
} catch (error) {
  if (error !== rollback) throw error;
} finally {
  const remaining = await db.executionRun.count({
    where: { idempotencyKey: marker },
  });
  assert.equal(remaining, 0);
  await db.$disconnect();
}
console.log(
  JSON.stringify({
    status: "PASSED",
    checks: [
      "actual PostgreSQL binding insert/read",
      "immutable uniqueness",
      "cross-attempt checkpoint rejected",
      "lost lease rejected",
      "transaction rollback confirmed",
    ],
  }),
);
