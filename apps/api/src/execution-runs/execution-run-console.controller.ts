import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { runInterventionResolveInputSchema } from "@devproof/contracts";

import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import { parseBody } from "../common/validation.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { ExecutionRunService } from "./execution-run.service.js";

@Controller("console/api/runs")
@UseGuards(AuthGuard)
export class ExecutionRunConsoleController {
  constructor(private readonly runs: ExecutionRunService) {}

  @Get()
  list(@CurrentAuth() current: AuthContext) {
    return this.runs.list(asToolContext(current));
  }

  @Get(":id")
  detail(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.runs.consoleDetail(asToolContext(current), id);
  }

  @Get(":id/evidences/:evidenceId/download")
  async downloadEvidence(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Param("evidenceId") evidenceId: string,
    @Res() reply: FastifyReply,
    @Headers("range") range?: string,
  ) {
    const artifact = await this.runs.downloadEvidence(
      asToolContext(current),
      id,
      evidenceId,
      range,
    );
    reply
      .header("cache-control", "private, no-store")
      .header("accept-ranges", "bytes")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .header(
        "content-disposition",
        /^(?:image\/(?:png|jpeg|webp|gif)|video\/(?:webm|mp4))$/u.test(
          artifact.contentType,
        )
          ? "inline"
          : "attachment",
      )
      .type(artifact.contentType);
    if (artifact.contentLength !== undefined)
      reply.header("content-length", artifact.contentLength);
    if (artifact.contentRange)
      reply.code(206).header("content-range", artifact.contentRange);
    return reply.send(artifact.body);
  }

  @Get(":id/events")
  async events(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    const events = await this.runs.events(asToolContext(current), id);
    return events.map((event) => ({
      ...event,
      sequence: event.sequence.toString(),
    }));
  }

  @Get(":id/trajectory")
  trajectory(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Query("before") before?: string,
    @Query("limit") rawLimit?: string,
  ) {
    if (before !== undefined && !/^\d+$/u.test(before)) {
      throw new BadRequestException(
        "before must be a positive event sequence.",
      );
    }
    if (rawLimit !== undefined && !/^\d+$/u.test(rawLimit)) {
      throw new BadRequestException(
        "limit must be an integer between 50 and 1000.",
      );
    }
    const limit = rawLimit === undefined ? 500 : Number(rawLimit);
    if (limit < 50 || limit > 1_000) {
      throw new BadRequestException(
        "limit must be an integer between 50 and 1000.",
      );
    }
    return this.runs.trajectory(asToolContext(current), id, {
      ...(before === undefined ? {} : { before: BigInt(before) }),
      limit,
    });
  }

  @Post(":id/cancel")
  cancel(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.runs.cancel(asToolContext(current), id);
  }

  @Post(":id/interventions/:interventionId/resolve")
  resolveIntervention(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Param("interventionId") interventionId: string,
    @Body() body: unknown,
  ) {
    return this.runs.resolveIntervention(
      asToolContext(current),
      id,
      interventionId,
      parseBody(runInterventionResolveInputSchema, body),
    );
  }
}

function asToolContext(current: AuthContext): ToolAuthContext {
  return {
    credential: {
      id: current.user.id,
      name: current.user.name ?? current.user.email ?? "Console user",
      scopes: ["run:read", "run:write", "run:cancel"],
    },
    team: current.team,
  };
}
