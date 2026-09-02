import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD,
  POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD,
} from "../post-run-analysis/task-log-bundle.service.js";

import {
  compactInlineManifest,
  PostRunAnalysisRuntimeService,
  validateFindingRuntimeLocations,
} from "./post-run-analysis-runtime.service.js";

vi.mock("../config/env.js", () => ({
  env: () => ({
    AGENT_RUNTIME_TASK_LEASE_SECONDS: 60,
    POST_RUN_ANALYSIS_DEADLINE_SECONDS: 1_800,
    POST_RUN_ANALYSIS_ENABLED: true,
    POST_RUN_ANALYSIS_MIN_CONFIDENCE: 0.75,
    POST_RUN_ANALYSIS_RETRY_BACKOFF_SECONDS: 30,
  }),
}));

const teamId = "6f090d88-8987-487f-8338-1a734beab6a6";
const analysisId = "cc61de8d-cf29-4561-b2cd-c67c304668a5";
const taskExecutionId = "9be3dc23-9a52-4a97-b6ca-6df0af16d815";
const lease = {
  fencingToken: "3",
  leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
  workerId: "worker-1",
};

function createService(contentType = "application/json") {
  const records = new Map<string, Buffer>([
    [
      "artifact://console-log",
      Buffer.from(
        JSON.stringify({
          evidenceRef: "artifact://console-log",
          externalId: "artifact://console-log",
          runtimeArtifact: { contentType },
        }),
      ),
    ],
    [
      "browser-command://command-1",
      Buffer.from(
        JSON.stringify({
          error: { code: "CLICK_FAILED" },
          evidenceRef: "browser-command://command-1",
          status: "FAILED",
        }),
      ),
    ],
    [
      "browser-event://event-1",
      Buffer.from(
        JSON.stringify({
          evidenceRef: "browser-event://event-1",
          kind: "page.console.error",
        }),
      ),
    ],
  ]);
  const evidenceIndex: Record<
    string,
    { byteSize: number; offset: number; sha256: string }
  > = {};
  const archiveChunks: Buffer[] = [];
  let archiveOffset = 0;
  for (const [evidenceRef, body] of records) {
    evidenceIndex[evidenceRef] = {
      byteSize: body.byteLength,
      offset: archiveOffset,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
    archiveChunks.push(body, Buffer.from("\n"));
    archiveOffset += body.byteLength + 1;
  }
  const archive = Buffer.concat(archiveChunks);
  const job = {
    fencingToken: 3n,
    id: analysisId,
    inputByteSize: 10,
    inputManifest: {
      evidenceRefs: [
        "artifact://console-log",
        "browser-command://command-1",
        "browser-event://event-1",
      ],
      [POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD]: evidenceIndex,
      [POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD]:
        "analysis/evidence.ndjson",
    },
    inputSha256: "a".repeat(64),
    inputStorageKey: "analysis/bundle.json",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leaseOwner: lease.workerId,
    leaseToken: lease.leaseToken,
    status: "RUNNING",
    taskExecutionId,
    teamId,
  };
  const prisma = {
    postRunAnalysisEvent: { create: vi.fn().mockResolvedValue({}) },
    postRunAnalysisJob: { findFirst: vi.fn().mockResolvedValue(job) },
    runEvidence: {
      findFirst: vi.fn().mockResolvedValue({
        externalId: "artifact://console-log",
        runtimeArtifact: {
          byteSize: 34,
          contentType,
          sha256: "b".repeat(64),
          storageKey: "artifacts/console-log.json",
        },
      }),
    },
  };
  const storage = {
    get: vi
      .fn()
      .mockImplementation(
        async (storageKey: string, range?: { end: number; start: number }) => {
          if (storageKey === "analysis/evidence.ndjson") {
            if (!range)
              throw new Error("Structured evidence requires a range.");
            return {
              body: archive.subarray(range.start, range.end + 1),
              contentType: "application/x-ndjson",
            };
          }
          return {
            body: Buffer.from('{"token":"secret-value","ok":true}'),
            contentType,
          };
        },
      ),
  };
  return {
    prisma,
    service: new PostRunAnalysisRuntimeService(
      prisma as never,
      {} as never,
      storage as never,
    ),
    storage,
  };
}

describe("PostRunAnalysisRuntimeService evidence tools", () => {
  it("reads only a text artifact linked to the leased task and redacts its body", async () => {
    const { prisma, service, storage } = createService();

    const output = await service.executeTool(teamId, analysisId, {
      ...lease,
      analysisSummary: "读取控制台日志。",
      cursor: 0,
      evidenceRef: "artifact://console-log",
      maxBytes: 32_000,
      name: "read_analysis_evidence",
    });

    expect(prisma.runEvidence.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          externalId: "artifact://console-log",
          run: { taskExecutionId },
          teamId,
        },
      }),
    );
    expect(storage.get).toHaveBeenCalledWith("artifacts/console-log.json");
    expect(output).toMatchObject({
      contentType: "application/json",
      evidenceRef: "artifact://console-log",
      nextCursor: null,
    });
    expect(JSON.parse(output.body)).toEqual({
      ok: true,
      token: "[REDACTED]",
    });
    expect(prisma.postRunAnalysisEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor: "CONTROL_PLANE",
        analysisId,
        kind: "analysis.evidence.served",
        payload: expect.objectContaining({
          evidenceRef: "artifact://console-log",
          fencingToken: lease.fencingToken,
        }),
        teamId,
      }),
    });
  });

  it("caches a redacted text artifact across pages and permits a targeted jump", async () => {
    const { service, storage } = createService("text/plain");
    storage.get.mockResolvedValue({
      body: Buffer.from("开".repeat(4_000)),
      contentType: "text/plain",
    });

    const first = await service.executeTool(teamId, analysisId, {
      ...lease,
      analysisSummary: "读取日志开头并确认总长度。",
      cursor: 0,
      evidenceRef: "artifact://console-log",
      maxBytes: 1_024,
      name: "read_analysis_evidence",
    });
    const jumped = await service.executeTool(teamId, analysisId, {
      ...lease,
      analysisSummary: "定点读取日志尾部附近。",
      cursor: 9_001,
      evidenceRef: "artifact://console-log",
      maxBytes: 1_024,
      name: "read_analysis_evidence",
    });

    expect(first.nextCursor).not.toBeNull();
    expect(jumped.body).not.toContain("�");
    expect(storage.get).toHaveBeenCalledOnce();
    expect(storage.get).toHaveBeenCalledWith("artifacts/console-log.json");
  });

  it("returns bundle metadata instead of downloading a non-text artifact", async () => {
    const { service, storage } = createService("image/png");

    const output = await service.executeTool(teamId, analysisId, {
      ...lease,
      analysisSummary: "读取截图元数据。",
      cursor: 0,
      evidenceRef: "artifact://console-log",
      maxBytes: 32_000,
      name: "read_analysis_evidence",
    });

    expect(storage.get).toHaveBeenCalledWith(
      "analysis/evidence.ndjson",
      expect.objectContaining({ start: 0 }),
    );
    expect(output).toMatchObject({
      contentType: "application/vnd.devproof.evidence+json",
      evidenceRef: "artifact://console-log",
      nextCursor: null,
    });
    expect(JSON.parse(output.body)).toMatchObject({
      evidenceRef: "artifact://console-log",
      runtimeArtifact: { contentType: "image/png" },
    });
  });

  it("reads one structured runtime record by evidenceRef", async () => {
    const { prisma, service } = createService();
    prisma.runEvidence.findFirst.mockResolvedValue(null);

    const output = await service.executeTool(teamId, analysisId, {
      ...lease,
      analysisSummary: "核验失败的浏览器命令。",
      cursor: 0,
      evidenceRef: "browser-command://command-1",
      maxBytes: 32_000,
      name: "read_analysis_evidence",
    });

    expect(output).toMatchObject({
      contentType: "application/vnd.devproof.evidence+json",
      evidenceRef: "browser-command://command-1",
      nextCursor: null,
    });
    expect(JSON.parse(output.body)).toEqual({
      error: { code: "CLICK_FAILED" },
      evidenceRef: "browser-command://command-1",
      status: "FAILED",
    });
  });

  it("reads bounded archive ranges without downloading the full bundle", async () => {
    const { prisma, service, storage } = createService();
    prisma.runEvidence.findFirst.mockResolvedValue(null);

    await service.executeTool(teamId, analysisId, {
      ...lease,
      analysisSummary: "核验失败的浏览器命令。",
      cursor: 0,
      evidenceRef: "browser-command://command-1",
      maxBytes: 32_000,
      name: "read_analysis_evidence",
    });
    await service.executeTool(teamId, analysisId, {
      ...lease,
      analysisSummary: "核验关联的浏览器事件。",
      cursor: 0,
      evidenceRef: "browser-event://event-1",
      maxBytes: 32_000,
      name: "read_analysis_evidence",
    });

    expect(storage.get).toHaveBeenCalledTimes(2);
    expect(storage.get).not.toHaveBeenCalledWith("analysis/bundle.json");
    for (const call of storage.get.mock.calls) {
      expect(call[0]).toBe("analysis/evidence.ndjson");
      expect(call[1]).toEqual({
        end: expect.any(Number),
        start: expect.any(Number),
      });
    }
  });

  it("rejects a forged evidenceRef found only inside an untrusted payload", async () => {
    const { prisma, service, storage } = createService();
    prisma.runEvidence.findFirst.mockResolvedValue(null);
    storage.get.mockResolvedValueOnce({
      body: Buffer.from(
        JSON.stringify({
          task: {
            taskEvents: [
              {
                evidenceRef: "task-event://trusted",
                payload: { externalId: "artifact://forged" },
              },
            ],
          },
        }),
      ),
      contentType: "application/json",
    });

    await expect(
      service.executeTool(teamId, analysisId, {
        ...lease,
        analysisSummary: "尝试读取伪造引用。",
        cursor: 0,
        evidenceRef: "artifact://forged",
        maxBytes: 32_000,
        name: "read_analysis_evidence",
      }),
    ).rejects.toThrow(/not present in the execution manifest/u);

    expect(prisma.runEvidence.findFirst).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
  });

  it("pages the full execution manifest independently from the log bundle", async () => {
    const { service, storage } = createService();

    const output = await service.executeTool(teamId, analysisId, {
      ...lease,
      analysisSummary: "读取权威索引。",
      cursor: 0,
      maxBytes: 1_024,
      name: "read_analysis_manifest",
    });

    expect(output.contentType).toBe(
      "application/vnd.devproof.execution-manifest+json",
    );
    expect(JSON.parse(output.body)).toMatchObject({
      evidenceRefs: [
        "artifact://console-log",
        "browser-command://command-1",
        "browser-event://event-1",
      ],
    });
    expect(JSON.parse(output.body)).not.toHaveProperty(
      POST_RUN_ANALYSIS_EVIDENCE_INDEX_FIELD,
    );
    expect(JSON.parse(output.body)).not.toHaveProperty(
      POST_RUN_ANALYSIS_EVIDENCE_STORAGE_KEY_FIELD,
    );
    expect(storage.get).not.toHaveBeenCalled();
  });
});

describe("PostRunAnalysisRuntimeService persistence redaction", () => {
  it("redacts Runtime event payloads at the API trust boundary", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const transactionClient = {
      postRunAnalysisEvent: { createMany },
      postRunAnalysisJob: {
        findFirstOrThrow: vi.fn().mockResolvedValue({
          deadlineAt: new Date(Date.now() + 60_000),
          fencingToken: 3n,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseOwner: lease.workerId,
          leaseToken: lease.leaseToken,
          status: "RUNNING",
        }),
      },
    };
    const service = new PostRunAnalysisRuntimeService(
      {
        $transaction: vi
          .fn()
          .mockImplementation(
            (operation: (tx: typeof transactionClient) => unknown) =>
              operation(transactionClient),
          ),
      } as never,
      {} as never,
      {} as never,
    );

    await service.appendEvent(teamId, analysisId, {
      ...lease,
      event: {
        eventId: "716f2dcb-85ab-4fb7-a11d-350c2f85cc53",
        kind: "analysis.model.failed",
        occurredAt: new Date().toISOString(),
        payload: {
          authorization: "Bearer runtime-secret",
          errorMessage: "provider failed with token=provider-secret",
          profile: { key: "profile-secret" },
        },
      },
    });

    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          payload: {
            authorization: "[REDACTED]",
            errorMessage: "provider failed with token=[REDACTED]",
            profile: { key: "[REDACTED]" },
          },
        }),
      ],
      skipDuplicates: true,
    });
  });
});

describe("PostRunAnalysisRuntimeService claims", () => {
  it("starts a full execution window when queued work is claimed", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-01T05:40:00.000Z");
    vi.setSystemTime(now);
    const readyAt = new Date(now.getTime() - 20 * 60_000);
    const hardDeadlineAt = new Date(now.getTime() + 2 * 60 * 60_000);
    let claimedData: Record<string, unknown> = {};
    const findFirst = vi.fn().mockResolvedValue({
      hardDeadlineAt,
      id: analysisId,
      readyAt,
      startedAt: null,
      status: "READY",
    });
    const create = vi.fn().mockResolvedValue({});
    const transactionClient = {
      postRunAnalysisEvent: { create },
      postRunAnalysisJob: {
        fields: { maxAttempts: { field: "maxAttempts" } },
        findFirst,
        findUniqueOrThrow: vi.fn().mockImplementation(() => ({
          analyzerVersion: "post-run-analysis-v3",
          attemptNumber: 1,
          deadlineAt: claimedData.deadlineAt,
          fencingToken: 1n,
          hardDeadlineAt,
          id: analysisId,
          inputByteSize: 17_205_500,
          inputCompleteness: {},
          inputManifest: {},
          inputSha256: "a".repeat(64),
          inputStorageKey: "analysis/bundle.json",
          leaseExpiresAt: claimedData.leaseExpiresAt,
          leaseToken: claimedData.leaseToken,
          taskExecution: {
            sourceRef: "PROD-6754",
            title: "offlineAt clear regression",
            traceId: "1".repeat(32),
          },
          taskExecutionId,
        })),
        updateMany: vi.fn().mockImplementation(({ data }) => {
          claimedData = data;
          return { count: 1 };
        }),
      },
    };
    const service = new PostRunAnalysisRuntimeService(
      {
        $transaction: vi.fn(
          (operation: (tx: typeof transactionClient) => unknown) =>
            operation(transactionClient),
        ),
      } as never,
      {
        candidatesForPool: vi.fn().mockResolvedValue([
          {
            apiKey: "secret",
            baseUrl: "https://gateway.example.com/v1",
            displayName: "test",
            modelId: "gpt-test",
          },
        ]),
      } as never,
      {} as never,
    );

    try {
      const result = await service.claim(teamId, {
        protocol: { minor: 7 },
        workerId: lease.workerId,
      });

      expect(result.task?.snapshot.deadlineAt).toBe("2026-09-01T06:10:00.000Z");
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { attemptNumber: "asc" },
            { readyAt: "asc" },
            { createdAt: "asc" },
          ],
          where: expect.objectContaining({
            hardDeadlineAt: { gt: now },
          }),
        }),
      );
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: "analysis.started",
            payload: expect.objectContaining({ queueWaitMs: 1_200_000 }),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminalizes a ready job without consuming an attempt when no model is configured", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn().mockResolvedValue({});
    const transactionClient = {
      postRunAnalysisEvent: { create },
      postRunAnalysisJob: {
        findFirst: vi.fn().mockResolvedValue({ id: analysisId }),
        updateMany,
      },
    };
    const prisma = {
      $transaction: vi
        .fn()
        .mockImplementation(
          (operation: (tx: typeof transactionClient) => unknown) =>
            operation(transactionClient),
        ),
    };
    const service = new PostRunAnalysisRuntimeService(
      prisma as never,
      { candidatesForPool: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
    );

    await expect(
      service.claim(teamId, {
        protocol: { minor: 7 },
        workerId: lease.workerId,
      }),
    ).resolves.toEqual({ task: null });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: expect.objectContaining({
            code: "MODEL_PROVIDER_NOT_CONFIGURED",
          }),
          status: "FAILED",
        }),
      }),
    );
    expect(updateMany.mock.calls[0]?.[0].data).not.toHaveProperty(
      "attemptNumber",
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "analysis.configuration_failed",
        }),
      }),
    );
  });

  it("does not claim a job after its configured attempt budget", async () => {
    const maxAttemptsField = { field: "maxAttempts" };
    const findFirst = vi.fn().mockResolvedValue(null);
    const transactionClient = {
      postRunAnalysisJob: {
        fields: { maxAttempts: maxAttemptsField },
        findFirst,
      },
    };
    const prisma = {
      $transaction: vi
        .fn()
        .mockImplementation(
          (operation: (tx: typeof transactionClient) => unknown) =>
            operation(transactionClient),
        ),
    };
    const models = {
      candidatesForPool: vi.fn().mockResolvedValue([
        {
          apiKey: "secret",
          baseUrl: "https://gateway.example.com/v1",
          displayName: "test",
          modelId: "gpt-test",
        },
      ]),
    };
    const service = new PostRunAnalysisRuntimeService(
      prisma as never,
      models as never,
      {} as never,
    );

    await expect(
      service.claim(teamId, {
        protocol: { minor: 7 },
        workerId: lease.workerId,
      }),
    ).resolves.toEqual({ task: null });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          attemptNumber: { lt: maxAttemptsField },
        }),
      }),
    );
  });
});

describe("PostRunAnalysisRuntimeService lease hot paths", () => {
  it("renews a heartbeat without hydrating the analysis manifest", async () => {
    const findFirstOrThrow = vi.fn().mockResolvedValue({
      deadlineAt: new Date(Date.now() + 60_000),
      fencingToken: 3n,
      leaseExpiresAt: new Date(Date.now() + 30_000),
      leaseOwner: lease.workerId,
      leaseToken: lease.leaseToken,
      status: "RUNNING",
    });
    const transactionClient = {
      postRunAnalysisJob: {
        findFirstOrThrow,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new PostRunAnalysisRuntimeService(
      {
        $transaction: vi
          .fn()
          .mockImplementation(
            (operation: (tx: typeof transactionClient) => unknown) =>
              operation(transactionClient),
          ),
      } as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.heartbeat(teamId, analysisId, lease),
    ).resolves.toMatchObject({ directive: "CONTINUE" });

    expect(findFirstOrThrow).toHaveBeenCalledWith({
      select: {
        deadlineAt: true,
        fencingToken: true,
        leaseExpiresAt: true,
        leaseOwner: true,
        leaseToken: true,
        status: true,
      },
      where: { id: analysisId, teamId },
    });
  });
});

describe("PostRunAnalysisRuntimeService retries", () => {
  it("backs off a retryable failure without consuming the hard deadline", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-01T05:31:03.000Z");
    vi.setSystemTime(now);
    const hardDeadlineAt = new Date("2026-09-01T07:18:19.000Z");
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn().mockResolvedValue({});
    const transactionClient = {
      postRunAnalysisEvent: { create },
      postRunAnalysisJob: { updateMany },
    };
    const service = new PostRunAnalysisRuntimeService(
      {
        $transaction: vi.fn(
          (operation: (tx: typeof transactionClient) => unknown) =>
            operation(transactionClient),
        ),
      } as never,
      {} as never,
      {} as never,
    );

    try {
      const result = await (
        service as unknown as {
          fail(
            currentTeamId: string,
            job: Record<string, unknown>,
            completionId: string,
            outcome: Record<string, unknown>,
          ): Promise<unknown>;
        }
      ).fail(
        teamId,
        {
          attemptNumber: 2,
          fencingToken: 3n,
          hardDeadlineAt,
          id: analysisId,
          leaseExpiresAt: new Date(now.getTime() + 60_000),
          leaseOwner: lease.workerId,
          leaseToken: lease.leaseToken,
          maxAttempts: 3,
          readyAt: new Date(now.getTime() - 10 * 60_000),
        },
        "f3e8cc94-ac30-42ee-9260-514ea4e944f5",
        {
          error: {
            code: "PROVIDER_TIMEOUT",
            failureClass: "PROVIDER",
            message: "Provider timed out.",
            phase: "post_run_analysis.model_invocation",
          },
          kind: "RETRYABLE_FAILURE",
        },
      );

      expect(result).toMatchObject({
        jobStatus: "READY",
        nextAttemptScheduled: true,
      });
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deadlineAt: hardDeadlineAt,
            nextAttemptAt: new Date("2026-09-01T05:32:03.000Z"),
            status: "READY",
          }),
        }),
      );
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ kind: "analysis.retry_queued" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("compactInlineManifest", () => {
  it("keeps large evidence indexes out of the initial model context", () => {
    const manifest = {
      evidenceLocations: Array.from({ length: 2_000 }, (_, index) => ({
        evidenceRef: `artifact://${index}-${"x".repeat(80)}`,
      })),
      evidenceRefs: Array.from(
        { length: 2_000 },
        (_, index) => `artifact://${index}-${"x".repeat(80)}`,
      ),
      eventCounts: { taskEvents: 2_000 },
      runs: [],
      schemaVersion: "devproof.execution-manifest.v2",
      stages: [],
      task: { lifecycle: "COMPLETED" },
    };

    const compact = compactInlineManifest(manifest);

    expect(compact).toMatchObject({
      evidenceLocationCount: 2_000,
      evidenceRefCount: 2_000,
      truncated: true,
    });
    expect(compact).not.toHaveProperty("evidenceRefs");
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(64_000);
  });
});

describe("validateFindingRuntimeLocations", () => {
  const runId = "0d2e36fa-fceb-421c-a023-4520e9c75f44";
  const runtimeId = "86f84b49-050f-4e48-a695-befd8803f95e";
  const evidenceRef = "browser-command://command-1";
  const manifest = {
    evidenceLocations: [{ attemptNumber: 2, evidenceRef, runId, runtimeId }],
    runs: [
      {
        attempts: [{ attemptId: "attempt-2", number: 2 }],
        browserExecutions: [{ attemptId: "attempt-2", runtimeId }],
        runId,
      },
    ],
    stages: [],
  };
  const finding = {
    attemptNumber: 2,
    evidenceRefs: [evidenceRef],
    runId,
    runtimeId,
    title: "浏览器命令失败",
  };

  it("accepts a location linked by the manifest and cited evidence", () => {
    expect(() =>
      validateFindingRuntimeLocations([finding], manifest),
    ).not.toThrow();
  });

  it("rejects a runtime location that is not linked to cited evidence", () => {
    expect(() =>
      validateFindingRuntimeLocations(
        [{ ...finding, evidenceRefs: ["task-event://unscoped"] }],
        manifest,
      ),
    ).toThrow(/no cited evidence linked to its runId/u);
  });

  it("rejects runtimeId without the run that owns it", () => {
    expect(() =>
      validateFindingRuntimeLocations([{ ...finding, runId: null }], manifest),
    ).toThrow(/runtimeId without its required runId/u);
  });
});

describe("PostRunAnalysisRuntimeService work item recurrence", () => {
  it("reopens and refreshes an existing deduplicated work item", async () => {
    const job = {
      analyzerVersion: "post-run-analysis-v2",
      attemptNumber: 1,
      completionId: null,
      deadlineAt: new Date(Date.now() + 60_000),
      fencingToken: 3n,
      findings: [],
      id: analysisId,
      inputManifest: { evidenceRefs: ["artifact://network-log"] },
      inputStorageKey: "analysis/bundle.json",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseOwner: lease.workerId,
      leaseToken: lease.leaseToken,
      maxAttempts: 3,
      status: "RUNNING",
      taskExecutionId,
      teamId,
      workItem: null,
    };
    const upsert = vi.fn().mockResolvedValue({
      id: "9f104911-03dc-4ef3-bfb8-09550df73ce5",
    });
    const servedEvidence = vi.fn().mockResolvedValue([
      {
        payload: {
          evidenceRef: "artifact://network-log",
          fencingToken: lease.fencingToken,
        },
      },
    ]);
    const transactionClient = {
      analysisFinding: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      improvementWorkItem: { upsert },
      postRunAnalysisEvent: {
        create: vi.fn().mockResolvedValue({}),
        findMany: servedEvidence,
      },
      postRunAnalysisJob: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      taskExecution: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: taskExecutionId,
          sourceRef: "PROD-6754",
          title: "失败用例",
        }),
      },
    };
    const prisma = {
      $transaction: vi
        .fn()
        .mockImplementation(
          (operation: (tx: typeof transactionClient) => unknown) =>
            operation(transactionClient),
        ),
      postRunAnalysisJob: { findFirst: vi.fn().mockResolvedValue(job) },
    };
    const storage = {
      get: vi.fn().mockResolvedValue({
        body: Buffer.from(
          JSON.stringify({ evidenceRef: "artifact://network-log" }),
        ),
      }),
    };
    const service = new PostRunAnalysisRuntimeService(
      prisma as never,
      {} as never,
      storage as never,
    );
    const outcome = {
      kind: "ANALYSIS_COMPLETED" as const,
      report: {
        findings: [
          {
            attemptNumber: null,
            category: "PRODUCT_BUG" as const,
            component: "Browser Runtime",
            confidence: 0.95,
            evidenceRefs: ["artifact://network-log"],
            failureClass: "COMMAND_FAILED",
            impact: "测试无法完成。",
            phase: "SPEC_EXECUTION.BROWSER_COMMAND",
            recommendation: "修复命令并增加回归测试。",
            rootCause: "浏览器命令返回失败，token=provider-secret",
            runId: null,
            runtimeId: null,
            severity: "HIGH" as const,
            title: "浏览器命令失败",
          },
        ],
        summary: "发现一个重复出现的问题。",
      },
    };

    servedEvidence.mockResolvedValueOnce([]);
    await expect(
      service.submitOutcome(teamId, analysisId, {
        ...lease,
        completedAt: new Date().toISOString(),
        completionId: "5b13eac0-467f-45a5-aa34-388511f5443e",
        outcome,
      }),
    ).rejects.toThrow(/was not read during the active lease/u);
    expect(
      transactionClient.postRunAnalysisJob.updateMany,
    ).not.toHaveBeenCalled();

    await service.submitOutcome(teamId, analysisId, {
      ...lease,
      completedAt: new Date().toISOString(),
      completionId: "716f2dcb-85ab-4fb7-a11d-350c2f85cc53",
      outcome,
    });

    expect(servedEvidence).toHaveBeenCalledWith({
      select: { payload: true },
      where: {
        actor: "CONTROL_PLANE",
        analysisId,
        kind: "analysis.evidence.served",
      },
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          analysisId,
          sourceTaskExecutionId: taskExecutionId,
          status: "OPEN",
        }),
      }),
    );
    expect(transactionClient.analysisFinding.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            rootCause: "浏览器命令返回失败，token=[REDACTED]",
          }),
        ],
      }),
    );
    expect(
      transactionClient.postRunAnalysisJob.updateMany.mock.calls[0]?.[0].data
        .result,
    ).toMatchObject({
      findings: [
        expect.objectContaining({
          rootCause: "浏览器命令返回失败，token=[REDACTED]",
        }),
      ],
    });
  });
});
