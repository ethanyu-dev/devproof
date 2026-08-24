import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import {
  playgroundRunInputSchema,
  specificationPlaygroundInputSchema,
} from "@devproof/contracts";

import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import { parseBody } from "../common/validation.js";
import { PlaygroundService } from "./playground.service.js";

@Controller("console/api/playground")
@UseGuards(AuthGuard)
export class PlaygroundController {
  constructor(private readonly playground: PlaygroundService) {}

  @Get("readiness")
  readiness(@CurrentAuth() current: AuthContext) {
    return this.playground.readiness(current);
  }

  @Post("runs")
  createRun(@CurrentAuth() current: AuthContext, @Body() body: unknown) {
    return this.playground.createRun(
      current,
      parseBody(playgroundRunInputSchema, body),
    );
  }

  @Post("specifications/resolve")
  resolveSpecification(
    @CurrentAuth() current: AuthContext,
    @Body() body: unknown,
  ) {
    return this.playground.resolveSpecification(
      current,
      parseBody(specificationPlaygroundInputSchema, body),
    );
  }
}
