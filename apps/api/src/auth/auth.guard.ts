import { ForbiddenException, Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { env } from "../config/env.js";
import { AuthService } from "./auth.service.js";
import type { AuthContext } from "./auth.types.js";

export type AuthenticatedRequest = FastifyRequest & {
  devproofAuth?: AuthContext;
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin !== env().WEB_ORIGIN) {
        throw new ForbiddenException("Mutation origin is not allowed.");
      }
    }

    request.devproofAuth = await this.auth.authenticate(request);
    return true;
  }
}
