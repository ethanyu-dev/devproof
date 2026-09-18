import { isSpecTask } from "@devproof/contracts";
import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  testAccountSlots,
  type TestAccountPlan,
} from "@devproof/agent-runtime-protocol";
import { specificationDefinitionHash } from "@devproof/test-domain";
import { taskExecutionCreateInputSchema } from "@devproof/contracts";
import type { PrismaService } from "../database/prisma.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { refreshedTaskDeadline } from "./task-deadline.js";
import {
  readAccountPlan,
  resolveCaseExecutionDefinition,
} from "./case-account-definition.js";

export const correctAccountRequirementsInputSchema = z
  .object({
    teamId: z.string().uuid(),
    taskId: z.string().uuid(),
    correctionId: z.string().uuid(),
    operator: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1).max(1000),
    cases: z
      .array(
        z
          .object({
            caseExecutionId: z.string().uuid(),
            definitionHash: z.string().regex(/^[a-f0-9]{64}$/u),
            expectedRevision: z.string().uuid(),
            removedRoles: z.array(z.string().min(1).max(80)).min(1).max(20),
            effectiveAuthRole: z.string().trim().min(1).max(120),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

/** Operator-only maintenance operation: dry run is the default; no invented accounts. */
export async function correctAccountRequirements(
  db: PrismaService,
  raw: unknown,
  apply = false,
) {
  const input = correctAccountRequirementsInputSchema.parse(raw);
  if (
    new Set(input.cases.map((c) => c.caseExecutionId)).size !==
    input.cases.length
  )
    throw new BadRequestException("不能重复指定执行用例。");
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  return db.$transaction(async (tx) => {
    // Parent lock first, matching cancellation and projection. Row CAS fences dispatch.
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM task_executions WHERE id = ${input.taskId}::uuid AND team_id = ${input.teamId}::uuid FOR UPDATE
    `);
    if (!locked.length) throw new NotFoundException("Task not found.");
    await acquireAdvisoryTransactionLock(
      tx,
      `task-test-accounts:${input.taskId}`,
    );
    const duplicate = await tx.taskExecutionEvent.findFirst({
      where: {
        taskExecutionId: input.taskId,
        kind: "task.accounts.requirements_corrected",
        payload: { path: ["correctionId"], equals: input.correctionId },
      },
    });
    if (duplicate) {
      if ((duplicate.payload as Record<string, unknown>).digest !== digest)
        throw new ConflictException("同一修复编号不能用于不同内容。");
      return {
        applied: true,
        duplicate: true,
        correctionId: input.correctionId,
      };
    }
    const task = await tx.taskExecution.findUniqueOrThrow({
      where: { id: input.taskId },
      include: {
        specificationSnapshots: { orderBy: { generatedAt: "desc" }, take: 1 },
        caseExecutions: { include: { testCase: true, deployment: true } },
      },
    });
    if (
      task.cancelRequestedAt ||
      ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(task.lifecycle)
    )
      throw new ConflictException("已结束或已取消任务不能原地修复。");
    const now = new Date();
    const taskInput = taskExecutionCreateInputSchema.parse(task.inputSnapshot);
    const hitl = isSpecTask(taskInput)
      ? taskInput.hitlPolicy
      : taskInput.run.hitlPolicy;
    const changes = input.cases.map((change) => {
      const row = task.caseExecutions.find(
        (c) => c.id === change.caseExecutionId,
      );
      if (
        !row ||
        row.testCase.snapshotId !== task.specificationSnapshots[0]?.id ||
        !row.deployment.enabled
      )
        throw new ConflictException("修复目标不属于当前 Spec 或启用环境。");
      if (
        row.runId ||
        row.dispatchStatus !== "PENDING" ||
        row.dispatchRequestedAt ||
        row.dispatchAttempts ||
        task.caseExecutions.some(
          (c) =>
            c.caseId === row.caseId &&
            c.deploymentId === row.deploymentId &&
            c.executionOrdinal > row.executionOrdinal,
        )
      )
        throw new ConflictException(
          "Case 已进入派发或不是最新执行，不能修复。",
        );
      const old = readAccountPlan(row.testAccountPlan);
      if (
        !old ||
        old.revision !== change.expectedRevision ||
        specificationDefinitionHash(row.testCase.definition) !==
          change.definitionHash
      )
        throw new ConflictException("Spec 或账号计划已变化，请重新预览。");
      resolveCaseExecutionDefinition(row.testCase.definition, old);
      if (
        testAccountSlots(old.requirements).every((slot) =>
          old.bindings.some((binding) => binding.slotId === slot.slotId),
        )
      )
        throw new ConflictException("只允许修正尚被缺失账号阻塞的用例。");
      if (
        new Set(change.removedRoles).size !== change.removedRoles.length ||
        change.removedRoles.some(
          (role) => !old.requirements.some((r) => r.role === role),
        )
      )
        throw new BadRequestException("只能纠正计划中仍存在的角色。");
      const requirements = old.requirements.filter(
        (r) => !change.removedRoles.includes(r.role),
      );
      const slots = testAccountSlots(requirements);
      const plan: TestAccountPlan = {
        ...old,
        version: 2,
        definitionHash: change.definitionHash,
        revision: randomUUID(),
        requestedAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + hitl.timeoutSeconds * 1_000,
        ).toISOString(),
        effectiveAuthRole: change.effectiveAuthRole,
        requirements,
        bindings: old.bindings.filter((b) =>
          slots.some((s) => s.slotId === b.slotId),
        ),
        resolution: {
          kind: "REVIEWED_CORRECTION",
          reason: input.reason,
          removedRoles: [
            ...(old.version === 2 ? old.resolution.removedRoles : []),
            ...change.removedRoles,
          ],
        },
      };
      resolveCaseExecutionDefinition(row.testCase.definition, plan);
      const missing = slots.filter(
        (s) => !plan.bindings.some((b) => b.slotId === s.slotId),
      ).length;
      return { row, old, plan, missing };
    });
    const preview = changes.map(({ row, old, plan, missing }) => ({
      caseExecutionId: row.id,
      caseName: row.testCase.name,
      before: old.requirements,
      after: plan.requirements,
      missingCount: missing,
      effectiveAuthRole:
        plan.version === 2 ? plan.effectiveAuthRole : "default",
    }));
    if (!apply)
      return {
        applied: false,
        correctionId: input.correctionId,
        changes: preview,
      };
    for (const { row, plan, missing } of changes) {
      const updated = await tx.taskCaseExecution.updateMany({
        where: {
          id: row.id,
          runId: null,
          dispatchStatus: "PENDING",
          updatedAt: row.updatedAt,
          dispatchRequestedAt: null,
          dispatchAttempts: 0,
        },
        data: {
          testAccountPlan: plan as unknown as Prisma.InputJsonValue,
          scheduling: {
            state: missing ? "WAITING" : "READY",
            reason: missing ? "TEST_ACCOUNTS_REQUIRED" : null,
            blockedBy: missing ? { resourceType: "TEST_ACCOUNT" } : null,
            waitingSince: missing ? plan.requestedAt : null,
            evaluatedAt: now.toISOString(),
            queue: null,
            nextRetryAt: null,
          },
        },
      });
      if (updated.count !== 1)
        throw new ConflictException("派发状态已变化，请重新预览。");
    }
    await tx.taskExecution.update({
      where: { id: task.id },
      data: {
        projectionNeededAt: now,
        deadlineAt: refreshedTaskDeadline(task.inputSnapshot, now),
      },
    });
    await tx.taskExecutionEvent.create({
      data: {
        taskExecutionId: task.id,
        teamId: input.teamId,
        actor: "OPERATOR",
        kind: "task.accounts.requirements_corrected",
        payload: {
          correctionId: input.correctionId,
          digest,
          operator: input.operator,
          reason: input.reason,
          changes: preview,
          definitionHashes: input.cases.map((c) => c.definitionHash),
          summary: `已纠正 ${changes.length} 个用例的操作身份需求，剩余 ${changes.reduce((sum, c) => sum + testAccountSlots(c.plan.requirements).length, 0)} 个业务账号槽位。`,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return {
      applied: true,
      correctionId: input.correctionId,
      changes: preview,
    };
  });
}
