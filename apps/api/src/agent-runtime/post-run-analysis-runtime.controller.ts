import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import {
  runtimePostRunAnalysisClaimInputSchema,
  runtimePostRunAnalysisTaskOutcomeInputSchema,
  runtimePostRunAnalysisToolInputSchema,
  runtimeTaskEventInputSchema,
  runtimeTaskHeartbeatInputSchema,
} from "@devproof/agent-runtime-protocol";

import { parseBody } from "../common/validation.js";
import { CurrentToolAuth } from "../tool-auth/current-tool-auth.decorator.js";
import { ToolAuthGuard } from "../tool-auth/tool-auth.guard.js";
import { requireAgentRuntimePool } from "../tool-auth/tool-scope.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { PostRunAnalysisRuntimeService } from "./post-run-analysis-runtime.service.js";

@Controller("internal/v2/runtime/post-run-analysis-tasks")
@UseGuards(ToolAuthGuard)
export class PostRunAnalysisRuntimeController {
  constructor(private readonly analyses: PostRunAnalysisRuntimeService) {}

  @Post("claim")
  claim(@CurrentToolAuth() current: ToolAuthContext, @Body() body: unknown) {
    requireAgentRuntimePool(current, "POST_RUN_ANALYSIS");
    return this.analyses.claim(
      current.team.id,
      parseBody(runtimePostRunAnalysisClaimInputSchema, body),
    );
  }

  @Post(":id/heartbeat")
  heartbeat(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    requireAgentRuntimePool(current, "POST_RUN_ANALYSIS");
    return this.analyses.heartbeat(
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
    requireAgentRuntimePool(current, "POST_RUN_ANALYSIS");
    return this.analyses.appendEvent(
      current.team.id,
      id,
      parseBody(runtimeTaskEventInputSchema, body),
    );
  }

  @Post(":id/tools")
  executeTool(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    requireAgentRuntimePool(current, "POST_RUN_ANALYSIS");
    return this.analyses.executeTool(
      current.team.id,
      id,
      parseBody(runtimePostRunAnalysisToolInputSchema, body),
    );
  }

  @Post(":id/outcome")
  submitOutcome(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    requireAgentRuntimePool(current, "POST_RUN_ANALYSIS");
    return this.analyses.submitOutcome(
      current.team.id,
      id,
      parseBody(runtimePostRunAnalysisTaskOutcomeInputSchema, body),
    );
  }
}
