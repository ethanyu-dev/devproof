import { Injectable } from "@nestjs/common";
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { from, lastValueFrom } from "rxjs";

import type { ToolAuthenticatedRequest } from "../tool-auth/tool-auth.guard.js";
import { ToolInvocationService } from "./tool-invocation.service.js";

function routeToolName(request: FastifyRequest) {
  const route = request.routeOptions.url;
  const key = `${request.method} ${route}`;
  return (
    {
      "GET /v1/execution-runners": "list_execution_runners",
      "GET /v1/verifications": "list_verifications",
      "GET /v1/verifications/:id": "get_verification",
      "GET /v1/verifications/:id/events": "list_verification_events",
      "POST /v1/verifications": "create_verification",
      "POST /v1/verifications/:id/cancel": "cancel_verification",
      "POST /v1/verifications/:id/checkpoints": "request_human_input",
      "POST /v1/verifications/:id/events": "append_verification_event",
      "POST /v1/verifications/:id/execution": "ensure_execution",
      "POST /v1/verifications/:id/execution/commands":
        "execute_browser_command",
      "POST /v1/verifications/:id/execution/release": "release_execution",
      "POST /v1/verifications/:id/result": "complete_verification",
    }[key] ?? `http:${request.method.toLowerCase()}:${route}`
  );
}

@Injectable()
export class ToolInvocationInterceptor implements NestInterceptor {
  constructor(private readonly invocations: ToolInvocationService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context
      .switchToHttp()
      .getRequest<ToolAuthenticatedRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    if (!request.url.startsWith("/v1/") || !request.devproofToolAuth) {
      return next.handle();
    }
    const params = request.params as { id?: string };
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    if (request.raw.aborted) abort();
    else request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    return from(
      this.invocations
        .run(
          {
            arguments: {
              body: request.body ?? {},
              params: request.params,
              query: request.query,
            },
            ...((request.headers["x-devproof-client-name"] ??
            request.headers["user-agent"])
              ? {
                  clientName: String(
                    request.headers["x-devproof-client-name"] ??
                      request.headers["user-agent"],
                  ),
                }
              : {}),
            ...(request.headers["x-devproof-client-version"]
              ? {
                  clientVersion: String(
                    request.headers["x-devproof-client-version"],
                  ),
                }
              : {}),
            current: request.devproofToolAuth,
            requestId: request.id,
            ...(params.id ? { runId: params.id } : {}),
            toolName: routeToolName(request),
            transport: "HTTP",
          },
          () => lastValueFrom(next.handle()),
          abortController.signal,
        )
        .finally(() => {
          request.raw.removeListener("aborted", abort);
          reply.raw.removeListener("close", abort);
        }),
    );
  }
}
