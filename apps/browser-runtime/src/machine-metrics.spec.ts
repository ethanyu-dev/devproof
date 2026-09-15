import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  cpuUsage,
  linuxAvailableMemory,
  MachineMetricsSampler,
} from "./machine-metrics.js";
import { RuntimeClient } from "./index.js";

vi.mock("node:os", async (original) => ({ ...(await original<typeof os>()) }));
vi.mock("node:fs", async (original) => ({ ...(await original<typeof fs>()) }));
afterEach(() => vi.restoreAllMocks());

describe("machine resource sampling", () => {
  it("measures the interval across CPUs and discards warmup, resets and topology changes", () => {
    const first = { idle: 400, total: 1000, cores: 4, at: 0 };
    const next = { idle: 700, total: 2000, cores: 4, at: 15000 };
    expect(cpuUsage(first, next)).toBe(70);
    expect(cpuUsage(undefined, next)).toBeNull();
    expect(cpuUsage(first, first)).toBeNull();
    expect(cpuUsage(next, first)).toBeNull();
    expect(cpuUsage(first, { ...next, cores: 8 })).toBeNull();
    expect(cpuUsage(first, { ...next, at: 60_000 })).toBeNull();
  });

  it("counts reclaimable Linux memory as available and includes non-daemon usage", () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    vi.spyOn(os, "totalmem").mockReturnValue(8192 * 1024);
    vi.spyOn(os, "freemem").mockReturnValue(1024 * 1024);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "MemTotal: 8192 kB\nMemFree: 1024 kB\nMemAvailable: 6144 kB\n",
    );
    const metrics = new MachineMetricsSampler().sample()!;
    expect(metrics.memory).toMatchObject({
      availableBytes: 6144 * 1024,
      usedBytes: 2048 * 1024,
      usagePercent: 25,
      availableSource: "MEM_AVAILABLE",
    });
    expect(metrics.cpu.usagePercent).toBeNull();
    expect(linuxAvailableMemory("MemFree: 1024 kB\n")).toBeNull();
  });

  it("falls back on restricted procfs and contains collector failures", () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("restricted");
    });
    expect(new MachineMetricsSampler().sample()?.memory.availableSource).toBe(
      "OS_FREE",
    );
    vi.spyOn(os, "cpus").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(new MachineMetricsSampler().sample()).toBeUndefined();
  });

  it.each([17, 18])(
    "sends heartbeat metrics only after v1.18 negotiation (minor %i)",
    (minor) => {
      const client = new RuntimeClient(
        { value: () => ({ sessions: [] }) } as never,
        { server: "http://127.0.0.1:1" } as never,
      );
      const send = vi.fn();
      Reflect.set(client, "socket", { readyState: WebSocket.OPEN, send });
      Reflect.set(client, "negotiatedProtocolMinor", minor);
      Reflect.get(client, "heartbeat").call(client);
      const message = JSON.parse(send.mock.calls[0]![0]);
      expect(message.type).toBe("runtime.heartbeat");
      expect(Boolean(message.machineMetrics)).toBe(minor >= 18);
    },
  );
});
