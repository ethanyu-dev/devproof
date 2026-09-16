import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  caseAccountRequirements,
  testAccountSlots,
  testAccountBindingsSchema,
  type TestAccountPlan,
} from "@devproof/agent-runtime-protocol";
import {
  taskExecutionCreateInputSchema,
  type TaskTestAccountsInput,
} from "@devproof/contracts";
import { specificationDefinitionHash } from "@devproof/test-domain";
import {
  readAccountPlan,
  resolveCaseExecutionDefinition,
} from "./case-account-definition.js";
export {
  readAccountPlan,
  resolveCaseExecutionDefinition,
} from "./case-account-definition.js";
import type { PrismaService } from "../database/prisma.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { refreshedTaskDeadline } from "./task-deadline.js";

const json = (value: unknown) => value as Prisma.InputJsonValue;
const terminal = ["COMPLETED", "CANCELLED", "TIMED_OUT"];

/** A new plan can retain corrected requirements, but never previous assignments. */
export function unassignedTestAccountPlan(
  definition: unknown,
  timeoutSeconds: number,
  now: Date,
  previousValue?: unknown,
): TestAccountPlan {
  const previous = readAccountPlan(previousValue);
  if (previous) resolveCaseExecutionDefinition(definition, previous);
  return {
    version: 2,
    definitionHash: specificationDefinitionHash(definition),
    effectiveAuthRole: String(
      (definition as Record<string, unknown>).authRole ?? "default",
    ),
    resolution: {
      kind: "DECLARED",
      removedRoles: [],
      reason: "按当前用例准备业务测试对象。",
    },
    requirements: caseAccountRequirements(definition),
    ...(previous?.version === 2 ? previous : {}),
    revision: randomUUID(),
    bindings: [],
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + timeoutSeconds * 1000).toISOString(),
  };
}
export function missingAccountSlots(plan: TestAccountPlan) {
  return testAccountSlots(plan.requirements).filter(
    (slot) => !plan.bindings.some((binding) => binding.slotId === slot.slotId),
  );
}
export function accountsReady(value: unknown, definition: unknown) {
  resolveCaseExecutionDefinition(definition, value);
  const plan = readAccountPlan(value);
  return plan
    ? missingAccountSlots(plan).length === 0
    : caseAccountRequirements(definition).length === 0;
}

/** Runs are created only after preparation. Zero-account cases do not wait. */
export async function prepareTestAccountPlans(
  db: PrismaService,
  taskExecutionId?: string,
) {
  const rows = await db.taskCaseExecution.findMany({
    where: {
      ...(taskExecutionId ? { taskExecutionId } : {}),
      runId: null,
      testAccountPlan: { equals: Prisma.DbNull },
      dispatchStatus: "PENDING",
      taskExecution: {
        cancelRequestedAt: null,
        lifecycle: { notIn: terminal as never },
      },
    },
    include: {
      testCase: true,
      deployment: true,
      taskExecution: { select: { inputSnapshot: true, teamId: true } },
    },
    take: 500,
  });
  for (const row of rows) {
    const now = new Date();
    const policy = taskExecutionCreateInputSchema.parse(
      row.taskExecution.inputSnapshot,
    );
    const hitl =
      policy.kind === "ISSUE_SPEC" ? policy.hitlPolicy : policy.run.hitlPolicy;
    let plan = unassignedTestAccountPlan(
      row.testCase.definition,
      hitl.timeoutSeconds,
      now,
    );
    await db.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(
        tx,
        `task-test-accounts:${row.taskExecutionId}`,
      );
      // Reuse the user's assignment for the same role on retry. The Agent
      // verifies current business preconditions; historical runs do not reserve accounts.
      const previous = await tx.taskCaseExecution.findFirst({
        where: {
          taskExecutionId: row.taskExecutionId,
          caseId: row.caseId,
          deploymentId: row.deploymentId,
          executionOrdinal: { lt: row.executionOrdinal },
        },
        orderBy: { executionOrdinal: "desc" },
        include: { run: true },
      });
      if (previous) {
        const previousPlan = readAccountPlan(previous.testAccountPlan);
        if (previousPlan?.version === 2) {
          resolveCaseExecutionDefinition(row.testCase.definition, previousPlan);
          plan = {
            ...previousPlan,
            revision: plan.revision,
            requestedAt: plan.requestedAt,
            expiresAt: plan.expiresAt,
            bindings: [],
          };
        }
        const policy = previous.run?.executionPolicy as
          Record<string, unknown> | undefined;
        const bindings = testAccountBindingsSchema.parse(
          policy?.testAccounts ??
            readAccountPlan(previous.testAccountPlan)?.bindings ??
            [],
        );
        for (const slot of testAccountSlots(plan.requirements)) {
          const oldRequirement = previousPlan?.requirements.find(
            (r) => r.role === slot.role,
          );
          const newRequirement = plan.requirements.find(
            (r) => r.role === slot.role,
          );
          if (
            !oldRequirement ||
            specificationDefinitionHash(oldRequirement) !==
              specificationDefinitionHash(newRequirement)
          )
            continue;
          const binding = bindings.find(
            (b) =>
              b.slotId === slot.slotId &&
              b.usage === slot.usage &&
              specificationDefinitionHash(b.requiredTypes) ===
                specificationDefinitionHash(slot.requiredTypes),
          );
          if (!binding) continue;
          plan.bindings.push(binding);
        }
      }
      const missing = missingAccountSlots(plan).length;
      await tx.taskCaseExecution.updateMany({
        where: {
          id: row.id,
          runId: null,
          dispatchStatus: "PENDING",
          updatedAt: row.updatedAt,
          testAccountPlan: { equals: Prisma.DbNull },
        },
        data: {
          testAccountPlan: json(plan),
          ...(missing && !hitl.enabled
            ? { dispatchStatus: "FAILED", dispatchAttempts: 3 }
            : {}),
          ...(missing
            ? {
                scheduling: json({
                  state: hitl.enabled ? "WAITING" : "TERMINAL",
                  reason: hitl.enabled
                    ? "TEST_ACCOUNTS_REQUIRED"
                    : "TEST_ACCOUNTS_HITL_DISABLED",
                  waitingSince: now.toISOString(),
                  evaluatedAt: now.toISOString(),
                  blockedBy: { resourceType: "TEST_ACCOUNT" },
                  queue: null,
                  nextRetryAt: null,
                }),
              }
            : {}),
        },
      });
    });
  }
}

export async function expireTestAccountPlans(
  db: PrismaService,
  taskExecutionId?: string,
) {
  const now = new Date();
  const rows = await db.taskCaseExecution.findMany({
    where: {
      ...(taskExecutionId ? { taskExecutionId } : {}),
      runId: null,
      dispatchStatus: "PENDING",
      testAccountPlan: { not: Prisma.DbNull },
      scheduling: { path: ["reason"], equals: "TEST_ACCOUNTS_REQUIRED" },
    },
    take: 500,
  });
  for (const row of rows) {
    const plan = readAccountPlan(row.testAccountPlan);
    if (
      !plan?.expiresAt ||
      new Date(plan.expiresAt) > now ||
      !missingAccountSlots(plan).length
    )
      continue;
    await db.taskCaseExecution.updateMany({
      where: {
        id: row.id,
        runId: null,
        dispatchStatus: "PENDING",
        updatedAt: row.updatedAt,
      },
      data: {
        dispatchStatus: "FAILED",
        dispatchAttempts: 3,
        scheduling: json({
          state: "TERMINAL",
          reason: "TEST_ACCOUNTS_TIMEOUT",
          evaluatedAt: now.toISOString(),
          waitingSince: null,
          blockedBy: null,
          queue: null,
          nextRetryAt: null,
        }),
      },
    });
  }
}

type AccountRow = {
  id: string;
  caseId: string;
  executionOrdinal: number;
  runId: string | null;
  run?: { executionPolicy: unknown } | null;
  testAccountPlan?: unknown;
  dispatchStatus?: string;
  deployment: {
    id: string;
    name: string;
    targetUrl: string;
    enabled?: boolean;
  };
  testCase: { name: string; snapshotId: string; definition?: unknown };
};
export function taskAccountPreparation(
  rows: readonly AccountRow[],
  snapshotId?: string,
) {
  const latest = rows
    .filter(
      (row) =>
        row.deployment.enabled !== false &&
        (!snapshotId || row.testCase.snapshotId === snapshotId),
    )
    .filter(
      (row) =>
        !rows.some(
          (other) =>
            other.caseId === row.caseId &&
            other.deployment.id === row.deployment.id &&
            other.executionOrdinal > row.executionOrdinal,
        ),
    );
  const cases = latest.flatMap((row) => {
    const plan = readAccountPlan(row.testAccountPlan);
    if (!plan) return [];
    if (row.testCase.definition)
      resolveCaseExecutionDefinition(row.testCase.definition, plan);
    const runPolicy = row.run?.executionPolicy as
      Record<string, unknown> | undefined;
    const bindings =
      runPolicy?.testAccounts === undefined
        ? plan.bindings
        : testAccountBindingsSchema.parse(runPolicy.testAccounts);
    return [
      {
        caseExecutionId: row.id,
        caseName: row.testCase.name,
        deployment: row.deployment,
        revision: plan.revision,
        started:
          Boolean(row.runId) ||
          ["CANCELLED", "FAILED"].includes(row.dispatchStatus ?? ""),
        slots: testAccountSlots(plan.requirements).map((slot) => ({
          ...slot,
          account:
            bindings.find((b) => b.slotId === slot.slotId)?.account ?? null,
        })),
      },
    ];
  });
  return {
    revision: createHash("sha256")
      .update(
        JSON.stringify(
          cases
            .map((c) => [c.caseExecutionId, c.revision, c.deployment.targetUrl])
            .sort(),
        ),
      )
      .digest("hex"),
    missingCount: cases.reduce(
      (count, c) =>
        count +
        (c.started ? 0 : c.slots.filter((slot) => !slot.account).length),
      0,
    ),
    totalCount: cases.reduce((count, c) => count + c.slots.length, 0),
    cases,
  };
}
export type TaskAccountPreparation = ReturnType<typeof taskAccountPreparation>;

export async function provideTaskTestAccounts(
  db: PrismaService,
  teamId: string,
  taskId: string,
  input: TaskTestAccountsInput,
) {
  return db.$transaction(async (tx) => {
    // Serialize edits and duplicate submissions to this task's assignment form.
    // This is not an account reservation and never blocks another task's accounts.
    await acquireAdvisoryTransactionLock(tx, `task-test-accounts:${taskId}`);
    const task = await tx.taskExecution.findFirst({
      where: { id: taskId, teamId },
      include: {
        specificationSnapshots: { orderBy: { generatedAt: "desc" }, take: 1 },
        caseExecutions: { include: { testCase: true, deployment: true } },
      },
    });
    if (!task) throw new NotFoundException("Task not found.");
    const digest = createHash("sha256")
      .update(JSON.stringify(input.assignments))
      .digest("hex");
    const duplicate = await tx.taskExecutionEvent.findFirst({
      where: {
        taskExecutionId: taskId,
        kind: "task.accounts.assigned",
        payload: { path: ["submissionId"], equals: input.submissionId },
      },
    });
    if (duplicate) {
      if ((duplicate.payload as Record<string, unknown>).digest !== digest)
        throw new ConflictException("同一提交编号不能用于不同的账号分配。");
      return;
    }
    if (task.cancelRequestedAt || terminal.includes(task.lifecycle))
      throw new ConflictException("任务已结束，不能再分配账号。");
    const preparation = taskAccountPreparation(
      task.caseExecutions,
      task.specificationSnapshots[0]?.id,
    );
    if (preparation.revision !== input.expectedRevision)
      throw new ConflictException(
        "Spec、环境或执行批次已变化，请刷新账号需求后再提交。",
      );
    const updates = new Map<string, TestAccountPlan>();
    const seen = new Set<string>();
    for (const assignment of input.assignments) {
      const key = `${assignment.caseExecutionId}:${assignment.slotId}`;
      if (seen.has(key))
        throw new BadRequestException("同一账号角色不能重复提交。");
      seen.add(key);
      const current = preparation.cases.find(
        (c) => c.caseExecutionId === assignment.caseExecutionId,
      );
      const row = task.caseExecutions.find(
        (c) => c.id === assignment.caseExecutionId,
      );
      if (!current || !row)
        throw new ConflictException("账号分配不属于当前 Spec 或执行环境。");
      const slot = current.slots.find((s) => s.slotId === assignment.slotId);
      if (!slot) throw new BadRequestException("未知测试账号角色。");
      if (slot.account === assignment.account) continue;
      if (row.runId || row.dispatchStatus !== "PENDING")
        throw new ConflictException(
          "Case 已开始调度，当前分配不能修改；请在重试 Case 时调整账号。",
        );
      const plan = updates.get(row.id) ?? readAccountPlan(row.testAccountPlan)!;
      if (plan.expiresAt && new Date(plan.expiresAt) <= new Date())
        throw new ConflictException("账号准备已过期，请重试 Case 后重新分配。");
      const binding = {
        slotId: slot.slotId,
        label: slot.label,
        account: assignment.account,
        aliases: [],
        usage: slot.usage,
        requiredTypes: slot.requiredTypes,
      };
      plan.bindings = [
        ...plan.bindings.filter((b) => b.slotId !== slot.slotId),
        binding,
      ];
      updates.set(row.id, plan);
    }
    // Persist the user's role assignments atomically, without account exclusivity.
    for (const [id, plan] of updates) {
      const row = task.caseExecutions.find((c) => c.id === id)!;
      const updated = await tx.taskCaseExecution.updateMany({
        where: {
          id,
          runId: null,
          dispatchStatus: "PENDING",
          updatedAt: row.updatedAt,
        },
        data: {
          testAccountPlan: json(plan),
          scheduling: json({
            state: missingAccountSlots(plan).length ? "WAITING" : "READY",
            reason: missingAccountSlots(plan).length
              ? "TEST_ACCOUNTS_REQUIRED"
              : null,
            waitingSince: missingAccountSlots(plan).length
              ? plan.requestedAt
              : null,
            evaluatedAt: new Date().toISOString(),
            blockedBy: null,
            queue: null,
            nextRetryAt: null,
          }),
        },
      });
      if (updated.count !== 1)
        throw new ConflictException("Case 调度状态已变化，请刷新后重试。");
    }
    if (updates.size)
      await tx.taskExecution.update({
        where: { id: taskId },
        data: {
          deadlineAt: refreshedTaskDeadline(task.inputSnapshot, new Date()),
          projectionNeededAt: new Date(),
        },
      });
    await tx.taskExecutionEvent.create({
      data: {
        taskExecutionId: taskId,
        teamId,
        actor: "USER",
        kind: "task.accounts.assigned",
        payload: json({
          submissionId: input.submissionId,
          digest,
          caseExecutionIds: [...updates.keys()],
          assignmentCount: input.assignments.length,
        }),
      },
    });
  });
}
