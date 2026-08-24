import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  executionRunCreateInputSchema,
  runInterventionResolveInputSchema,
} from "@devproof/contracts";

import { parseBody } from "../common/validation.js";
import { CurrentToolAuth } from "../tool-auth/current-tool-auth.decorator.js";
import { ToolAuthGuard } from "../tool-auth/tool-auth.guard.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { requireToolScope } from "../tool-auth/tool-scope.js";
import { TaskExecutionService } from "../task-executions/task-execution.service.js";
import { ExecutionRunService } from "./execution-run.service.js";

@Controller("v2/runs")
@UseGuards(ToolAuthGuard)
export class ExecutionRunController {
  constructor(
    private readonly runs: ExecutionRunService,
    private readonly tasks: TaskExecutionService,
  ) {}

  @Get()
  list(@CurrentToolAuth() current: ToolAuthContext) {
    requireToolScope(current, "run:read");
    return this.runs.list(current);
  }

  @Post()
  create(@CurrentToolAuth() current: ToolAuthContext, @Body() body: unknown) {
    requireToolScope(current, "run:write");
    return this.tasks.createCompatibilityRun(
      current,
      parseBody(executionRunCreateInputSchema, body),
    );
  }

  @Get(":id")
  detail(@CurrentToolAuth() current: ToolAuthContext, @Param("id") id: string) {
    requireToolScope(current, "run:read");
    return this.runs.detail(current, id);
  }

  @Get(":id/events")
  events(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Query("after") after?: string,
  ) {
    requireToolScope(current, "run:read");
    if (after !== undefined && !/^\d+$/u.test(after)) {
      throw new BadRequestException("after must be a positive event sequence.");
    }
    return this.runs.events(current, id, after ? BigInt(after) : undefined);
  }

  @Get(":id/trajectory")
  trajectory(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Query("before") before?: string,
    @Query("limit") rawLimit?: string,
  ) {
    requireToolScope(current, "run:read");
    const { beforeSequence, limit } = trajectoryQuery(before, rawLimit);
    return this.runs.trajectory(current, id, {
      ...(beforeSequence === undefined ? {} : { before: beforeSequence }),
      limit,
    });
  }

  @Post(":id/cancel")
  cancel(@CurrentToolAuth() current: ToolAuthContext, @Param("id") id: string) {
    requireToolScope(current, "run:cancel");
    return this.runs.cancel(current, id);
  }

  @Post(":id/interventions/:interventionId/resolve")
  resolveIntervention(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Param("interventionId") interventionId: string,
    @Body() body: unknown,
  ) {
    requireToolScope(current, "run:write");
    return this.runs.resolveIntervention(
      current,
      id,
      interventionId,
      parseBody(runInterventionResolveInputSchema, body),
    );
  }
}

function trajectoryQuery(before?: string, rawLimit?: string) {
  if (before !== undefined && !/^\d+$/u.test(before)) {
    throw new BadRequestException("before must be a positive event sequence.");
  }
  if (rawLimit !== undefined && !/^\d+$/u.test(rawLimit)) {
    throw new BadRequestException(
      "limit must be an integer between 50 and 1000.",
    );
  }
  const limit = rawLimit === undefined ? 500 : Number(rawLimit);
  if (limit < 50 || limit > 1_000) {
    throw new BadRequestException(
      "limit must be an integer between 50 and 1000.",
    );
  }
  return {
    beforeSequence: before === undefined ? undefined : BigInt(before),
    limit,
  };
}
