import { readFileSync } from "node:fs";
import { cpus, freemem, platform, totalmem } from "node:os";
import {
  runtimeMachineMetricsSchema,
  type RuntimeMachineMetrics,
} from "@devproof/runtime-protocol";

interface CpuSample {
  idle: number;
  total: number;
  cores: number;
  at: number;
}

function readCpu(): CpuSample {
  const processors = cpus();
  return {
    idle: processors.reduce((sum, cpu) => sum + cpu.times.idle, 0),
    total: processors.reduce(
      (sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0),
      0,
    ),
    cores: processors.length,
    at: performance.now(),
  };
}

/** Returns an interval average across all logical CPUs, not load average. */
export function cpuUsage(previous: CpuSample | undefined, current: CpuSample) {
  if (
    !previous ||
    previous.cores !== current.cores ||
    current.at - previous.at >= 45_000
  )
    return null;
  const elapsed = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (elapsed <= 0 || idle < 0 || idle > elapsed) return null;
  return Math.round((1 - idle / elapsed) * 10_000) / 100;
}

export function linuxAvailableMemory(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(meminfo);
  return match ? Number(match[1]) * 1024 : null;
}

/** Small, local OS reads only. A collection failure must not stop a heartbeat. */
export class MachineMetricsSampler {
  private previous: CpuSample | undefined;

  sample(): RuntimeMachineMetrics | undefined {
    try {
      const cpu = readCpu();
      const previous = this.previous;
      this.previous = cpu;
      const totalBytes = totalmem();
      let availableBytes = freemem();
      let availableSource: "MEM_AVAILABLE" | "OS_FREE" = "OS_FREE";
      if (platform() === "linux") {
        try {
          const available = linuxAvailableMemory(
            readFileSync("/proc/meminfo", "utf8"),
          );
          if (available !== null && Number.isSafeInteger(available)) {
            availableBytes = available;
            availableSource = "MEM_AVAILABLE";
          }
        } catch {
          // Non-Linux and restricted /proc installations use the OS fallback.
        }
      }
      availableBytes = Math.max(0, Math.min(totalBytes, availableBytes));
      const usedBytes = totalBytes - availableBytes;
      const result = runtimeMachineMetricsSchema.safeParse({
        sampledAt: new Date().toISOString(),
        sampleIntervalMs: previous ? Math.max(0, cpu.at - previous.at) : 0,
        scope: "HOST",
        cpu: { logicalCores: cpu.cores, usagePercent: cpuUsage(previous, cpu) },
        memory: {
          totalBytes,
          usedBytes,
          availableBytes,
          usagePercent: Math.round((usedBytes / totalBytes) * 10_000) / 100,
          availableSource,
        },
        process: {
          rssBytes: process.memoryUsage().rss,
          uptimeSeconds: process.uptime(),
        },
      });
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }
}
