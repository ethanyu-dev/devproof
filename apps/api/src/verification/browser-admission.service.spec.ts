import { describe, expect, it, vi } from "vitest";

import {
  BrowserAdmissionService,
  fairAdmissionOrder,
} from "./browser-admission.service.js";

function candidate(id: string, taskExecutionId: string, runtimeId?: string) {
  return {
    execution: {
      createdAt: new Date(`2026-08-26T00:00:0${id.slice(-1)}.000Z`),
      id,
      run: { taskExecutionId },
    },
    rule: runtimeId ? { id: `rule-${runtimeId}`, runtimeId } : undefined,
  };
}

describe("browser admission queue ordering", () => {
  it("loads the complete active queue before partitioning by runtime", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new BrowserAdmissionService(
      {
        agentRuntimeTask: { findMany: vi.fn().mockResolvedValue([]) },
        browserExecution: { findMany },
        runtimeRoutingRule: { findMany: vi.fn().mockResolvedValue([]) },
      } as never,
      {} as never,
    );

    await service.reconcile(100);

    expect(findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ take: expect.anything() }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { nextAdmissionAt: { sort: "asc", nulls: "first" } },
          { createdAt: "asc" },
        ],
      }),
    );
  });

  it("records invalid legacy admission input instead of leaving it rejected", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const acquireForExecutionRun = vi.fn();
    const prisma = {
      agentRuntimeTask: { findMany: vi.fn().mockResolvedValue([]) },
      browserExecution: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([
          {
            attemptId: "attempt-1",
            createdAt: new Date("2026-08-26T00:00:00.000Z"),
            id: "execution-1",
            input: { profile: { mode: "PERSISTENT" } },
            nextAdmissionAt: null,
            run: {
              deadlineAt: new Date(Date.now() + 60_000),
              goal: "Verify the deployment",
              lifecycle: "QUEUED",
              taskExecutionId: "issue-1",
              teamId: "team-1",
            },
            runId: "run-1",
            status: "REQUESTED",
            updatedAt: new Date("2026-08-26T00:00:00.000Z"),
            waitingSince: null,
          },
        ]),
        updateMany,
      },
      runtimeRoutingRule: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new BrowserAdmissionService(
      {
        ...prisma,
        $transaction: async (fn: (tx: typeof prisma) => unknown) => fn(prisma),
      } as never,
      { acquireForExecutionRun } as never,
    );

    await expect(service.reconcile(1)).resolves.toBe(1);

    expect(acquireForExecutionRun).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: expect.objectContaining({ code: "ADMISSION_ERROR" }),
          status: "WAITING_CAPACITY",
        }),
      }),
    );
  });

  it("recovers an expired legacy Runtime task that has no admission row", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new BrowserAdmissionService(
      {
        agentRuntimeTask: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce([
              {
                attemptId: "attempt-legacy",
                run: {
                  environmentSnapshot: {
                    targetUrl: "https://legacy.example.com",
                  },
                  executionPolicy: {
                    browser: {
                      availabilityPolicy: "WAIT",
                      profile: { mode: "EPHEMERAL" },
                      requiredCapabilities: ["browser"],
                    },
                  },
                },
                runId: "run-legacy",
              },
            ])
            .mockResolvedValue([]),
        },
        browserExecution: {
          createMany,
          findMany: vi.fn().mockResolvedValue([]),
        },
        runtimeRoutingRule: { findMany: vi.fn().mockResolvedValue([]) },
      } as never,
      {} as never,
    );

    await service.reconcile(1);

    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          attemptId: "attempt-legacy",
          input: expect.objectContaining({
            targetUrl: "https://legacy.example.com",
          }),
          runId: "run-legacy",
          status: "REQUESTED",
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("rotates runtime-specific and flexible queues without cross-node head-of-line blocking", () => {
    const ordered = fairAdmissionOrder([
      candidate("a-1", "issue-1", "runtime-a"),
      candidate("a-2", "issue-1", "runtime-a"),
      candidate("a-3", "issue-1", "runtime-a"),
      candidate("b-1", "issue-1", "runtime-b"),
      candidate("flex-1", "issue-1"),
      candidate("flex-2", "issue-1"),
    ]);

    expect(ordered.slice(0, 3).map((item) => item.execution.id)).toEqual([
      "a-1",
      "b-1",
      "flex-1",
    ]);
    expect(ordered.map((item) => item.execution.id)).toEqual([
      "a-1",
      "b-1",
      "flex-1",
      "a-2",
      "flex-2",
      "a-3",
    ]);
  });

  it("rotates issues within the same runtime queue", () => {
    const ordered = fairAdmissionOrder([
      candidate("a-1", "issue-1", "runtime-a"),
      candidate("a-2", "issue-1", "runtime-a"),
      candidate("a-3", "issue-2", "runtime-a"),
      candidate("a-4", "issue-2", "runtime-a"),
    ]);

    expect(ordered.map((item) => item.execution.id)).toEqual([
      "a-1",
      "a-3",
      "a-2",
      "a-4",
    ]);
  });
});
