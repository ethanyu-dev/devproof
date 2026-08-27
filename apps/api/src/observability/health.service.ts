import { Injectable } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
import { RedisService } from "../infrastructure/redis.service.js";
import { MetricsService } from "./metrics.service.js";
import { WorkerMonitorService } from "./worker-monitor.service.js";

export interface CheckResult {
  durationMs: number;
  error?: string;
  status: "UP" | "DOWN";
}

@Injectable()
export class HealthService {
  private readonly dependencyChecks = new Map<string, Promise<void>>();
  private readinessInFlight:
    Promise<Awaited<ReturnType<HealthService["collectReadiness"]>>> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: ObjectStorageService,
    private readonly workers: WorkerMonitorService,
    private readonly metrics: MetricsService,
  ) {}

  liveness() {
    return {
      service: "devproof-api",
      status: "UP" as const,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  async readiness() {
    this.readinessInFlight ??= this.collectReadiness().finally(() => {
      this.readinessInFlight = undefined;
    });
    return this.readinessInFlight;
  }

  private async collectReadiness() {
    const [database, redis, objectStorage] = await Promise.all([
      this.check("database", async () => {
        const [schema] = await this.prisma.$queryRaw<
          Array<{ taskDeploymentProfileBindings: string | null }>
        >`SELECT to_regclass('public.task_deployment_profile_bindings')::text
            AS "taskDeploymentProfileBindings"`;
        if (!schema?.taskDeploymentProfileBindings) {
          throw new Error(
            "Required database relation task_deployment_profile_bindings is missing; run committed migrations before starting the API.",
          );
        }
      }),
      this.check("redis", async () => {
        if (!(await this.redis.ping()))
          throw new Error("Redis did not return PONG.");
      }),
      this.check("object-storage", async (signal) => {
        await this.storage.check(signal);
      }),
    ]);
    const workers = this.workers.snapshot();
    const dependenciesReady = [database, redis, objectStorage].every(
      (check) => check.status === "UP",
    );
    const workersHealthy = workers.every((worker) => worker.healthy);
    for (const [dependency, result] of Object.entries({
      database,
      object_storage: objectStorage,
      redis,
    })) {
      this.metrics.setGauge(
        "devproof_dependency_ready",
        "Whether a required service dependency is ready.",
        result.status === "UP" ? 1 : 0,
        { dependency },
      );
    }
    return {
      checks: { database, objectStorage, redis },
      service: "devproof-api",
      status: !dependenciesReady
        ? ("NOT_READY" as const)
        : workersHealthy
          ? ("READY" as const)
          : ("DEGRADED" as const),
      timestamp: new Date().toISOString(),
      workers,
    };
  }

  private async check(
    name: string,
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<CheckResult> {
    const started = Date.now();
    const controller = new AbortController();
    let active = this.dependencyChecks.get(name);
    if (!active) {
      active = Promise.resolve()
        .then(() => operation(controller.signal))
        .finally(() => {
          if (this.dependencyChecks.get(name) === active) {
            this.dependencyChecks.delete(name);
          }
        });
      this.dependencyChecks.set(name, active);
    }
    let timer: NodeJS.Timeout;
    try {
      await Promise.race([
        active,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Dependency health check exceeded 3 seconds."));
          }, 3_000);
          timer.unref();
        }),
      ]);
      return { durationMs: Date.now() - started, status: "UP" };
    } catch (error) {
      return {
        durationMs: Date.now() - started,
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          1_000,
        ),
        status: "DOWN",
      };
    } finally {
      clearTimeout(timer!);
    }
  }
}
