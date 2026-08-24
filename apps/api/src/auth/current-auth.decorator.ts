import { createParamDecorator, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";

import type { AuthenticatedRequest } from "./auth.guard.js";
import type { AuthContext } from "./auth.types.js";

export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.devproofAuth) {
      throw new UnauthorizedException();
    }
    return request.devproofAuth;
  },
);
