import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import type { FastifyReply } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import type { AuthContext } from "../auth/auth.types.js";
import { parseBody } from "../common/validation.js";
import { ExecutionContextService } from "./execution-context.service.js";

const identity = z.object({
  runId: z.string().uuid(),
  attempt: z.coerce.number().int().positive(),
});
const search = z.object({
  q: z.string().max(500).optional(),
  caseId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  status: z
    .enum([
      "PENDING",
      "RUNNING",
      "WAITING_HUMAN",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
      "TIMED_OUT",
    ])
    .optional(),
});

@Controller("console/api/execution-contexts")
@UseGuards(AuthGuard)
export class ExecutionContextController {
  constructor(private readonly contexts: ExecutionContextService) {}

  @Header("Cache-Control", "private, no-store")
  @Get()
  list(@CurrentAuth() current: AuthContext, @Query() query: unknown) {
    return this.contexts.list(current.team.id, parseBody(search, query));
  }

  @Header("Cache-Control", "private, no-store")
  @Get(":runId/:attempt")
  detail(@CurrentAuth() current: AuthContext, @Param() params: unknown) {
    const p = parseBody(identity, params);
    return this.contexts.detail(current.team.id, p.runId, p.attempt);
  }

  @Header("Cache-Control", "private, no-store")
  @Get(":runId/:attempt/steps/:callId")
  content(@CurrentAuth() current: AuthContext, @Param() params: unknown) {
    const p = parseBody(identity.extend({ callId: z.string().uuid() }), params);
    return this.contexts.content(current.team.id, p.runId, p.attempt, p.callId);
  }

  @Header("Cache-Control", "private, no-store")
  @Get(":runId/:attempt/steps/:callId/download")
  async download(
    @CurrentAuth() current: AuthContext,
    @Param() params: unknown,
    @Res() reply: FastifyReply,
  ) {
    const p = parseBody(identity.extend({ callId: z.string().uuid() }), params);
    const content = await this.contexts.content(
      current.team.id,
      p.runId,
      p.attempt,
      p.callId,
    );
    return reply
      .header("cache-control", "private, no-store")
      .header(
        "content-disposition",
        `attachment; filename="${p.runId}+${p.attempt}-${p.callId}.json"`,
      )
      .type("application/json")
      .send(JSON.stringify(content));
  }
}
