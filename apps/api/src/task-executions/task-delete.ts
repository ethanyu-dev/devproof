import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../database/prisma.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";

const terminal = ["COMPLETED", "CANCELLED", "TIMED_OUT"] as const;
const finished = (status: string) => terminal.some((value) => value === status);

/** Remove the aggregate and its owned traces atomically; files use the durable deletion outbox. */
export async function deleteTask(
  prisma: PrismaService,
  teamId: string,
  id: string,
) {
  try {
    return await prisma.$transaction(
      async (tx) => {
        // Same resource lock as dispatch/recovery. Row locks also serialize retries
        // that change the parent generation; serializable isolation catches inserts.
        await acquireAdvisoryTransactionLock(tx, "browser-execution-resources");
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM task_executions WHERE id = ${id}::uuid AND team_id = ${teamId}::uuid FOR UPDATE
      `;
        if (!locked.length) throw new NotFoundException("任务不存在或已删除。");
        const task = await tx.taskExecution.findUniqueOrThrow({
          where: { id },
          include: {
            stages: { include: { attempts: true } },
            caseExecutions: true,
          },
        });
        const executionRuns = await tx.executionRun.findMany({
          where: {
            teamId,
            OR: [
              { taskExecutionId: id },
              { taskCaseExecution: { taskExecutionId: id } },
            ],
          },
          include: { tasks: true },
        });
        if (
          executionRuns.some(
            (run) => run.taskExecutionId && run.taskExecutionId !== id,
          )
        ) {
          throw new ConflictException(
            "任务引用了其他任务的执行记录，请先修复关联后再删除。",
          );
        }
        if (!finished(task.lifecycle))
          throw new ConflictException(
            "任务尚未结束，运行中或等待人工处理的任务不能删除。请先取消任务并等待执行结束。",
          );
        if (
          executionRuns.some(
            (run) =>
              !finished(run.lifecycle) ||
              run.tasks.some((agent) =>
                ["PENDING", "RUNNING", "WAITING_HUMAN"].includes(agent.status),
              ),
          ) ||
          task.stages.some(
            (stage) =>
              stage.status === "RUNNING" ||
              stage.attempts.some((attempt) =>
                ["PENDING", "RUNNING"].includes(attempt.status),
              ),
          ) ||
          task.caseExecutions.some(
            (item) => item.dispatchStatus === "DISPATCHING",
          )
        ) {
          throw new ConflictException(
            "子执行仍在运行或收尾，请等待结束后再删除。",
          );
        }
        const runIds = executionRuns.map((run) => run.id);
        const agentIds = executionRuns.flatMap((run) =>
          run.tasks.map((agent) => agent.id),
        );
        const sessions = await tx.browserRuntimeSession.findMany({
          where: {
            teamId,
            OR: [
              { ownerTaskId: { in: agentIds } },
              { browserExecutions: { some: { runId: { in: runIds } } } },
              {
                artifacts: {
                  some: { runEvidences: { some: { runId: { in: runIds } } } },
                },
              },
            ],
          },
          include: {
            slot: true,
            profileLease: true,
            humanControlLease: true,
            resourceLeases: true,
          },
        });
        if (
          sessions.some(
            (session) =>
              session.status !== "CLOSED" ||
              !session.closureVerifiedAt ||
              !session.closureEvidenceId ||
              session.identityPermit !== null ||
              session.slot ||
              session.profileLease ||
              session.humanControlLease ||
              session.resourceLeases.length,
          )
        ) {
          throw new ConflictException(
            "浏览器尚未完成关闭或资源回收，请先在执行详情中完成会话恢复，再删除任务。",
          );
        }
        const sessionIds = sessions.map((session) => session.id);
        if (sessionIds.length) {
          await tx.$queryRaw(Prisma.sql`
          SELECT id FROM browser_runtime_artifacts
          WHERE session_id IN (${Prisma.join(sessionIds.map((sessionId) => Prisma.sql`${sessionId}::uuid`))})
          ORDER BY id FOR UPDATE
        `);
        }
        // Never delete a session or artifact referenced by another task or legacy run.
        const ownedSessions = await tx.browserRuntimeSession.findMany({
          where: {
            id: { in: sessionIds },
            teamId,
            OR: [{ ownerTaskId: null }, { ownerTaskId: { in: agentIds } }],
            browserExecutions: { every: { runId: { in: runIds } } },
            testRuns: { none: {} },
            verificationRuns: { none: {} },
            artifacts: {
              every: {
                testRunArtifacts: { none: {} },
                verificationArtifacts: { none: {} },
                runEvidences: { every: { runId: { in: runIds } } },
              },
            },
          },
          select: { id: true },
        });
        const ownedSessionIds = ownedSessions.map((session) => session.id);
        const artifacts = await tx.browserRuntimeArtifact.findMany({
          where: {
            session: { teamId },
            OR: [
              { sessionId: { in: ownedSessionIds } },
              { runEvidences: { some: { runId: { in: runIds } } } },
            ],
            testRunArtifacts: { none: {} },
            verificationArtifacts: { none: {} },
            runEvidences: { every: { runId: { in: runIds } } },
          },
          select: { id: true, storageKey: true },
        });
        if (artifacts.length) {
          await tx.objectStorageDeletionTask.createMany({
            data: artifacts.map((artifact) => ({
              storageKey: artifact.storageKey,
            })),
            skipDuplicates: true,
          });
          await tx.browserRuntimeArtifact.deleteMany({
            where: { id: { in: artifacts.map((artifact) => artifact.id) } },
          });
        }
        const recoveries = await tx.runtimeSessionRecovery.findMany({
          where: { sessionId: { in: ownedSessionIds }, teamId },
          select: { id: true },
        });
        await tx.runtimeRecoveryOutbox.deleteMany({
          where: {
            recoveryId: { in: recoveries.map((recovery) => recovery.id) },
          },
        });
        await tx.sessionClosureEvidence.deleteMany({
          where: { sessionId: { in: ownedSessionIds } },
        });
        await tx.runtimeSessionRecovery.deleteMany({
          where: { id: { in: recoveries.map((recovery) => recovery.id) } },
        });
        await tx.browserRuntimeSession.deleteMany({
          where: { id: { in: ownedSessionIds }, teamId },
        });
        await tx.browserProfileUsage.deleteMany({
          where: {
            teamId,
            OR: [{ taskExecutionId: id }, { executionRunId: { in: runIds } }],
          },
        });
        // Integration event IDs remain deduplicated, but must not retain deleted task inputs.
        await tx.inboundIntegrationEvent.updateMany({
          where: { taskExecutionId: id, teamId },
          data: { taskExecutionId: null, metadata: {}, error: Prisma.DbNull },
        });
        await tx.executionRun.deleteMany({
          where: { id: { in: runIds }, teamId },
        });
        // Snapshot -> stageAttempt is RESTRICT; remove snapshots before cascading stages.
        await tx.taskSpecificationSnapshot.deleteMany({
          where: { taskExecutionId: id },
        });
        await tx.taskExecution.delete({ where: { id, teamId } });
        return artifacts.map((artifact) => artifact.storageKey);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034"
    ) {
      throw new ConflictException("任务状态刚刚发生变化，请刷新后重试删除。");
    }
    throw error;
  }
}
