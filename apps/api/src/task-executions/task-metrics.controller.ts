import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  modelCallRegistrationSchema,
  modelCallSettlementSchema,
} from "@devproof/agent-runtime-protocol";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ToolAuthGuard } from "../tool-auth/tool-auth.guard.js";
import { CurrentToolAuth } from "../tool-auth/current-tool-auth.decorator.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import {
  requireAgentRuntimeIdentity,
  requireAgentRuntimePool,
  requireToolScope,
} from "../tool-auth/tool-scope.js";
import { parseBody } from "../common/validation.js";
import { TaskMetricsService } from "./task-metrics.service.js";
const cursor = z.string().max(500).optional();
const batchIds = z
  .string()
  .max(2000)
  .transform((v) => v.split(","))
  .pipe(z.array(z.string().uuid()).max(50));

@Controller("console/api/tasks")
@UseGuards(AuthGuard)
export class TaskMetricsConsoleController {
  constructor(private readonly metrics: TaskMetricsService) {}
  @Get("metrics/batch")
  batch(@CurrentAuth() current: AuthContext, @Query("ids") ids: string) {
    return this.metrics.batch(current.team.id, parseBody(batchIds, ids));
  }
  @Get(":id/metrics")
  summary(
    @CurrentAuth() current: AuthContext,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.metrics.summary(current.team.id, id);
  }
  @Get(":id/metrics/model-calls")
  calls(
    @CurrentAuth() current: AuthContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("after") after?: string,
  ) {
    return this.metrics.calls(current.team.id, id, parseBody(cursor, after));
  }
  @Get(":id/metrics/timeline")
  timeline(
    @CurrentAuth() current: AuthContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("after") after?: string,
  ) {
    return this.metrics.timeline(current.team.id, id, parseBody(cursor, after));
  }
}
@Controller("v2/tasks")
@UseGuards(ToolAuthGuard)
export class TaskMetricsController {
  constructor(private readonly metrics: TaskMetricsService) {}
  @Get(":id/metrics")
  summary(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    requireToolScope(current, "run:read");
    return this.metrics.summary(current.team.id, id);
  }
  @Get(":id/metrics/model-calls")
  calls(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("after") after?: string,
  ) {
    requireToolScope(current, "run:read");
    return this.metrics.calls(current.team.id, id, parseBody(cursor, after));
  }
  @Get(":id/metrics/timeline")
  timeline(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("after") after?: string,
  ) {
    requireToolScope(current, "run:read");
    return this.metrics.timeline(current.team.id, id, parseBody(cursor, after));
  }
}
@Controller("internal/v2/runtime/model-calls")
@UseGuards(ToolAuthGuard)
export class ModelCallMetricsController {
  constructor(private readonly metrics: TaskMetricsService) {}
  @Post()
  register(@CurrentToolAuth() current: ToolAuthContext, @Body() body: unknown) {
    const input = parseBody(modelCallRegistrationSchema, body);
    requireAgentRuntimePool(
      current,
      input.ownerKind === "RUN" ? "BROWSER_EXECUTION" : "SPEC_ANALYSIS",
    );
    return this.metrics.register(current.team.id, input);
  }
  @Post("settle")
  settle(@CurrentToolAuth() current: ToolAuthContext, @Body() body: unknown) {
    requireAgentRuntimeIdentity(current);
    return this.metrics.settle(
      current.team.id,
      parseBody(modelCallSettlementSchema, body),
    );
  }
}
