import { describe, expect, it, vi } from "vitest";

import { POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD } from "../post-run-analysis/task-log-bundle.service.js";
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
