import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config/env.js", () => ({
  env: () => ({
    RUNTIME_DATA_RETENTION_DAYS: 30,
    AUDIT_RETENTION_DAYS: 90,
    TOOL_INVOCATION_RETENTION_DAYS: 30,
  }),
}));

import { ProfileReservationService } from "./task-executions/profile-reservation.service.js";
import { RetentionWorker } from "./observability/retention-worker.service.js";
import { RuntimeCommandDispatcher } from "./runtime/runtime-command-dispatcher.service.js";
import { NotificationOutboxWorker } from "./verification/notification-outbox-worker.service.js";
import { SpecAnalysisRuntimeService } from "./agent-runtime/spec-analysis-runtime.service.js";

const connectionString = process.env.DEVPROOF_CONCURRENCY_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("Run the disposable Postgres test launcher.");
const destination = new URL(connectionString);
if (
  destination.hostname !== "127.0.0.1" ||
  destination.username !== "devproof_test" ||
  !/^\/devproof_concurrency_test_[a-f\d]{8}$/u.test(destination.pathname)
) {
  throw new Error("Refusing to use a non-disposable database.");
}
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString, max: 20 }),
});
const old = new Date("2020-01-01T00:00:00Z");
const future = () => new Date(Date.now() + 600_000);
let teamId: string;
let runtimeId: string;
const objects = new Map<string, Buffer>();
const storage = {
  put: vi.fn(async (key: string, _type: string, body: Buffer) => {
    objects.set(key, body);
    return { byteSize: body.length, sha256: "test-sha" };
  }),
  delete: vi.fn(async (key: string) => {
    objects.delete(key);
  }),
};
const retention = () =>
  new RetentionWorker(db as never, storage as never, {} as never);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function task() {
  return db.taskExecution.create({
    data: {
      teamId,
      idempotencyKey: randomUUID(),
      kind: "ISSUE_SPEC",
      sourceKind: "TEST",
      title: "Edge cases",
      inputSnapshot: {},
      environmentSnapshot: { targetUrl: "https://app.example.com" },
      traceId: randomUUID().replaceAll("-", ""),
      deadlineAt: future(),
      lifecycle: "RUNNING",
    },
  });
}
async function session(expired = false) {
  return db.browserRuntimeSession.create({
    data: {
      teamId,
      runtimeId,
      profileMode: "EPHEMERAL",
      profileKey: randomUUID(),
      slotNumber: 1,
      status: expired ? "CLOSED" : "ACTIVE",
      closedAt: expired ? old : null,
      leaseToken: randomUUID(),
      fencingToken: 1n,
      leaseExpiresAt: future(),
      protocolMajor: 1,
      protocolMinor: 13,
    },
  });
}
async function command() {
  const owner = await session();
  const row = await db.browserRuntimeCommand.create({
    data: {
      sessionId: owner.id,
      commandType: "page.screenshot",
      status: "DISPATCHED",
      leaseToken: owner.leaseToken,
      fencingToken: owner.fencingToken,
      deadlineAt: future(),
    },
  });
  return {
    row,
    result: {
      type: "command.result" as const,
      commandId: row.id,
      sessionId: owner.id,
      leaseToken: owner.leaseToken,
      fencingToken: "1",
      ok: true,
      result: {},
      artifacts: [
        {
          kind: "SCREENSHOT" as const,
          contentType: "image/png",
          dataBase64: Buffer.from("image").toString("base64"),
          metadata: {},
        },
      ],
    },
  };
}
async function notification(taskId: string, generation?: number) {
  return db.notificationOutbox.create({
    data: {
      teamId,
      taskExecutionId: taskId,
      dedupeKey: randomUUID(),
      eventType: "task.completed",
      payload:
        generation === undefined
          ? {}
          : { generation, notificationKind: "TASK_COMPLETED" },
    },
  });
}

afterAll(() => db.$disconnect());
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "teams", "users", "object_storage_deletion_tasks" RESTART IDENTITY CASCADE',
  );
  teamId = (
    await db.team.create({
      data: { name: "Test", slug: randomUUID(), feishuTenantKey: randomUUID() },
    })
  ).id;
  runtimeId = (
    await db.browserRuntime.create({
      data: {
        teamId,
        name: "Test",
        tokenHash: randomUUID(),
        tokenHint: "test",
        instanceKey: randomUUID(),
      },
    })
  ).id;
  objects.clear();
  storage.put.mockReset().mockImplementation(async (key, _type, body) => {
    objects.set(key, body);
    return { byteSize: body.length, sha256: "test-sha" };
  });
  storage.delete.mockClear();
});

describe("durable edge cases", () => {
  it("requeues a reopened serial task behind existing waiters and ignores a stale release", async () => {
    const owner = await db.user.create({
      data: { name: "Owner", memberships: { create: { teamId } } },
    });
    const profile = await db.userBrowserProfile.create({
      data: {
        teamId,
        ownerUserId: owner.id,
        runtimeProfileKey: randomUUID(),
        scopeKey: "test",
        displayName: "Test",
        status: "READY",
        executionMode: "SERIAL_PERSISTENT",
        inactivityExpiresAt: future(),
        grants: {
          create: {
            teamId,
            triggerSource: "CONSOLE",
            hostnamePattern: "app.example.com",
            consentedByUserId: owner.id,
          },
        },
      },
    });
    const a = await task(),
      b = await task();
    for (const row of [a, b])
      await db.taskProfileBinding.create({
        data: {
          taskExecutionId: row.id,
          strategy: "REQUESTER",
          status: "RESOLVED",
          unavailablePolicy: "WAIT_FOR_PROFILE",
          triggerSource: "CONSOLE",
          resolvedProfileId: profile.id,
          resolvedAt: new Date(),
        },
      });
    const service = new ProfileReservationService(db as never);
    expect((await service.acquire(a.id)).acquired).toBe(true);
    expect((await service.acquire(b.id)).acquired).toBe(false);
    await db.taskExecution.update({
      where: { id: a.id },
      data: { lifecycle: "COMPLETED" },
    });
    await service.releaseTask(a.id);
    const released = await db.browserProfileReservation.findFirstOrThrow({
      where: { taskExecutionId: a.id },
    });
    await db.taskExecution.update({
      where: { id: a.id },
      data: {
        lifecycle: "RUNNING",
        postRunAnalysisGeneration: { increment: 1 },
      },
    });
    expect((await service.acquire(a.id)).acquired).toBe(false);
    const queued = await db.browserProfileReservation.findUniqueOrThrow({
      where: { id: released.id },
    });
    expect(queued.status).toBe("QUEUED");
    expect(queued.queuedAt.getTime()).toBeGreaterThan(
      released.queuedAt.getTime(),
    );
    await service.releaseTask(a.id);
    expect(
      (
        await db.browserProfileReservation.findUniqueOrThrow({
          where: { id: queued.id },
        })
      ).status,
    ).toBe("QUEUED");
    expect((await service.acquire(b.id)).acquired).toBe(true);
    await db.taskExecution.update({
      where: { id: b.id },
      data: { lifecycle: "COMPLETED" },
    });
    await service.releaseTask(b.id);
    expect((await service.acquire(a.id)).acquired).toBe(true);
  });

  it("retains v2 evidence and quarantined leases while collecting an unreferenced session", async () => {
    const evidenceSession = await session(true),
      quarantined = await session(true),
      orphan = await session(true);
    await db.executionResourceLease.create({
      data: {
        sessionId: quarantined.id,
        rootKey: "resource",
        mode: "WRITE",
        quarantined: true,
      },
    });
    const artifact = await db.browserRuntimeArtifact.create({
      data: {
        sessionId: evidenceSession.id,
        kind: "SCREENSHOT",
        contentType: "image/png",
        storageKey: "evidence",
        byteSize: 5,
        sha256: "hash",
      },
    });
    const run = await db.executionRun.create({
      data: {
        teamId,
        goal: "Test",
        idempotencyKey: randomUUID(),
        criteriaSnapshot: [],
        traceId: randomUUID().replaceAll("-", ""),
        initialDeadlineAt: future(),
        deadlineAt: future(),
        hardDeadlineAt: future(),
      },
    });
    const attempt = await db.runAttempt.create({
      data: { runId: run.id, number: 1, inputSnapshot: {} },
    });
    const evidence = await db.runEvidence.create({
      data: {
        teamId,
        runId: run.id,
        attemptId: attempt.id,
        externalId: "screenshot",
        kind: "SCREENSHOT",
        runtimeArtifactId: artifact.id,
      },
    });
    await retention().sweep();
    expect(await db.browserRuntimeSession.count()).toBe(2);
    expect(
      await db.browserRuntimeSession.findUnique({ where: { id: orphan.id } }),
    ).toBeNull();
    expect(
      (await db.runEvidence.findUniqueOrThrow({ where: { id: evidence.id } }))
        .runtimeArtifactId,
    ).toBe(artifact.id);
    expect(await db.executionResourceLease.count()).toBe(1);
    expect(storage.delete).not.toHaveBeenCalled();
    // Retention becomes possible once the owning evidence is explicitly removed.
    await db.runEvidence.delete({ where: { id: evidence.id } });
    await retention().sweep();
    expect(await db.browserRuntimeArtifact.count()).toBe(0);
    expect(storage.delete).toHaveBeenCalledWith("evidence");
  });

  it.each(["lost-cas", "partial-upload", "expired-intent"])(
    "reclaims uploads after %s",
    async (failure) => {
      const { row, result } = await command();
      storage.put.mockImplementationOnce(async (key, _type, body) => {
        expect(
          await db.objectStorageDeletionTask.count({
            where: { storageKey: key },
          }),
        ).toBe(1);
        objects.set(key, body);
        if (failure === "lost-cas")
          await db.browserRuntimeCommand.update({
            where: { id: row.id },
            data: { status: "CANCELLED" },
          });
        if (failure === "expired-intent")
          await db.objectStorageDeletionTask.update({
            where: { storageKey: key },
            data: { nextAttemptAt: old },
          });
        if (failure === "partial-upload")
          throw new Error("process died after upload");
        return { byteSize: body.length, sha256: "test" };
      });
      const dispatcher = new RuntimeCommandDispatcher(
        db as never,
        {} as never,
        storage as never,
      );
      await expect(dispatcher.acceptResult(result)).rejects.toThrow();
      expect(await db.browserRuntimeArtifact.count()).toBe(0);
      expect(await db.objectStorageDeletionTask.count()).toBe(1);
      await db.objectStorageDeletionTask.updateMany({
        data: { nextAttemptAt: old },
      });
      await retention().sweep();
      expect(objects.size).toBe(0);
      expect(await db.objectStorageDeletionTask.count()).toBe(0);
    },
  );

  it("reclaims an entire batch when the second artifact upload fails", async () => {
    const { result } = await command();
    result.artifacts.push({ ...result.artifacts[0]! });
    storage.put
      .mockImplementationOnce(async (key, _type, body) => {
        objects.set(key, body);
        return { byteSize: body.length, sha256: "test" };
      })
      .mockImplementationOnce(async (key, _type, body) => {
        objects.set(key, body);
        throw new Error("second upload failed after writing");
      });
    await expect(
      new RuntimeCommandDispatcher(
        db as never,
        {} as never,
        storage as never,
      ).acceptResult(result),
    ).rejects.toThrow("second upload");
    expect(await db.browserRuntimeArtifact.count()).toBe(0);
    expect(await db.objectStorageDeletionTask.count()).toBe(2);
    await db.objectStorageDeletionTask.updateMany({
      data: { nextAttemptAt: old },
    });
    await retention().sweep();
    expect(objects.size).toBe(0);
  });

  it("publishes an uploaded artifact and consumes its cleanup intent atomically", async () => {
    const { result } = await command();
    await new RuntimeCommandDispatcher(
      db as never,
      {} as never,
      storage as never,
    ).acceptResult(result);
    expect(await db.browserRuntimeArtifact.count()).toBe(1);
    expect(await db.objectStorageDeletionTask.count()).toBe(0);
    await retention().sweep();
    expect(objects.size).toBe(1);
  });

  it.each([false, true])(
    "fences a stale notifier's late result (failure=%s)",
    async (fail) => {
      const owner = await task(),
        row = await notification(owner.id);
      const entered = deferred(),
        finish = deferred();
      const worker = new NotificationOutboxWorker(
        db as never,
        {} as never,
        {} as never,
      );
      vi.spyOn(worker as any, "sendFeishu").mockImplementation(async () => {
        entered.resolve();
        await finish.promise;
        if (fail) throw new Error("late request failed");
      });
      const sending = (worker as any).deliver(row.id);
      await entered.promise;
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: { status: "DELIVERED", leaseToken: null, leaseExpiresAt: null },
      });
      finish.resolve();
      await sending;
      expect(
        (
          await db.notificationOutbox.findUniqueOrThrow({
            where: { id: row.id },
          })
        ).status,
      ).toBe("DELIVERED");
      expect(await db.taskExecutionEvent.count()).toBe(0);
    },
  );

  it("orders generations across workers and suppresses queued superseded notifications", async () => {
    const owner = await task();
    await db.taskExecution.update({
      where: { id: owner.id },
      data: { lifecycle: "COMPLETED", postRunAnalysisGeneration: 1 },
    });
    const first = await notification(owner.id, 1);
    const entered = deferred(),
      finish = deferred();
    const workerA = new NotificationOutboxWorker(
      db as never,
      {} as never,
      {} as never,
    );
    const workerB = new NotificationOutboxWorker(
      db as never,
      {} as never,
      {} as never,
    );
    const delivered: number[] = [];
    vi.spyOn(workerA as any, "sendFeishu").mockImplementation(async () => {
      entered.resolve();
      await finish.promise;
      delivered.push(1);
    });
    vi.spyOn(workerB as any, "sendFeishu").mockImplementation(
      async (_id: unknown, payload: any) => {
        delivered.push(payload.generation);
      },
    );
    const sending = (workerA as any).deliver(first.id);
    await entered.promise;
    await db.taskExecution.update({
      where: { id: owner.id },
      data: { postRunAnalysisGeneration: 2 },
    });
    const second = await notification(owner.id, 2);
    await (workerB as any).deliver(second.id);
    expect(delivered).toEqual([]);
    finish.resolve();
    await sending;
    await (workerB as any).deliver(second.id);
    expect(delivered).toEqual([1, 2]);
    const obsolete = await notification(owner.id, 1);
    await (workerB as any).deliver(obsolete.id);
    expect(delivered).toEqual([1, 2]);
    expect(
      (
        await db.notificationOutbox.findUniqueOrThrow({
          where: { id: obsolete.id },
        })
      ).lastError,
    ).toContain("Superseded");
  });

  it("delivers pre-upgrade completion rows only for the original task generation", async () => {
    const owner = await task();
    await db.taskExecution.update({
      where: { id: owner.id },
      data: { lifecycle: "COMPLETED", postRunAnalysisGeneration: 1 },
    });
    const worker = new NotificationOutboxWorker(
      db as never,
      {} as never,
      {} as never,
    );
    const send = vi
      .spyOn(worker as any, "sendFeishu")
      .mockResolvedValue(undefined);
    for (const generation of [1, 2]) {
      await db.taskExecution.update({
        where: { id: owner.id },
        data: { postRunAnalysisGeneration: generation },
      });
      const row = await notification(owner.id);
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: { payload: { notificationKind: "TASK_COMPLETED" } },
      });
      await (worker as any).deliver(row.id);
    }
    expect(send).toHaveBeenCalledOnce();
  });

  it("renews a notification lease during a slow external request", async () => {
    const owner = await task(),
      row = await notification(owner.id);
    const entered = deferred(),
      finish = deferred();
    const worker = new NotificationOutboxWorker(
      db as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(worker as any, "sendFeishu").mockImplementation(async () => {
      entered.resolve();
      await finish.promise;
    });
    const sending = (worker as any).deliver(row.id);
    await entered.promise;
    const original = await db.notificationOutbox.findUniqueOrThrow({
      where: { id: row.id },
    });
    await vi.waitFor(
      async () => {
        const renewed = await db.notificationOutbox.findUniqueOrThrow({
          where: { id: row.id },
        });
        expect(renewed.leaseExpiresAt!.getTime()).toBeGreaterThan(
          original.leaseExpiresAt!.getTime() + 5_000,
        );
      },
      { timeout: 15_000, interval: 500 },
    );
    finish.resolve();
    await sending;
    expect(
      (await db.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe("DELIVERED");
  });

  it("serializes concurrent source writes so one attempt cannot mix PR revisions", async () => {
    const owner = await task();
    const stage = await db.taskExecutionStage.create({
      data: { taskExecutionId: owner.id, type: "SPEC_ANALYSIS" },
    });
    const attempt = await db.taskStageAttempt.create({
      data: { stageId: stage.id, number: 1, inputSnapshot: {} },
    });
    const service = new SpecAnalysisRuntimeService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const input = {
      content: {},
      excerpt: "code",
      kind: "GITHUB_FILE",
      label: "file",
      locator: {},
      uri: "https://github.com/acme/web/pull/1/files#file",
    };
    const outcomes = await Promise.allSettled(
      ["a", "b"].map((revision) =>
        (service as any).persistSource(
          { id: attempt.id, stage: { taskExecution: owner } },
          { ...input, revision },
        ),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    expect(await db.taskAnalysisSource.count()).toBe(1);
  });
});
