import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import {
  acceptanceReviewClaimSchema,
  acceptanceReviewOutcomeSchema,
} from "@devproof/agent-runtime-protocol";
import { parseBody } from "../common/validation.js";
import { CurrentToolAuth } from "../tool-auth/current-tool-auth.decorator.js";
import { ToolAuthGuard } from "../tool-auth/tool-auth.guard.js";
import { requireAgentRuntimePool } from "../tool-auth/tool-scope.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { TaskAcceptanceReviewService } from "../task-executions/task-acceptance-review.service.js";
@Controller("internal/v2/runtime/acceptance-reviews")
@UseGuards(ToolAuthGuard)
export class AcceptanceReviewRuntimeController {
  constructor(private readonly reviews: TaskAcceptanceReviewService) {}
  @Post("claim")
  claim(@CurrentToolAuth() current: ToolAuthContext, @Body() body: unknown) {
    requireAgentRuntimePool(current, "SPEC_ANALYSIS");
    return this.reviews.claim(
      current.team.id,
      parseBody(acceptanceReviewClaimSchema, body).workerId,
    );
  }
  @Post(":id/outcome")
  complete(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    requireAgentRuntimePool(current, "SPEC_ANALYSIS");
    return this.reviews.complete(
      current.team.id,
      id,
      parseBody(acceptanceReviewOutcomeSchema, body),
    );
  }
}
