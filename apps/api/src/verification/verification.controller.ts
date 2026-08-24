import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";

import { CurrentToolAuth } from "../tool-auth/current-tool-auth.decorator.js";
import { ToolAuthGuard } from "../tool-auth/tool-auth.guard.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { requireToolScope } from "../tool-auth/tool-scope.js";
import { VerificationService } from "./verification.service.js";
import { VerificationExecutionService } from "./verification-execution.service.js";

@Controller("v1/verifications")
@UseGuards(ToolAuthGuard)
export class VerificationController {
  constructor(private readonly verifications: VerificationService) {}

  @Get()
  list(@CurrentToolAuth() current: ToolAuthContext) {
    requireToolScope(current, "verification:read");
    return this.verifications.list(current);
  }

  @Get(":id")
  detail(@CurrentToolAuth() current: ToolAuthContext, @Param("id") id: string) {
    requireToolScope(current, "verification:read");
    return this.verifications.detail(current, id);
  }

  @Get(":id/events")
  events(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Query("after") after?: string,
  ) {
    requireToolScope(current, "verification:read");
    if (after !== undefined && !/^\d+$/u.test(after)) {
      throw new BadRequestException("after must be a positive event sequence.");
    }
    return this.verifications.events(
      current,
      id,
      after ? BigInt(after) : undefined,
    );
  }
}

@Controller("v1/execution-runners")
@UseGuards(ToolAuthGuard)
export class ExecutionRunnerController {
  constructor(private readonly execution: VerificationExecutionService) {}

  @Get()
  list(@CurrentToolAuth() current: ToolAuthContext) {
    requireToolScope(current, "verification:read");
    return this.execution.listRunners(current.team.id);
  }
}
