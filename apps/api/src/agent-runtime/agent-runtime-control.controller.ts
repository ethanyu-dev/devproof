import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { runtimeRegistrationInputSchema } from "@devproof/agent-runtime-protocol";

import { parseBody } from "../common/validation.js";
import { CurrentToolAuth } from "../tool-auth/current-tool-auth.decorator.js";
import { ToolAuthGuard } from "../tool-auth/tool-auth.guard.js";
import { requireAgentRuntimeIdentity } from "../tool-auth/tool-scope.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { AgentRuntimeControlService } from "./agent-runtime-control.service.js";

@Controller("internal/v2/runtime")
@UseGuards(ToolAuthGuard)
export class AgentRuntimeControlController {
  constructor(private readonly control: AgentRuntimeControlService) {}

  @Post("registration")
  register(@CurrentToolAuth() current: ToolAuthContext, @Body() body: unknown) {
    requireAgentRuntimeIdentity(current);
    return this.control.register(
      current,
      parseBody(runtimeRegistrationInputSchema, body),
    );
  }
}
