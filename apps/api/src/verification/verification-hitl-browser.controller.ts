import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Sse,
  type MessageEvent,
  UseGuards,
} from "@nestjs/common";
import { browserHumanInputEventsSchema } from "@devproof/runtime-protocol";
import { Observable } from "rxjs";
import { z } from "zod";

import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import { parseBody } from "../common/validation.js";
import { VerificationHitlBrowserService } from "./verification-hitl-browser.service.js";

const controlSchema = z.object({ controlId: z.string().uuid() });
const inputSchema = controlSchema.extend({
  events: browserHumanInputEventsSchema,
});
const completeSchema = controlSchema.extend({
  note: z.string().trim().max(4000).default(""),
  resolution: z.enum(["continue", "cancel"]),
});

@Controller("console/api/verifications")
@UseGuards(AuthGuard)
export class VerificationHitlBrowserController {
  constructor(private readonly browser: VerificationHitlBrowserService) {}

  @Get(":runId/checkpoints/:checkpointId/browser")
  status(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("checkpointId") checkpointId: string,
  ) {
    return this.browser.status(current, runId, checkpointId);
  }

  @Post(":runId/checkpoints/:checkpointId/browser/control")
  claim(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("checkpointId") checkpointId: string,
  ) {
    return this.browser.claim(current, runId, checkpointId);
  }

  @Post(":runId/checkpoints/:checkpointId/browser/control/heartbeat")
  heartbeat(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("checkpointId") checkpointId: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(controlSchema, body);
    return this.browser.heartbeat(
      current,
      runId,
      checkpointId,
      input.controlId,
    );
  }

  @Post(":runId/checkpoints/:checkpointId/browser/control/input")
  input(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("checkpointId") checkpointId: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(inputSchema, body);
    return this.browser.input(
      current,
      runId,
      checkpointId,
      input.controlId,
      input.events,
    );
  }

  @Delete(":runId/checkpoints/:checkpointId/browser/control")
  release(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("checkpointId") checkpointId: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(controlSchema, body);
    return this.browser.release(current, runId, checkpointId, input.controlId);
  }

  @Post(":runId/checkpoints/:checkpointId/browser/complete")
  complete(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("checkpointId") checkpointId: string,
    @Body() body: unknown,
  ) {
    return this.browser.complete(
      current,
      runId,
      checkpointId,
      parseBody(completeSchema, body),
    );
  }

  @Sse(":runId/checkpoints/:checkpointId/browser/stream")
  stream(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("checkpointId") checkpointId: string,
  ): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let close: (() => Promise<void>) | undefined;
      void this.browser
        .stream(current, runId, checkpointId, (event) =>
          subscriber.next({ data: event }),
        )
        .then((cleanup) => {
          close = cleanup;
        })
        .catch((error: unknown) => {
          subscriber.next({
            data: {
              error: error instanceof Error ? error.message : String(error),
              type: "error",
            },
          });
          subscriber.complete();
        });
      return () => {
        void close?.().catch(() => undefined);
      };
    });
  }
}
