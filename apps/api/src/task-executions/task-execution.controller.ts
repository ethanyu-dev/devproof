import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  taskDeploymentTargetInputSchema,
  taskExecutionCreateInputSchema,
  taskStageRetryInputSchema,
} from "@devproof/contracts";

import { parseBody } from "../common/validation.js";
import { CurrentToolAuth } from "../tool-auth/current-tool-auth.decorator.js";
import { ToolAuthGuard } from "../tool-auth/tool-auth.guard.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { requireToolScope } from "../tool-auth/tool-scope.js";
import { TaskExecutionService } from "./task-execution.service.js";

@Controller("v2/tasks")
@UseGuards(ToolAuthGuard)
export class TaskExecutionController {
  constructor(private readonly tasks: TaskExecutionService) {}

  @Post()
  @HttpCode(202)
  create(@CurrentToolAuth() current: ToolAuthContext, @Body() body: unknown) {
    requireToolScope(current, "run:write");
    return this.tasks.create(
      current,
      parseBody(taskExecutionCreateInputSchema, body),
    );
  }

  @Get()
  list(@CurrentToolAuth() current: ToolAuthContext) {
    requireToolScope(current, "run:read");
    return this.tasks.list(current);
  }

  @Get(":id")
  detail(@CurrentToolAuth() current: ToolAuthContext, @Param("id") id: string) {
    requireToolScope(current, "run:read");
    return this.tasks.detail(current, id);
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
    return this.tasks.events(current, id, after ? BigInt(after) : undefined);
  }

  @Post(":id/deployment-target")
  setDeploymentTarget(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    requireToolScope(current, "run:write");
    const input = parseBody(taskDeploymentTargetInputSchema, body);
    return this.tasks.setDeploymentTarget(current, id, input.url);
  }

  @Post(":id/stages/:stage/retry")
  retryStage(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Param("stage") stage: string,
    @Body() body: unknown,
  ) {
    requireToolScope(current, "run:write");
    return this.tasks.retryStage(
      current,
      id,
      stage,
      parseBody(taskStageRetryInputSchema, body),
    );
  }

  @Post(":id/cancel")
  cancel(@CurrentToolAuth() current: ToolAuthContext, @Param("id") id: string) {
    requireToolScope(current, "run:cancel");
    return this.tasks.cancel(current, id);
  }

  @Post(":id/rerun")
  rerun(@CurrentToolAuth() current: ToolAuthContext, @Param("id") id: string) {
    requireToolScope(current, "run:write");
    return this.tasks.rerun(current, id);
  }
}
