import { describe, expect, it, vi } from "vitest";

import { POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD } from "../post-run-analysis/task-log-bundle.service.js";
import { leaseDigest } from "../runtime/session-recovery.state.js";
import { RetentionWorker } from "./retention-worker.service.js";

function fixture(
  counts: {
    testRunArtifacts: number;
    verificationArtifacts: number;
    runEvidences?: number;
  },
  postRunBundle = false,
) {
  const queuedKeys: string[] = [];
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([{ id: "locked" }]),
    browserRuntimeArtifact: {
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    notificationOutbox: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    objectStorageDeletionTask: {
      createMany: vi.fn(
        async ({ data }: { data: Array<{ storageKey: string }> }) => {
          queuedKeys.push(...data.map((row) => row.storageKey));
          return { count: data.length };
        },
      ),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    postRunAnalysisJob: {
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    testRunArtifact: { count: vi.fn().mockResolvedValue(0) },
    toolInvocation: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    verificationArtifact: {
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "artifact-link-1",
          runtimeArtifact: {
            _count: { runEvidences: 0, ...counts },
            id: "runtime-artifact-1",
          },
          storageKey: "runtime/team/session/command/screenshot",
        },
      ]),
    },
    verificationAssertion: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    verificationCheckpoint: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    verificationEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    verificationRun: { update: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn(
      async (operation: (client: typeof tx) => Promise<void>) => operation(tx),
    ),
    auditEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    browserRuntimeSession: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    objectStorageDeletionTask: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn(async () =>
        queuedKeys.map((storageKey, index) => ({
          attempts: 0,
          id: `task-${index}`,
          storageKey,
        })),
      ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    postRunAnalysisJob: {
      findMany: vi.fn().mockResolvedValue(
        postRunBundle
          ? [
              {
                id: "analysis-1",
                inputManifest: {
                  [POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD]:
                    "post-run-analysis/team/task/job/bundle.json.evidence.ndjson",
                },
                inputStorageKey: "post-run-analysis/team/task/job/bundle.json",
              },
            ]
          : [],
      ),
    },
    toolInvocation: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    verificationRun: {
      findMany: vi.fn().mockResolvedValue([{ id: "run-1" }]),
    },
  };
  const storage = { delete: vi.fn().mockResolvedValue(undefined) };
  const worker = new RetentionWorker(
    prisma as never,
    storage as never,
    {} as never,
  );
  return { prisma, storage, tx, worker };
}

describe("RetentionWorker", () => {
  it("deletes exclusively owned evidence after committing its trace purge", async () => {
    const { storage, tx, worker } = fixture({
      testRunArtifacts: 0,
      verificationArtifacts: 1,
    });

    await worker.sweep();

    expect(storage.delete).toHaveBeenCalledWith(
      "runtime/team/session/command/screenshot",
    );
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.browserRuntimeArtifact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["runtime-artifact-1"] } },
    });
    expect(tx.verificationEvent.deleteMany).toHaveBeenCalledWith({
      where: { runId: "run-1" },
    });
    expect(tx.verificationRun.update).toHaveBeenCalledWith({
      data: { purgedAt: expect.any(Date) },
      where: { id: "run-1" },
    });
  });

  it("preserves shared evidence while removing the expired verification link", async () => {
    const { storage, tx, worker } = fixture({
      testRunArtifacts: 1,
      verificationArtifacts: 1,
    });

    await worker.sweep();

    expect(storage.delete).not.toHaveBeenCalled();
    expect(tx.objectStorageDeletionTask.createMany).not.toHaveBeenCalled();
    expect(tx.verificationArtifact.deleteMany).toHaveBeenCalledWith({
      where: { runId: "run-1" },
    });
    expect(tx.browserRuntimeArtifact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [] } },
    });
  });

  it("preserves runtime metadata referenced by v2 evidence when a legacy trace expires", async () => {
    const { tx, storage, worker } = fixture({
      testRunArtifacts: 0,
      verificationArtifacts: 1,
      runEvidences: 1,
    });
    await worker.sweep();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(tx.browserRuntimeArtifact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [] } },
    });
  });

  it("continues every retention stage after a runtime purge failure and surfaces the failure", async () => {
    const { worker, prisma } = fixture({
      testRunArtifacts: 0,
      verificationArtifacts: 1,
    });
    const purge = vi
      .spyOn(worker as never, "purgeRuntimeData" as never)
      .mockRejectedValue(new Error("foreign key"));
    const bundles = vi.spyOn(
      worker as never,
      "purgePostRunAnalysisBundles" as never,
    );
    const objects = vi.spyOn(
      worker as never,
      "purgeObjectStorageDeletions" as never,
    );
    await expect(worker.sweep()).rejects.toThrow("Retention stages failed");
    expect(bundles).toHaveBeenCalledOnce();
    expect(objects).toHaveBeenCalledOnce();
    expect(prisma.auditEvent.deleteMany).toHaveBeenCalledOnce();
    purge.mockRestore();
    await expect(worker.sweep()).resolves.toBeUndefined();
  });

  it("rechecks the deletion due time when claiming a stale object deletion candidate", async () => {
    const { tx, storage, worker } = fixture({
      testRunArtifacts: 0,
      verificationArtifacts: 1,
    });
    tx.objectStorageDeletionTask.updateMany.mockResolvedValue({ count: 0 });
    await worker.sweep();
    expect(tx.objectStorageDeletionTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          nextAttemptAt: { lte: expect.any(Date) },
        }),
      }),
    );
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("detaches and deletes expired post-run bundles without deleting findings", async () => {
    const { storage, tx, worker } = fixture(
      { testRunArtifacts: 1, verificationArtifacts: 1 },
      true,
    );

    await worker.sweep();

    expect(tx.postRunAnalysisJob.updateMany).toHaveBeenCalledWith({
      data: {
        analysisCheckpoint: {},
        inputManifest: {},
        inputStorageKey: null,
      },
      where: {
        id: "analysis-1",
        inputStorageKey: "post-run-analysis/team/task/job/bundle.json",
        status: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] },
      },
    });
    expect(storage.delete).toHaveBeenCalledWith(
      "post-run-analysis/team/task/job/bundle.json",
    );
    expect(storage.delete).toHaveBeenCalledWith(
      "post-run-analysis/team/task/job/bundle.json.evidence.ndjson",
    );
  });
});

function runtimeRetentionFixture() {
  const session = {
    id: "session-1",
    runtimeId: "runtime-1",
    status: "CLOSED",
    leaseToken: "lease-1",
    fencingToken: 4n,
    closedAt: new Date(0) as Date | null,
    closureVerifiedAt: new Date(0) as Date | null,
    closureEvidenceId: "proof-1" as string | null,
    identityPermit: null as number | null,
    slot: null as object | null,
    profileLease: null as object | null,
    humanControlLease: null as object | null,
    _count: { resourceLeases: 0, verificationRuns: 0 },
  };
  const evidence = {
    id: "proof-1",
    recoveryId: "recovery-1",
    sessionId: session.id,
    runtimeId: session.runtimeId,
    sessionFence: session.fencingToken,
    leaseDigest: leaseDigest(session.leaseToken),
    serverVerifiedAt: new Date(0) as Date | null,
  };
  const recovery = {
    id: evidence.recoveryId,
    sessionId: session.id,
    runtimeId: session.runtimeId,
    expectedSessionFence: session.fencingToken,
    expectedLeaseDigest: evidence.leaseDigest,
    closureState: "VERIFIED",
    closureEvidenceId: evidence.id as string | null,
    closureVerifiedAt: new Date(0) as Date | null,
    resolvedAt: new Date(0) as Date | null,
    writeOutcomeState: "CONFIRMED",
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: session.id }]),
    browserRuntimeSession: {
      findUnique: vi.fn().mockResolvedValue(session),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    sessionClosureEvidence: { findUnique: vi.fn().mockResolvedValue(evidence) },
    runtimeSessionRecovery: { findMany: vi.fn().mockResolvedValue([recovery]) },
    browserRuntimeArtifact: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: "artifact-1", storageKey: "runtime/expired/screenshot" },
        ]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    objectStorageDeletionTask: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    browserRuntimeSession: {
      findMany: vi.fn().mockResolvedValue([{ id: session.id }]),
    },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<void>) =>
      fn(tx),
    ),
  };
  const worker = new RetentionWorker(prisma as never, {} as never, {} as never);
  const purge = () =>
    Reflect.get(worker, "purgeRuntimeData").call(worker) as Promise<void>;
  return { session, evidence, recovery, tx, prisma, purge };
}

describe("RetentionWorker runtime closure protection", () => {
  it("purges only unreferenced artifacts from resolved proof-backed sessions and preserves audit metadata", async () => {
    const { tx, prisma, purge } = runtimeRetentionFixture();
    await purge();

    expect(prisma.browserRuntimeSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "CLOSED",
          closureVerifiedAt: { not: null },
          closureEvidenceId: { not: null },
          slot: null,
          profileLease: null,
          humanControlLease: null,
          resourceLeases: { none: {} },
        }),
      }),
    );
    const resourceLock = tx.$queryRaw.mock.calls[0]![0] as unknown as {
      values: unknown[];
    };
    expect(resourceLock.values).toContain("browser-execution-resources");
    expect(String(tx.$queryRaw.mock.calls[1]![0])).toContain("FOR UPDATE");
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.browserRuntimeSession.findUnique.mock.invocationCallOrder[0]!,
    );
    expect(tx.browserRuntimeArtifact.findMany).toHaveBeenCalledWith({
      select: { id: true, storageKey: true },
      where: {
        sessionId: "session-1",
        testRunArtifacts: { none: {} },
        verificationArtifacts: { none: {} },
        runEvidences: { none: {} },
      },
    });
    expect(tx.objectStorageDeletionTask.createMany).toHaveBeenCalledWith({
      data: [{ storageKey: "runtime/expired/screenshot" }],
      skipDuplicates: true,
    });
    expect(tx.browserRuntimeArtifact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["artifact-1"] } },
    });
    expect(tx.browserRuntimeSession.delete).not.toHaveBeenCalled();
    expect(tx.browserRuntimeSession.deleteMany).not.toHaveBeenCalled();
  });

  it("preserves artifacts referenced by unified Run evidence", async () => {
    const { tx, prisma, purge } = runtimeRetentionFixture();
    tx.browserRuntimeArtifact.findMany.mockImplementation(
      async (...args: unknown[]) => {
        const query = args[0] as { where: { runEvidences?: unknown } };
        // Model a row whose only reference is RunEvidence; omitting its filter
        // would return this artifact and schedule its object for deletion.
        return query.where.runEvidences
          ? []
          : [{ id: "run-evidence-artifact", storageKey: "runtime/shared" }];
      },
    );
    await purge();
    expect(prisma.browserRuntimeSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          artifacts: {
            some: expect.objectContaining({ runEvidences: { none: {} } }),
          },
        }),
      }),
    );
    expect(tx.objectStorageDeletionTask.createMany).not.toHaveBeenCalled();
    expect(tx.browserRuntimeArtifact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [] } },
    });
  });

  it("continues safe artifact retention after an earlier session transaction fails", async () => {
    const { prisma, tx, purge } = runtimeRetentionFixture();
    prisma.browserRuntimeSession.findMany.mockResolvedValueOnce([
      { id: "failed-session" },
      { id: "session-1" },
    ]);
    const failure = new Error("transaction failed");
    prisma.$transaction.mockRejectedValueOnce(failure);
    await expect(purge()).rejects.toMatchObject({
      message: "Runtime retention failed",
      errors: [failure],
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.browserRuntimeArtifact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["artifact-1"] } },
    });
    expect(tx.browserRuntimeSession.delete).not.toHaveBeenCalled();
    expect(tx.browserRuntimeSession.deleteMany).not.toHaveBeenCalled();
  });

  it("advances past retained candidates so later resolved sessions are not starved", async () => {
    const { prisma, tx, purge } = runtimeRetentionFixture();
    tx.runtimeSessionRecovery.findMany.mockResolvedValue([]);
    prisma.browserRuntimeSession.findMany.mockResolvedValueOnce(
      Array.from({ length: 20 }, (_, index) => ({
        id: `session-${String(index).padStart(2, "0")}`,
      })),
    );
    await purge();
    await purge();
    expect(
      prisma.browserRuntimeSession.findMany.mock.calls[1]![0],
    ).toMatchObject({
      where: { id: { gt: "session-19" } },
    });
    await purge();
    expect(
      prisma.browserRuntimeSession.findMany.mock.calls[2]![0],
    ).not.toHaveProperty("where.id");
  });

  it.each([
    ["data guard", { _count: { resourceLeases: 1, verificationRuns: 0 } }],
    ["slot", { slot: { id: "slot-1" } }],
    ["profile lease", { profileLease: { id: "profile-1" } }],
    ["human control lease", { humanControlLease: { id: "human-1" } }],
    ["identity permit", { identityPermit: 0 }],
    [
      "unpurged verification",
      { _count: { resourceLeases: 0, verificationRuns: 1 } },
    ],
    [
      "unverified historical CLOSED",
      { closureVerifiedAt: null, closureEvidenceId: null },
    ],
    ["timestamp without evidence", { closureEvidenceId: null }],
    ["FAILED session", { status: "FAILED" }],
    ["LOST session", { status: "LOST" }],
    ["not yet expired", { closedAt: new Date(Date.now() + 86_400_000) }],
  ])(
    "rechecks %s added or changed after the candidate scan",
    async (_label, changed) => {
      const { session, tx, purge } = runtimeRetentionFixture();
      tx.browserRuntimeSession.findUnique.mockResolvedValue({
        ...session,
        ...changed,
      });
      await purge();
      expect(tx.browserRuntimeArtifact.deleteMany).not.toHaveBeenCalled();
      expect(tx.objectStorageDeletionTask.createMany).not.toHaveBeenCalled();
      expect(tx.browserRuntimeSession.delete).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["different session", { sessionId: "other-session" }],
    ["different runtime", { runtimeId: "other-runtime" }],
    ["different fence", { sessionFence: 3n }],
    ["different lease", { leaseDigest: leaseDigest("other-lease") }],
    ["unverified evidence", { serverVerifiedAt: null }],
  ])(
    "retains artifacts when closure evidence has %s",
    async (_label, changed) => {
      const { evidence, tx, purge } = runtimeRetentionFixture();
      tx.sessionClosureEvidence.findUnique.mockResolvedValue({
        ...evidence,
        ...changed,
      });
      await purge();
      expect(tx.browserRuntimeArtifact.deleteMany).not.toHaveBeenCalled();
      expect(tx.objectStorageDeletionTask.createMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["UNKNOWN writes", { writeOutcomeState: "UNKNOWN" }],
    ["UNASSESSED writes", { writeOutcomeState: "UNASSESSED" }],
    ["unresolved recovery", { resolvedAt: null }],
    ["unverified recovery", { closureState: "REQUESTED" }],
    ["different evidence", { closureEvidenceId: "other-proof" }],
    ["different fence", { expectedSessionFence: 3n }],
    ["different lease", { expectedLeaseDigest: leaseDigest("other-lease") }],
  ])("preserves proof-backed sessions with %s", async (_label, changed) => {
    const { recovery, tx, purge } = runtimeRetentionFixture();
    tx.runtimeSessionRecovery.findMany.mockResolvedValue([
      { ...recovery, ...changed },
    ]);
    await purge();
    expect(tx.browserRuntimeArtifact.deleteMany).not.toHaveBeenCalled();
    expect(tx.objectStorageDeletionTask.createMany).not.toHaveBeenCalled();
  });

  it("preserves artifacts if an older recovery epoch remains unresolved", async () => {
    const { recovery, tx, purge } = runtimeRetentionFixture();
    tx.runtimeSessionRecovery.findMany.mockResolvedValue([
      recovery,
      {
        ...recovery,
        id: "old-recovery",
        expectedSessionFence: 3n,
        resolvedAt: null,
      },
    ]);
    await purge();
    expect(tx.browserRuntimeArtifact.deleteMany).not.toHaveBeenCalled();
  });

  it("requires persisted recovery and evidence rows, not only session status fields", async () => {
    const missingRecovery = runtimeRetentionFixture();
    missingRecovery.tx.runtimeSessionRecovery.findMany.mockResolvedValue([]);
    await missingRecovery.purge();
    expect(
      missingRecovery.tx.browserRuntimeArtifact.deleteMany,
    ).not.toHaveBeenCalled();
    const missingProof = runtimeRetentionFixture();
    missingProof.tx.sessionClosureEvidence.findUnique.mockResolvedValue(
      null as never,
    );
    await missingProof.purge();
    expect(
      missingProof.tx.browserRuntimeArtifact.deleteMany,
    ).not.toHaveBeenCalled();
  });
});
