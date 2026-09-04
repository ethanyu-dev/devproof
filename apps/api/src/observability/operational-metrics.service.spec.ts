import { describe, expect, it, vi } from "vitest";
import { MetricsService } from "./metrics.service.js";
import { OperationalMetricsService } from "./operational-metrics.service.js";

describe("execution scheduling operational metrics", () => {
  it("separates wait reasons, quarantines and projection lag without identifier labels", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-04T02:00:00.000Z");
    vi.setSystemTime(now);
    try {
      const since = new Date(now.getTime() - 120_000);
      const prisma = {
        taskCaseExecution: {
          findMany: vi.fn().mockResolvedValue([
            {
              dispatchStatus: "PENDING",
              dispatchAttempts: 0,
              run: null,
              createdAt: since,
              scheduling: {
                state: "WAITING",
                reason: "PROFILE_RESERVED",
                waitingSince: since.toISOString(),
                blockedBy: {
                  resourceType: "PROFILE",
                  resourceId: "private-profile-id",
                },
              },
            },
            {
              dispatchStatus: "PENDING",
              dispatchAttempts: 0,
              run: null,
              createdAt: since,
              scheduling: {
                state: "WAITING",
                reason: "untrusted-reason-with-an-id",
              },
            },
            {
              dispatchStatus: "CANCELLED",
              dispatchAttempts: 0,
              run: null,
              createdAt: since,
              scheduling: null,
            },
            {
              dispatchStatus: "LINKED",
              run: {
                lifecycle: "TIMED_OUT",
                verdict: null,
                executionDisposition: "AGENT_ERROR",
              },
              createdAt: since,
              scheduling: { state: "WAITING", reason: "RUNTIME_CAPACITY" },
            },
          ]),
        },
        browserExecution: {
          findMany: vi.fn().mockResolvedValue([
            {
              error: { code: "NO_AVAILABLE_SLOT" },
              waitingSince: since,
              createdAt: since,
            },
          ]),
        },
        executionResourceLease: {
          aggregate: vi
            .fn()
            .mockResolvedValue({ _count: 2, _min: { createdAt: since } }),
        },
        browserRuntimeSession: {
          aggregate: vi.fn().mockResolvedValue({
            _min: { quarantinedAt: new Date(now.getTime() - 30_000) },
          }),
        },
        agentRuntimeTask: {
          groupBy: vi.fn().mockResolvedValue([
            { recoveryStatus: "PENDING", _count: 1 },
            { recoveryStatus: "WRITE_OUTCOME_UNKNOWN", _count: 2 },
          ]),
        },
        taskExecution: {
          findMany: vi.fn().mockResolvedValue([
            {
              projectionNeededAt: new Date(now.getTime() - 5_000),
              projectedAt: new Date(now.getTime() - 20_000),
              createdAt: since,
            },
          ]),
        },
      };
      const metrics = new MetricsService();
      const service = new OperationalMetricsService(prisma as never, metrics);
      await service.collectExecutionScheduling();
      const output = metrics.render();
      expect(output).toContain(
        'devproof_execution_waiting{reason="profile_reserved"} 1',
      );
      expect(output).toContain(
        'devproof_execution_waiting{reason="runtime_capacity"} 1',
      );
      expect(output).toContain('devproof_execution_waiting{reason="other"} 1');
      expect(output).toContain(
        'devproof_execution_oldest_wait_seconds{reason="profile_reserved"} 120',
      );
      expect(output).toContain(
        'devproof_agent_lease_recoveries{status="write_outcome_unknown"} 2',
      );
      expect(output).toContain("devproof_resource_quarantines 2");
      expect(output).toContain(
        "devproof_resource_quarantine_oldest_seconds 30",
      );
      expect(output).toContain(
        "devproof_task_projection_oldest_pending_seconds 5",
      );
      expect(output).toContain("devproof_task_projection_staleness_seconds 20");
      expect(output).not.toContain("private-profile-id");
      expect(output).not.toContain("untrusted-reason-with-an-id");

      prisma.taskCaseExecution.findMany.mockResolvedValue([]);
      prisma.browserExecution.findMany.mockResolvedValue([]);
      prisma.agentRuntimeTask.groupBy.mockResolvedValue([]);
      prisma.taskExecution.findMany.mockResolvedValue([]);
      await service.collectExecutionScheduling();
      expect(metrics.render()).not.toContain('reason="profile_reserved"');
      expect(metrics.render()).not.toContain('status="write_outcome_unknown"');
      expect(metrics.render()).toContain(
        "devproof_task_projection_oldest_pending_seconds 0",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
