import { createParamDecorator, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";

import type { ToolAuthenticatedRequest } from "./tool-auth.guard.js";
import type { ToolAuthContext } from "./tool-auth.types.js";

export const CurrentToolAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ToolAuthContext => {
    const request = context
      .switchToHttp()
      .getRequest<ToolAuthenticatedRequest>();
    if (!request.devproofToolAuth) {
      throw new UnauthorizedException();
    }
    return request.devproofToolAuth;
  },
);
