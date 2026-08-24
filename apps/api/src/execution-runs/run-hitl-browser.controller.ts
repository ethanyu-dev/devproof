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
import { RunHitlBrowserService } from "./run-hitl-browser.service.js";

const controlSchema = z.object({ controlId: z.string().uuid() });
const inputSchema = controlSchema.extend({
  events: browserHumanInputEventsSchema,
});
const completeSchema = controlSchema.extend({
  note: z.string().trim().max(4000).default(""),
  resolution: z.enum(["continue", "cancel"]),
});

@Controller("console/api/runs")
@UseGuards(AuthGuard)
export class RunHitlBrowserController {
  constructor(private readonly browser: RunHitlBrowserService) {}

  @Get(":runId/interventions/:interventionId/browser")
  status(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("interventionId") interventionId: string,
  ) {
    return this.browser.status(current, runId, interventionId);
  }

  @Post(":runId/interventions/:interventionId/browser/control")
  claim(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("interventionId") interventionId: string,
  ) {
    return this.browser.claim(current, runId, interventionId);
  }

  @Post(":runId/interventions/:interventionId/browser/control/heartbeat")
  heartbeat(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("interventionId") interventionId: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(controlSchema, body);
    return this.browser.heartbeat(
      current,
      runId,
      interventionId,
      input.controlId,
    );
  }

  @Post(":runId/interventions/:interventionId/browser/control/input")
  input(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("interventionId") interventionId: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(inputSchema, body);
    return this.browser.input(
      current,
      runId,
      interventionId,
      input.controlId,
      input.events,
    );
  }

  @Delete(":runId/interventions/:interventionId/browser/control")
  release(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("interventionId") interventionId: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(controlSchema, body);
    return this.browser.release(
      current,
      runId,
      interventionId,
      input.controlId,
    );
  }

  @Post(":runId/interventions/:interventionId/browser/complete")
  complete(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("interventionId") interventionId: string,
    @Body() body: unknown,
  ) {
    return this.browser.complete(
      current,
      runId,
      interventionId,
      parseBody(completeSchema, body),
    );
  }

  @Sse(":runId/interventions/:interventionId/browser/stream")
  stream(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("interventionId") interventionId: string,
  ): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let close: (() => Promise<void>) | undefined;
      void this.browser
        .stream(current, runId, interventionId, (event) =>
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
