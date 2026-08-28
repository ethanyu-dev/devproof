import { Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";

import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { PostRunAnalysisService } from "./post-run-analysis.service.js";

@Controller("console/api/tasks")
@UseGuards(AuthGuard)
export class PostRunAnalysisConsoleController {
  constructor(private readonly analyses: PostRunAnalysisService) {}

  @Get(":id/post-run-analysis")
  detail(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Query("afterSequence") afterSequence?: string,
  ) {
    return this.analyses.detail(context(current), id, {
      ...(afterSequence === undefined ? {} : { afterSequence }),
    });
  }

  @Post(":id/post-run-analysis/retry")
  retry(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.analyses.retry(context(current), id);
  }
}

function context(current: AuthContext): ToolAuthContext {
  return {
    credential: {
      id: current.user.id,
      kind: "TOOL",
      name: current.user.name ?? current.user.email ?? "Console user",
      scopes: [],
    },
    team: current.team,
  };
}
