import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import {
  runtimeTaskClaimInputSchema,
  runtimeBrowserAcquireInputSchema,
  runtimeBrowserCommandInputSchema,
  runtimeBrowserReleaseInputSchema,
  runtimeTaskEventInputSchema,
  runtimeTaskHeartbeatInputSchema,
  runtimeTaskOutcomeInputSchema,
} from "@devproof/agent-runtime-protocol";

import { parseBody } from "../common/validation.js";
import { CurrentToolAuth } from "../tool-auth/current-tool-auth.decorator.js";
import { ToolAuthGuard } from "../tool-auth/tool-auth.guard.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { requireToolScope } from "../tool-auth/tool-scope.js";
import { AgentRuntimeTaskService } from "./agent-runtime-task.service.js";
import { UnifiedBrowserExecutionService } from "./unified-browser-execution.service.js";

@Controller("internal/v2/runtime/tasks")
@UseGuards(ToolAuthGuard)
export class AgentRuntimeTaskController {
  constructor(
    private readonly tasks: AgentRuntimeTaskService,
    private readonly browser: UnifiedBrowserExecutionService,
  ) {}

  @Post("claim")
  claim(@CurrentToolAuth() current: ToolAuthContext, @Body() body: unknown) {
    requireToolScope(current, "runtime:lease");
    return this.tasks.claim(
      current.team.id,
      parseBody(runtimeTaskClaimInputSchema, body),
    );
  }

  @Post(":id/heartbeat")
  heartbeat(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    requireToolScope(current, "runtime:lease");
    return this.tasks.heartbeat(
      current.team.id,
      id,
      parseBody(runtimeTaskHeartbeatInputSchema, body),
    );
  }

  @Post(":id/events")
  appendEvent(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    requireToolScope(current, "runtime:lease");
    return this.tasks.appendEvent(
      current.team.id,
      id,
      parseBody(runtimeTaskEventInputSchema, body),
    );
  }

  @Post(":id/outcome")
  submitOutcome(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    requireToolScope(current, "runtime:lease");
    return this.tasks.submitOutcome(
      current.team.id,
      id,
      parseBody(runtimeTaskOutcomeInputSchema, body),
    );
  }

  @Post(":id/browser/acquire")
  acquireBrowser(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    requireToolScope(current, "runtime:lease");
    return this.browser.acquire(
      current.team.id,
      id,
      parseBody(runtimeBrowserAcquireInputSchema, body),
    );
  }

  @Post(":id/browser/commands")
  executeBrowserCommand(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    requireToolScope(current, "runtime:lease");
    return this.browser.execute(
      current.team.id,
      id,
      parseBody(runtimeBrowserCommandInputSchema, body),
    );
  }

  @Post(":id/browser/release")
  releaseBrowser(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    requireToolScope(current, "runtime:lease");
    return this.browser.release(
      current.team.id,
      id,
      parseBody(runtimeBrowserReleaseInputSchema, body),
    );
  }
}
