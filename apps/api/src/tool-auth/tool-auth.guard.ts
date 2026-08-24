import { Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { ToolAuthService } from "./tool-auth.service.js";
import type { ToolAuthContext } from "./tool-auth.types.js";

export type ToolAuthenticatedRequest = FastifyRequest & {
  devproofToolAuth?: ToolAuthContext;
};

@Injectable()
export class ToolAuthGuard implements CanActivate {
  constructor(private readonly auth: ToolAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<ToolAuthenticatedRequest>();
    request.devproofToolAuth = await this.auth.authenticate(
      request.headers.authorization,
    );
    return true;
  }
}
