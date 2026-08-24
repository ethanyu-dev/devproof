import { All, Controller, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { CurrentToolAuth } from "../tool-auth/current-tool-auth.decorator.js";
import { ToolAuthGuard } from "../tool-auth/tool-auth.guard.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { VerificationMcpService } from "./mcp.service.js";

@Controller("mcp")
@UseGuards(ToolAuthGuard)
export class VerificationMcpController {
  constructor(private readonly mcp: VerificationMcpService) {}

  @All()
  handle(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @CurrentToolAuth() current: ToolAuthContext,
  ) {
    return this.mcp.handle(request, reply, current);
  }
}
