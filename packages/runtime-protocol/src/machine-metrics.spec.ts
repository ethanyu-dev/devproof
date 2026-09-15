import { describe, expect, it } from "vitest";
import {
  runtimeHeartbeatSchema,
  runtimeMachineMetricsSchema,
} from "./index.js";

const metrics = {
  sampledAt: "2026-09-15T12:00:00.000Z",
  sampleIntervalMs: 15000,
  scope: "HOST",
  cpu: { logicalCores: 8, usagePercent: 40 },
  memory: {
    totalBytes: 1000,
    usedBytes: 300,
    availableBytes: 700,
    usagePercent: 30,
    availableSource: "MEM_AVAILABLE",
  },
  process: { rssBytes: 100, uptimeSeconds: 60 },
};
const heartbeat = {
  activeSessions: [],
  maxConcurrency: 4,
  sentAt: metrics.sampledAt,
  type: "runtime.heartbeat",
};

describe("optional machine telemetry", () => {
  it("accepts legacy heartbeats and first-sample CPU warmup", () => {
    expect(
      runtimeHeartbeatSchema.parse(heartbeat).machineMetrics,
    ).toBeUndefined();
    expect(
      runtimeHeartbeatSchema.parse({ ...heartbeat, machineMetrics: metrics })
        .machineMetrics,
    ).toEqual(metrics);
    expect(
      runtimeMachineMetricsSchema.parse({
        ...metrics,
        cpu: { logicalCores: 8, usagePercent: null },
      }).cpu.usagePercent,
    ).toBeNull();
  });
  it("rejects invalid metrics without dropping the lease heartbeat", () => {
    for (const bad of [
      { ...metrics, cpu: { logicalCores: 0, usagePercent: 120 } },
      { ...metrics, memory: { ...metrics.memory, availableBytes: 9999 } },
      { ...metrics, sampleIntervalMs: Infinity },
    ]) {
      expect(runtimeMachineMetricsSchema.safeParse(bad).success).toBe(false);
      expect(
        runtimeHeartbeatSchema.parse({ ...heartbeat, machineMetrics: bad })
          .machineMetrics,
      ).toBeUndefined();
    }
  });
});
