import {
  Controller,
  Get,
  Headers,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { env } from "../config/env.js";
import { HealthService } from "./health.service.js";
import { MetricsService } from "./metrics.service.js";
import { OperationalMetricsService } from "./operational-metrics.service.js";

@Controller()
export class ObservabilityController {
  constructor(
    private readonly healthService: HealthService,
    private readonly metrics: MetricsService,
    private readonly operationalMetrics: OperationalMetricsService,
  ) {}

  @Get("live")
  liveness() {
    return this.healthService.liveness();
  }

  @Get("ready")
  async readiness(@Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.healthService.readiness();
    if (result.status === "NOT_READY") reply.status(503);
    if (env().NODE_ENV !== "production") return result;
    return {
      ...result,
      checks: Object.fromEntries(
        Object.entries(result.checks).map(([name, check]) => [
          name,
          { durationMs: check.durationMs, status: check.status },
        ]),
      ),
      workers: result.workers.map(
        ({ lastError: _lastError, ...worker }) => worker,
      ),
    };
  }

  @Get("health")
  legacyHealth(@Res({ passthrough: true }) reply: FastifyReply) {
    return this.readiness(reply);
  }

  @Get("metrics")
  async metricsText(
    @Headers("authorization") authorization: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const token = env().OBSERVABILITY_METRICS_TOKEN;
    if (token && authorization !== `Bearer ${token}`) {
      throw new UnauthorizedException(
        "A valid metrics bearer token is required.",
      );
    }
    if (!token && env().NODE_ENV === "production") {
      return reply
        .status(503)
        .type("text/plain")
        .send(
          "Metrics are disabled until OBSERVABILITY_METRICS_TOKEN is configured.\n",
        );
    }
    await Promise.all([
      this.operationalMetrics.collect(),
      this.healthService.readiness(),
    ]);
    return reply
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(this.metrics.render());
  }
}
