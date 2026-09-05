import { randomUUID } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { env } from "../config/env.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";
import { PrismaService } from "../database/prisma.service.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
import { POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD } from "../post-run-analysis/task-log-bundle.service.js";
import { WorkerMonitorService } from "./worker-monitor.service.js";

const INTERVAL_MS = 60 * 60 * 1_000;

@Injectable()
export class RetentionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
    private readonly monitor: WorkerMonitorService,
  ) {}

  onModuleInit() {
    if (!env().BACKGROUND_WORKERS_ENABLED) return;
    this.monitor.register("retention", INTERVAL_MS);
    this.timer = setInterval(() => this.trigger(), INTERVAL_MS);
    this.timer.unref();
    this.trigger();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      const failures: unknown[] = [];
      for (const stage of [
        this.purgeVerificationTrace,
        this.purgeRuntimeData,
        this.purgePostRunAnalysisBundles,
        this.purgeUnlinkedToolInvocations,
        this.purgeAuditEvents,
        this.purgeObjectStorageDeletions,
      ]) {
        try {
          await stage.call(this);
        } catch (error) {
          failures.push(error);
          this.logger.error(
            `Retention stage ${stage.name} failed: ${String(error)}`,
          );
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Retention stages failed");
    } finally {
      this.running = false;
    }
  }

  private trigger() {
    void this.monitor
      .run("retention", () => this.sweep())
      .catch((error: Error) => {
        this.logger.error(`Retention sweep failed: ${error.message}`);
      });
  }

  private async purgeVerificationTrace() {
    const runs = await this.prisma.verificationRun.findMany({
      orderBy: { retentionUntil: "asc" },
      select: { id: true },
      take: 20,
      where: {
        finishedAt: { not: null },
        purgedAt: null,
        retentionUntil: { lte: new Date() },
      },
    });
    for (const run of runs) {
      await this.serializable(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "verification_runs"
          WHERE "id" = ${run.id}::uuid
            AND "purged_at" IS NULL
            AND "retention_until" <= CURRENT_TIMESTAMP
          FOR UPDATE
        `;
        if (locked.length === 0) return;
        await tx.$queryRaw`
          SELECT runtime_artifact."id"
          FROM "browser_runtime_artifacts" AS runtime_artifact
          JOIN "verification_artifacts" AS verification_artifact
            ON verification_artifact."runtime_artifact_id" = runtime_artifact."id"
          WHERE verification_artifact."run_id" = ${run.id}::uuid
          FOR UPDATE OF runtime_artifact
        `;
        const artifacts = await tx.verificationArtifact.findMany({
          select: {
            runtimeArtifact: {
              select: {
                _count: {
                  select: {
                    testRunArtifacts: true,
                    verificationArtifacts: true,
                    runEvidences: true,
                  },
                },
                id: true,
              },
            },
            id: true,
            storageKey: true,
          },
          where: { runId: run.id, storageKey: { not: null } },
        });
        const runtimeOwned = artifacts.filter(
          (artifact) =>
            artifact.runtimeArtifact &&
            artifact.runtimeArtifact._count.verificationArtifacts === 1 &&
            artifact.runtimeArtifact._count.testRunArtifacts === 0 &&
            artifact.runtimeArtifact._count.runEvidences === 0,
        );
        const orphanOwned = [] as typeof artifacts;
        for (const artifact of artifacts) {
          if (artifact.runtimeArtifact || !artifact.storageKey) continue;
          await acquireAdvisoryTransactionLock(tx, artifact.storageKey);
          const [verificationReferences, testRunReferences] = await Promise.all(
            [
              tx.verificationArtifact.count({
                where: { storageKey: artifact.storageKey },
              }),
              tx.testRunArtifact.count({
                where: { storageKey: artifact.storageKey },
              }),
            ],
          );
          if (verificationReferences === 1 && testRunReferences === 0) {
            orphanOwned.push(artifact);
          }
        }
        const exclusivelyOwned = [...runtimeOwned, ...orphanOwned];
        await this.enqueueObjectDeletions(
          tx,
          exclusivelyOwned.flatMap((artifact) =>
            artifact.storageKey ? [artifact.storageKey] : [],
          ),
        );
        await tx.$executeRaw`SELECT set_config('devproof.retention_purge', 'on', true)`;
        await tx.notificationOutbox.deleteMany({ where: { runId: run.id } });
        await tx.verificationCheckpoint.deleteMany({
          where: { runId: run.id },
        });
        await tx.verificationAssertion.deleteMany({ where: { runId: run.id } });
        await tx.verificationArtifact.deleteMany({ where: { runId: run.id } });
        await tx.browserRuntimeArtifact.deleteMany({
          where: {
            id: {
              in: exclusivelyOwned.flatMap((artifact) =>
                artifact.runtimeArtifact ? [artifact.runtimeArtifact.id] : [],
              ),
            },
          },
        });
        await tx.verificationEvent.deleteMany({ where: { runId: run.id } });
        await tx.toolInvocation.deleteMany({ where: { runId: run.id } });
        await tx.verificationRun.update({
          data: { purgedAt: new Date() },
          where: { id: run.id },
        });
      });
    }
  }

  private async purgeRuntimeData() {
    const cutoff = new Date(
      Date.now() - env().RUNTIME_DATA_RETENTION_DAYS * 86_400_000,
    );
    const sessions = await this.prisma.browserRuntimeSession.findMany({
      include: {
        artifacts: {
          select: {
            storageKey: true,
            testRunArtifacts: { select: { id: true }, take: 1 },
            runEvidences: { select: { id: true }, take: 1 },
          },
        },
      },
      take: 20,
      where: {
        closedAt: { lte: cutoff },
        status: { in: ["CLOSED", "FAILED", "LOST"] },
        verificationRuns: { every: { purgedAt: { not: null } } },
        resourceLeases: { none: {} },
        artifacts: { none: { runEvidences: { some: {} } } },
      },
    });
    const failures: unknown[] = [];
    for (const session of sessions) {
      try {
        await this.serializable(async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT session."id"
          FROM "browser_runtime_sessions" AS session
          WHERE session."id" = ${session.id}::uuid
            AND session."closed_at" <= ${cutoff}
            AND session."status" IN ('CLOSED', 'FAILED', 'LOST')
            AND NOT EXISTS (
              SELECT 1
              FROM "verification_runs" AS run
              WHERE run."runtime_session_id" = session."id"
                AND run."purged_at" IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM "execution_resource_leases" AS lease
              WHERE lease."session_id" = session."id"
            )
          FOR UPDATE OF session
        `;
          if (locked.length === 0) return;
          await tx.$queryRaw`
          SELECT "id"
          FROM "browser_runtime_artifacts"
          WHERE "session_id" = ${session.id}::uuid
          FOR UPDATE
        `;
          const artifacts = await tx.browserRuntimeArtifact.findMany({
            select: {
              storageKey: true,
              testRunArtifacts: { select: { id: true }, take: 1 },
              runEvidences: { select: { id: true }, take: 1 },
            },
            where: { sessionId: session.id },
          });
          // Locking the artifact rows also fences concurrent evidence attachments.
          if (artifacts.some((artifact) => artifact.runEvidences.length > 0))
            return;
          await this.enqueueObjectDeletions(
            tx,
            artifacts
              .filter((artifact) => artifact.testRunArtifacts.length === 0)
              .map((artifact) => artifact.storageKey),
          );
          await tx.browserRuntimeSession.delete({ where: { id: session.id } });
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Runtime retention failed");
  }

  private async enqueueObjectDeletions(
    tx: Prisma.TransactionClient,
    storageKeys: string[],
  ) {
    if (storageKeys.length === 0) return;
    await tx.objectStorageDeletionTask.createMany({
      data: [...new Set(storageKeys)].map((storageKey) => ({ storageKey })),
      skipDuplicates: true,
    });
  }

  private async purgePostRunAnalysisBundles() {
    const cutoff = new Date(
      Date.now() - env().RUNTIME_DATA_RETENTION_DAYS * 86_400_000,
    );
    const jobs = await this.prisma.postRunAnalysisJob.findMany({
      orderBy: { finishedAt: "asc" },
      select: { id: true, inputManifest: true, inputStorageKey: true },
      take: 100,
      where: {
        finishedAt: { lte: cutoff },
        inputStorageKey: { not: null },
        status: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] },
      },
    });
    for (const job of jobs) {
      if (!job.inputStorageKey) continue;
      const manifest = recordValue(job.inputManifest);
      const archiveStorageKey =
        manifest[POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD];
      const evidenceStorageKey =
        typeof archiveStorageKey === "string" ? archiveStorageKey : null;
      await this.prisma.$transaction(async (tx) => {
        const detached = await tx.postRunAnalysisJob.updateMany({
          data: {
            analysisCheckpoint: {},
            inputManifest: {},
            inputStorageKey: null,
          },
          where: {
            id: job.id,
            inputStorageKey: job.inputStorageKey,
            status: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] },
          },
        });
        if (detached.count !== 1) return;
        await this.enqueueObjectDeletions(tx, [
          job.inputStorageKey!,
          ...(evidenceStorageKey ? [evidenceStorageKey] : []),
        ]);
      });
    }
  }

  private async purgeObjectStorageDeletions() {
    const tasks = await this.prisma.objectStorageDeletionTask.findMany({
      orderBy: { nextAttemptAt: "asc" },
      take: 100,
      where: {
        nextAttemptAt: { lte: new Date() },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
      },
    });
    for (const task of tasks) {
      const leaseToken = randomUUID();
      const claimed = await this.prisma.$transaction(async (tx) => {
        await acquireAdvisoryTransactionLock(tx, task.storageKey);
        const result = await tx.objectStorageDeletionTask.updateMany({
          data: {
            attempts: { increment: 1 },
            leaseExpiresAt: new Date(Date.now() + 60_000),
            leaseToken,
          },
          where: {
            id: task.id,
            nextAttemptAt: { lte: new Date() },
            OR: [
              { leaseExpiresAt: null },
              { leaseExpiresAt: { lte: new Date() } },
            ],
          },
        });
        if (result.count !== 1) return false;
        const [
          runtimeReferences,
          testRunReferences,
          verificationReferences,
          postRunAnalysisReferences,
        ] = await Promise.all([
          tx.browserRuntimeArtifact.count({
            where: { storageKey: task.storageKey },
          }),
          tx.testRunArtifact.count({
            where: { storageKey: task.storageKey },
          }),
          tx.verificationArtifact.count({
            where: { storageKey: task.storageKey },
          }),
          tx.postRunAnalysisJob.count({
            where: {
              OR: [
                { inputStorageKey: task.storageKey },
                { captureStorageKey: task.storageKey },
                { captureEvidenceStorageKey: task.storageKey },
              ],
            },
          }),
        ]);
        if (
          runtimeReferences > 0 ||
          testRunReferences > 0 ||
          verificationReferences > 0 ||
          postRunAnalysisReferences > 0
        ) {
          await tx.objectStorageDeletionTask.deleteMany({
            where: { id: task.id, leaseToken },
          });
          return false;
        }
        return true;
      });
      if (!claimed) continue;
      try {
        await this.storage.delete(task.storageKey);
        await this.prisma.objectStorageDeletionTask.deleteMany({
          where: { id: task.id, leaseToken },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempt = task.attempts + 1;
        await this.prisma.objectStorageDeletionTask.updateMany({
          data: {
            lastError: message.slice(0, 4_000),
            leaseExpiresAt: null,
            leaseToken: null,
            nextAttemptAt: new Date(
              Date.now() + Math.min(3_600, 2 ** attempt * 5) * 1_000,
            ),
          },
          where: { id: task.id, leaseToken },
        });
      }
    }
  }

  private async serializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== "P2034" ||
          attempt === 2
        ) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private async purgeAuditEvents() {
    const cutoff = new Date(
      Date.now() - env().AUDIT_RETENTION_DAYS * 86_400_000,
    );
    await this.prisma.auditEvent.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
  }

  private async purgeUnlinkedToolInvocations() {
    const cutoff = new Date(
      Date.now() - env().TOOL_INVOCATION_RETENTION_DAYS * 86_400_000,
    );
    await this.prisma.toolInvocation.deleteMany({
      where: {
        runId: null,
        startedAt: { lt: cutoff },
        status: { not: "STARTED" },
      },
    });
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
