import { describe, expect, it, vi } from "vitest";

import {
  findingFingerprint,
  PostRunAnalysisService,
  supersedePostRunAnalyses,
} from "./post-run-analysis.service.js";
import {
  POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD,
  POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD,
} from "./task-log-bundle.service.js";

vi.mock("../config/env.js", () => ({
  env: () => ({
    POST_RUN_ANALYSIS_ANALYZER_VERSION: "post-run-analysis-v2",
    POST_RUN_ANALYSIS_CAPTURE_GRACE_SECONDS: 0,
    POST_RUN_ANALYSIS_DEADLINE_SECONDS: 1_800,
    POST_RUN_ANALYSIS_ENABLED: true,
    POST_RUN_ANALYSIS_MAX_ATTEMPTS: 3,
    POST_RUN_ANALYSIS_RECOVERY_LOOKBACK_HOURS: 24,
  }),
}));

describe("findingFingerprint", () => {
  it("deduplicates semantically identical normalized findings", () => {
    const finding = {
      category: "TOOL_PROTOCOL",
      component: "Browser Runtime",
      rootCause: "The command response omits its terminal status.",
      title: "Missing terminal status",
    };

    expect(findingFingerprint(finding)).toBe(
      findingFingerprint({
        category: " tool_protocol ",
        component: "browser runtime",
        rootCause: "the command response omits its terminal status.",
        title: "missing terminal status",
      }),
    );
    expect(findingFingerprint(finding)).not.toBe(
      findingFingerprint({ ...finding, component: "Agent Runtime" }),
    );
    expect(
      findingFingerprint({
        ...finding,
        failureClass: "CONTEXT_WINDOW_EXCEEDED",
        phase: "POST_RUN_ANALYSIS.MODEL_INVOCATION",
      }),
    ).not.toBe(
      findingFingerprint({
        ...finding,
        failureClass: "COMMAND_TIMEOUT",
        phase: "SPEC_EXECUTION.BROWSER_COMMAND",
      }),
    );
  });
});

describe("PostRunAnalysisService", () => {
  it("recovers the current task generation even when older analyses exist", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const transactionClient = {
      postRunAnalysisJob: { createMany },
      taskExecution: {
        findUnique: vi.fn().mockResolvedValue({
          kind: "ISSUE_SPEC",
          postRunAnalysisGeneration: 2,
          teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
        }),
      },
    };
    const queryRaw = vi.fn().mockResolvedValue([
      {
        generation: 2,
        id: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
        kind: "ISSUE_SPEC",
        teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
      },
    ]);
    const service = new PostRunAnalysisService(
      {
        $queryRaw: queryRaw,
        $transaction: vi.fn(
          (operation: (tx: typeof transactionClient) => unknown) =>
            operation(transactionClient),
        ),
      } as never,
      {} as never,
      {} as never,
    );

    await expect(
      (
        service as unknown as {
          recoverMissingJobs(limit: number): Promise<number>;
        }
      ).recoverMissingJobs(20),
    ).resolves.toBe(1);

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          generation: 2,
          taskExecutionId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("cancels an active prior generation and queues its capture objects", async () => {
    const updatedAt = new Date("2026-08-27T12:00:00.000Z");
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const createEvent = vi.fn().mockResolvedValue({});
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      objectStorageDeletionTask: { createMany },
      postRunAnalysisEvent: { create: createEvent },
      postRunAnalysisJob: {
        findMany: vi.fn().mockResolvedValue([
          {
            captureEvidenceStorageKey: "analysis/old.evidence.ndjson",
            captureStorageKey: "analysis/old.json",
            id: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
            status: "CAPTURING",
            updatedAt,
          },
        ]),
        updateMany,
      },
    };

    await supersedePostRunAnalyses(tx as never, {
      taskExecutionId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
      teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
        where: expect.objectContaining({
          status: "CAPTURING",
          updatedAt,
        }),
      }),
    );
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { storageKey: "analysis/old.json" },
        { storageKey: "analysis/old.evidence.ndjson" },
      ],
      skipDuplicates: true,
    });
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "analysis.superseded" }),
      }),
    );
  });

  it("returns analysis events incrementally after the requested sequence", async () => {
    const occurredAt = new Date("2026-08-27T12:00:00.000Z");
    const events = Array.from({ length: 201 }, (_, index) => ({
      actor: "AGENT_RUNTIME",
      kind: "analysis.model.completed",
      occurredAt,
      payload: {},
      sequence: BigInt(index + 11),
    }));
    const findFirst = vi.fn().mockResolvedValue({
      analyzerVersion: "post-run-analysis-v2",
      attemptNumber: 1,
      createdAt: occurredAt,
      error: null,
      events,
      findings: [],
      finishedAt: null,
      generation: 1,
      id: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
      inputByteSize: 1_024,
      inputCompleteness: {},
      inputSha256: "a".repeat(64),
      maxAttempts: 3,
      startedAt: occurredAt,
      status: "RUNNING",
      updatedAt: occurredAt,
      workItem: null,
    });
    const service = new PostRunAnalysisService(
      { postRunAnalysisJob: { findFirst } } as never,
      {} as never,
      {} as never,
    );

    const detail = await service.detail(
      { team: { id: "6f090d88-8987-487f-8338-1a734beab6a6" } } as never,
      "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
      { afterSequence: "10" },
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          events: expect.objectContaining({
            orderBy: { sequence: "asc" },
            take: 201,
            where: { sequence: { gt: 10n } },
          }),
        }),
      }),
    );
    expect(findFirst.mock.calls[0]?.[0].select).not.toHaveProperty(
      "inputManifest",
    );
    expect(findFirst.mock.calls[0]?.[0].select).not.toHaveProperty("result");
    expect(detail).toMatchObject({
      eventCursor: "210",
      eventsHasMore: true,
      eventsTruncated: false,
    });
    expect(detail?.events).toHaveLength(200);
  });

  it("retries only the terminal snapshot read inside the transaction", async () => {
    const currentJob = {
      attemptNumber: 3,
      captureEvidenceStorageKey: null,
      captureStorageKey: null,
      id: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
      inputStorageKey: "post-run-analysis/bundle.json",
      maxAttempts: 3,
      status: "FAILED",
      teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn().mockResolvedValue({});
    const transactionClient = {
      postRunAnalysisEvent: { create },
      postRunAnalysisJob: {
        findFirst: vi.fn().mockResolvedValue(currentJob),
        updateMany,
      },
    };
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({
        generation: 1,
        id: currentJob.id,
        taskExecution: {
          kind: "ISSUE_SPEC",
          lifecycle: "COMPLETED",
          postRunAnalysisGeneration: 1,
        },
      })
      .mockResolvedValueOnce(null);
    const prisma = {
      $transaction: vi
        .fn()
        .mockImplementation(
          (operation: (tx: typeof transactionClient) => unknown) =>
            operation(transactionClient),
        ),
      postRunAnalysisJob: { findFirst },
    };
    const service = new PostRunAnalysisService(
      prisma as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.retry(
        {
          team: { id: currentJob.teamId },
        } as never,
        "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
      ),
    ).resolves.toBeNull();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ maxAttempts: 4, status: "READY" }),
        where: {
          attemptNumber: currentJob.attemptNumber,
          captureEvidenceStorageKey: null,
          captureStorageKey: null,
          id: currentJob.id,
          inputStorageKey: currentJob.inputStorageKey,
          maxAttempts: currentJob.maxAttempts,
          status: currentJob.status,
          teamId: currentJob.teamId,
        },
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "analysis.retry_requested" }),
      }),
    );
  });

  it("rejects a retry when a concurrent worker changes the terminal snapshot", async () => {
    const currentJob = {
      attemptNumber: 2,
      captureEvidenceStorageKey: null,
      captureStorageKey: null,
      id: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
      inputStorageKey: "post-run-analysis/bundle.json",
      maxAttempts: 3,
      status: "FAILED",
      teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
    };
    const transactionClient = {
      postRunAnalysisEvent: { create: vi.fn() },
      postRunAnalysisJob: {
        findFirst: vi.fn().mockResolvedValue(currentJob),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const service = new PostRunAnalysisService(
      {
        $transaction: vi
          .fn()
          .mockImplementation(
            (operation: (tx: typeof transactionClient) => unknown) =>
              operation(transactionClient),
          ),
        postRunAnalysisJob: {
          findFirst: vi.fn().mockResolvedValue({
            generation: 1,
            id: currentJob.id,
            taskExecution: {
              kind: "ISSUE_SPEC",
              lifecycle: "COMPLETED",
              postRunAnalysisGeneration: 1,
            },
          }),
        },
      } as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.retry(
        { team: { id: currentJob.teamId } } as never,
        "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
      ),
    ).rejects.toThrow(/changed while the retry was requested/u);

    expect(
      transactionClient.postRunAnalysisEvent.create,
    ).not.toHaveBeenCalled();
  });

  it("rejects retrying an analysis from a superseded task generation", async () => {
    const transaction = vi.fn();
    const service = new PostRunAnalysisService(
      {
        $transaction: transaction,
        postRunAnalysisJob: {
          findFirst: vi.fn().mockResolvedValue({
            generation: 1,
            id: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
            taskExecution: {
              kind: "ISSUE_SPEC",
              lifecycle: "COMPLETED",
              postRunAnalysisGeneration: 2,
            },
          }),
        },
      } as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.retry(
        {
          team: { id: "6f090d88-8987-487f-8338-1a734beab6a6" },
        } as never,
        "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
      ),
    ).rejects.toThrow(/current terminal task generation/u);

    expect(transaction).not.toHaveBeenCalled();
  });

  it("queues durable bundle cleanup when the database transaction fails", async () => {
    const databaseError = new Error("database unavailable");
    const queueDeletions = vi.fn().mockResolvedValue({ count: 2 });
    const transactionClient = {
      objectStorageDeletionTask: { createMany: queueDeletions },
      postRunAnalysisEvent: { create: vi.fn().mockResolvedValue({}) },
      postRunAnalysisJob: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    let transactionCall = 0;
    const storage = {
      delete: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue({
        byteSize: 128,
        sha256: "a".repeat(64),
      }),
    };
    const service = new PostRunAnalysisService(
      {
        $transaction: vi.fn(
          async (operation: (tx: typeof transactionClient) => unknown) => {
            transactionCall += 1;
            if (transactionCall === 2) throw databaseError;
            return operation(transactionClient);
          },
        ),
        postRunAnalysisJob: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      } as never,
      {
        build: vi.fn().mockResolvedValue({
          body: Buffer.from("{}"),
          completeness: {},
          evidenceBody: Buffer.from("{}\n"),
          evidenceIndex: {},
          manifest: {},
          schemaVersion: "devproof.task-logs.v2",
        }),
      } as never,
      storage as never,
    );
    const job = {
      captureEvidenceStorageKey: null,
      captureStorageKey: null,
      id: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
      status: "PENDING_CAPTURE",
      taskExecution: {
        executionRuns: [{ browserExecutions: [{ status: "RELEASED" }] }],
        finishedAt: new Date(),
        lifecycle: "COMPLETED",
      },
      taskExecutionId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
      teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
      updatedAt: new Date("2026-08-27T12:00:00.000Z"),
    };

    await expect(
      (
        service as unknown as {
          captureReady(value: typeof job): Promise<boolean>;
        }
      ).captureReady(job),
    ).rejects.toThrow(databaseError);

    expect(queueDeletions).toHaveBeenCalledWith({
      data: [
        { storageKey: expect.stringContaining("post-run-analysis/") },
        { storageKey: expect.stringMatching(/\.evidence\.ndjson$/u) },
      ],
      skipDuplicates: true,
    });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("keeps a failed first upload recoverable through durable cleanup", async () => {
    const uploadError = new Error("ambiguous object upload");
    const queueDeletions = vi.fn().mockResolvedValue({ count: 2 });
    const transactionClient = {
      objectStorageDeletionTask: { createMany: queueDeletions },
      postRunAnalysisEvent: { create: vi.fn().mockResolvedValue({}) },
      postRunAnalysisJob: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new PostRunAnalysisService(
      {
        $transaction: vi.fn(
          (operation: (tx: typeof transactionClient) => unknown) =>
            operation(transactionClient),
        ),
        postRunAnalysisJob: { findFirst: vi.fn().mockResolvedValue(null) },
      } as never,
      {
        build: vi.fn().mockResolvedValue({
          body: Buffer.from("{}"),
          completeness: {},
          evidenceBody: Buffer.from("{}\n"),
          evidenceIndex: {},
          manifest: {},
          schemaVersion: "devproof.task-logs.v2",
        }),
      } as never,
      { put: vi.fn().mockRejectedValue(uploadError) } as never,
    );
    const job = {
      captureEvidenceStorageKey: null,
      captureStorageKey: null,
      id: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
      status: "PENDING_CAPTURE",
      taskExecution: {
        executionRuns: [{ browserExecutions: [{ status: "RELEASED" }] }],
        finishedAt: new Date(),
        lifecycle: "COMPLETED",
      },
      taskExecutionId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
      teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
      updatedAt: new Date("2026-08-27T12:00:00.000Z"),
    };

    await expect(
      (
        service as unknown as {
          captureReady(value: typeof job): Promise<boolean>;
        }
      ).captureReady(job),
    ).rejects.toThrow(uploadError);

    expect(queueDeletions).toHaveBeenCalledWith({
      data: [
        { storageKey: expect.stringContaining("post-run-analysis/") },
        { storageKey: expect.stringMatching(/\.evidence\.ndjson$/u) },
      ],
      skipDuplicates: true,
    });
  });

  it("preserves a bundle when a rejected transaction actually committed it", async () => {
    const databaseError = new Error("transaction response was lost");
    const storage = {
      delete: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockImplementation(async (storageKey: string) => ({
        byteSize: 128,
        sha256: "a".repeat(64),
        storageKey,
      })),
    };
    const findFirst = vi.fn().mockImplementation(async () => ({
      inputStorageKey: storage.put.mock.calls[0]?.[0] as string,
    }));
    const transactionClient = {
      objectStorageDeletionTask: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      postRunAnalysisEvent: { create: vi.fn().mockResolvedValue({}) },
      postRunAnalysisJob: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    let transactionCall = 0;
    const service = new PostRunAnalysisService(
      {
        $transaction: vi.fn(
          async (operation: (tx: typeof transactionClient) => unknown) => {
            transactionCall += 1;
            if (transactionCall === 2) throw databaseError;
            return operation(transactionClient);
          },
        ),
        postRunAnalysisJob: {
          findFirst,
        },
      } as never,
      {
        build: vi.fn().mockResolvedValue({
          body: Buffer.from("{}"),
          completeness: {},
          evidenceBody: Buffer.from("{}\n"),
          evidenceIndex: {},
          manifest: {},
          schemaVersion: "devproof.task-logs.v2",
        }),
      } as never,
      storage as never,
    );
    const job = {
      captureEvidenceStorageKey: null,
      captureStorageKey: null,
      id: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
      status: "PENDING_CAPTURE",
      taskExecution: {
        executionRuns: [{ browserExecutions: [{ status: "RELEASED" }] }],
        finishedAt: new Date(),
        lifecycle: "COMPLETED",
      },
      taskExecutionId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
      teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
      updatedAt: new Date("2026-08-27T12:00:00.000Z"),
    };

    await expect(
      (
        service as unknown as {
          captureReady(value: typeof job): Promise<boolean>;
        }
      ).captureReady(job),
    ).resolves.toBe(true);

    expect(findFirst).toHaveBeenCalledWith({
      select: { inputStorageKey: true },
      where: { id: job.id },
    });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("lets only one API replica build and upload a capture candidate", async () => {
    const claim = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const persist = vi.fn().mockResolvedValue({ count: 1 });
    const createEvent = vi.fn().mockResolvedValue({});
    const updateMany = vi.fn(async (input: { data: { status: string } }) =>
      input.data.status === "CAPTURING" ? claim() : persist(input),
    );
    const transactionClient = {
      objectStorageDeletionTask: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      postRunAnalysisEvent: { create: createEvent },
      postRunAnalysisJob: { updateMany },
    };
    const prisma = {
      $transaction: vi
        .fn()
        .mockImplementation(
          (operation: (tx: typeof transactionClient) => unknown) =>
            operation(transactionClient),
        ),
    };
    const evidenceIndex = {
      "browser-command://command-1": {
        byteSize: 42,
        offset: 0,
        sha256: "b".repeat(64),
      },
    };
    const build = vi.fn().mockResolvedValue({
      body: Buffer.from("{}"),
      completeness: { durableEvents: true },
      evidenceBody: Buffer.from("{}\n"),
      evidenceIndex,
      manifest: { evidenceRefs: ["browser-command://command-1"] },
      schemaVersion: "devproof.task-logs.v2",
    });
    const storage = {
      delete: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue({
        byteSize: 128,
        sha256: "a".repeat(64),
      }),
    };
    const service = new PostRunAnalysisService(
      prisma as never,
      { build } as never,
      storage as never,
    );
    const job = {
      captureEvidenceStorageKey: null,
      captureStorageKey: null,
      id: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
      status: "PENDING_CAPTURE",
      taskExecution: {
        executionRuns: [{ browserExecutions: [{ status: "RELEASED" }] }],
        finishedAt: new Date(),
        lifecycle: "COMPLETED",
      },
      taskExecutionId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
      teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
      updatedAt: new Date("2026-08-27T12:00:00.000Z"),
    };
    const capture = (value: typeof job) =>
      (
        service as unknown as {
          captureReady(candidate: typeof job): Promise<boolean>;
        }
      ).captureReady(value);

    await expect(Promise.all([capture(job), capture(job)])).resolves.toEqual([
      true,
      false,
    ]);

    expect(build).toHaveBeenCalledOnce();
    expect(storage.put).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          captureEvidenceStorageKey:
            expect.stringMatching(/\.evidence\.ndjson$/u),
          captureStorageKey: expect.stringContaining("post-run-analysis/"),
          status: "CAPTURING",
        }),
      }),
    );
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          inputManifest: expect.objectContaining({
            [POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD]: evidenceIndex,
            [POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD]:
              expect.stringMatching(/\.evidence\.ndjson$/u),
          }),
          status: "READY",
        }),
        where: expect.objectContaining({ status: "CAPTURING" }),
      }),
    );
    expect(createEvent).toHaveBeenCalledOnce();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("terminalizes an expired lease after the attempt budget is exhausted", async () => {
    const maxAttemptsField = { field: "maxAttempts" };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const createEvent = vi.fn().mockResolvedValue({});
    const transactionClient = {
      postRunAnalysisEvent: { create: createEvent },
      postRunAnalysisJob: { updateMany },
    };
    const prisma = {
      $transaction: vi
        .fn()
        .mockImplementation(
          (operation: (tx: typeof transactionClient) => unknown) =>
            operation(transactionClient),
        ),
      postRunAnalysisJob: {
        fields: { maxAttempts: maxAttemptsField },
        findMany: vi.fn().mockResolvedValue([
          {
            attemptNumber: 3,
            id: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
            maxAttempts: 3,
            status: "RUNNING",
            teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
          },
        ]),
      },
    };
    const service = new PostRunAnalysisService(
      prisma as never,
      {} as never,
      {} as never,
    );

    await expect(
      (
        service as unknown as {
          failExhaustedAttempts(limit: number): Promise<number>;
        }
      ).failExhaustedAttempts(20),
    ).resolves.toBe(1);

    expect(prisma.postRunAnalysisJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          attemptNumber: { gte: maxAttemptsField },
        }),
      }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "analysis.attempts_exhausted",
        }),
      }),
    );
  });
});
