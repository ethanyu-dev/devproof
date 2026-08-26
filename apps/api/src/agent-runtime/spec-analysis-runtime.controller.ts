import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import {
  runtimeSpecAnalysisClaimInputSchema,
  runtimeSpecAnalysisTaskOutcomeInputSchema,
  runtimeSpecAnalysisToolInputSchema,
  runtimeTaskEventInputSchema,
  runtimeTaskHeartbeatInputSchema,
} from "@devproof/agent-runtime-protocol";

import { parseBody } from "../common/validation.js";
import { CurrentToolAuth } from "../tool-auth/current-tool-auth.decorator.js";
import { ToolAuthGuard } from "../tool-auth/tool-auth.guard.js";
import { requireAgentRuntimePool } from "../tool-auth/tool-scope.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { SpecAnalysisRuntimeService } from "./spec-analysis-runtime.service.js";

@Controller("internal/v2/runtime/spec-tasks")
@UseGuards(ToolAuthGuard)
export class SpecAnalysisRuntimeController {
  constructor(private readonly analysis: SpecAnalysisRuntimeService) {}

  @Post("claim")
  claim(@CurrentToolAuth() current: ToolAuthContext, @Body() body: unknown) {
    requireAgentRuntimePool(current, "SPEC_ANALYSIS");
    return this.analysis.claim(
      current.team.id,
      parseBody(runtimeSpecAnalysisClaimInputSchema, body),
    );
  }

  @Post(":id/heartbeat")
  heartbeat(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    requireAgentRuntimePool(current, "SPEC_ANALYSIS");
    return this.analysis.heartbeat(
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
    requireAgentRuntimePool(current, "SPEC_ANALYSIS");
    return this.analysis.appendEvent(
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
    requireAgentRuntimePool(current, "SPEC_ANALYSIS");
    return this.analysis.executeTool(
      current.team.id,
      id,
      parseBody(runtimeSpecAnalysisToolInputSchema, body),
    );
  }

  @Post(":id/outcome")
  submitOutcome(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    requireAgentRuntimePool(current, "SPEC_ANALYSIS");
    return this.analysis.submitOutcome(
      current.team.id,
      id,
      parseBody(runtimeSpecAnalysisTaskOutcomeInputSchema, body),
    );
  }
}
