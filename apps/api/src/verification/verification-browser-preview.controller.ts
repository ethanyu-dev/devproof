import {
  Controller,
  Get,
  Param,
  Sse,
  type MessageEvent,
  UseGuards,
} from "@nestjs/common";
import { Observable } from "rxjs";

import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import { VerificationBrowserPreviewService } from "./verification-browser-preview.service.js";

@Controller("console/api/verifications")
@UseGuards(AuthGuard)
export class VerificationBrowserPreviewController {
  constructor(private readonly browser: VerificationBrowserPreviewService) {}

  @Get(":runId/browser")
  status(@CurrentAuth() current: AuthContext, @Param("runId") runId: string) {
    return this.browser.status(current, runId);
  }

  @Sse(":runId/browser/stream")
  stream(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
  ): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let close: (() => Promise<void>) | undefined;
      void this.browser
        .stream(current, runId, (event) => subscriber.next({ data: event }))
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
