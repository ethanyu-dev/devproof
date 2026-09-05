import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  runtimeDrainAttestSchema,
  runtimeDrainCreateSchema,
  runtimeRecoveryRequestSchema,
  runtimeRecoveryResolveWriteOutcomeSchema,
  runtimeRecoveryRetrySchema,
  runtimeRecoveryClosureStateSchema,
} from "@devproof/contracts";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import type { AuthContext } from "../auth/auth.types.js";
import { parseBody } from "../common/validation.js";
import { SessionRecoveryService } from "./session-recovery.service.js";
import { RuntimeDrainService } from "./runtime-drain.service.js";

const querySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  state: runtimeRecoveryClosureStateSchema.optional(),
});
const idSchema = z.string().uuid();
@Controller("console/api")
@UseGuards(AuthGuard)
export class RuntimeRecoveryController {
  constructor(
    private readonly recoveries: SessionRecoveryService,
    private readonly drains: RuntimeDrainService,
  ) {}

  @Get("runtime-recoveries")
  list(@CurrentAuth() current: AuthContext, @Query() query: unknown) {
    const input = parseBody(querySchema, query);
    return this.recoveries.list(current, {
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
      ...(input.state ? { state: input.state } : {}),
    });
  }
  @Get("runtime-recoveries/:id")
  detail(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.recoveries.detail(current, parseBody(idSchema, id));
  }

  @Post("runtime-sessions/:id/recovery")
  request(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.recoveries.requestForUser(
      current,
      parseBody(idSchema, id),
      parseBody(runtimeRecoveryRequestSchema, body).reason,
    );
  }
  @Post("runtime-recoveries/:id/retry")
  retry(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.recoveries.retry(
      current,
      parseBody(idSchema, id),
      parseBody(runtimeRecoveryRetrySchema, body).expectedVersion,
    );
  }
  @Post("runtime-recoveries/:id/resolve-write-outcome")
  resolve(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.recoveries.resolveWriteOutcome(
      current,
      parseBody(idSchema, id),
      parseBody(runtimeRecoveryResolveWriteOutcomeSchema, body),
    );
  }
  @Get("runtimes/:id/drain-preview")
  preview(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.drains.preview(current, parseBody(idSchema, id));
  }
  @Post("runtimes/:id/drain")
  freeze(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.drains.freeze(
      current,
      parseBody(idSchema, id),
      parseBody(runtimeDrainCreateSchema, body),
    );
  }
  @Post("runtimes/:id/drain/:drainId/attest")
  attest(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Param("drainId") drainId: string,
    @Body() body: unknown,
  ) {
    return this.drains.attest(
      current,
      parseBody(idSchema, id),
      parseBody(idSchema, drainId),
      parseBody(runtimeDrainAttestSchema, body),
    );
  }
}
