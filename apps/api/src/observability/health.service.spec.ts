import { describe, expect, it, vi } from "vitest";

import { HealthService } from "./health.service.js";
import { MetricsService } from "./metrics.service.js";

function service(input?: {
  databaseError?: Error;
  schemaMissing?: boolean;
  workerHealthy?: boolean;
}) {
  const prisma = {
    $queryRaw: vi.fn().mockImplementation(() =>
      input?.databaseError
        ? Promise.reject(input.databaseError)
        : Promise.resolve([
            {
              taskDeploymentProfileBindings: input?.schemaMissing
                ? null
                : "task_deployment_profile_bindings",
            },
          ]),
    ),
  };
  const redis = { ping: vi.fn().mockResolvedValue(true) };
  const storage = { check: vi.fn().mockResolvedValue(true) };
  const workers = {
    snapshot: vi
      .fn()
      .mockReturnValue([
        { healthy: input?.workerHealthy ?? true, name: "worker" },
      ]),
  };
  return new HealthService(
    prisma as never,
    redis as never,
    storage as never,
    workers as never,
    new MetricsService(),
  );
}

describe("HealthService", () => {
  it("reports READY only when dependencies and workers are healthy", async () => {
    await expect(service().readiness()).resolves.toMatchObject({
      checks: {
        database: { status: "UP" },
        objectStorage: { status: "UP" },
        redis: { status: "UP" },
      },
      status: "READY",
      workers: [{ healthy: true }],
    });
  });

  it("reports dependency failures as NOT_READY", async () => {
    await expect(
      service({
        databaseError: new Error("database unavailable"),
        workerHealthy: false,
      }).readiness(),
    ).resolves.toMatchObject({
      checks: { database: { error: "database unavailable", status: "DOWN" } },
      status: "NOT_READY",
      workers: [{ healthy: false }],
    });
  });

  it("reports an incomplete database schema as NOT_READY", async () => {
    await expect(
      service({ schemaMissing: true }).readiness(),
    ).resolves.toMatchObject({
      checks: {
        database: {
          error: expect.stringContaining(
            "task_deployment_profile_bindings is missing",
          ),
          status: "DOWN",
        },
      },
      status: "NOT_READY",
    });
  });

  it("reports worker failures as DEGRADED without hiding dependency readiness", async () => {
    await expect(
      service({ workerHealthy: false }).readiness(),
    ).resolves.toMatchObject({
      checks: { database: { status: "UP" } },
      status: "DEGRADED",
      workers: [{ healthy: false }],
    });
  });
});
