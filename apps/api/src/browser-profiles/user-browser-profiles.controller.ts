import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Sse,
  type MessageEvent,
  UseGuards,
} from "@nestjs/common";
import { browserHumanInputEventsSchema } from "@devproof/runtime-protocol";
import { Observable } from "rxjs";
import { z } from "zod";
import {
  userBrowserProfileCreateInputSchema,
  userBrowserProfilePrepareInputSchema,
  userBrowserProfileUpdateInputSchema,
} from "@devproof/contracts";

import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import { parseBody } from "../common/validation.js";
import { UserBrowserProfilesService } from "./user-browser-profiles.service.js";

const browserInputSchema = z.object({ events: browserHumanInputEventsSchema });

@Controller("console/api/browser-profiles")
@UseGuards(AuthGuard)
export class UserBrowserProfilesController {
  constructor(private readonly profiles: UserBrowserProfilesService) {}

  @Get()
  list(@CurrentAuth() current: AuthContext) {
    return this.profiles.list(current);
  }

  @Post()
  create(@CurrentAuth() current: AuthContext, @Body() body: unknown) {
    return this.profiles.create(
      current,
      parseBody(userBrowserProfileCreateInputSchema, body),
    );
  }

  @Get(":id")
  detail(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.profiles.detail(current, id);
  }

  @Put(":id")
  update(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.profiles.update(
      current,
      id,
      parseBody(userBrowserProfileUpdateInputSchema, body),
    );
  }

  @Post(":id/prepare")
  prepare(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.profiles.prepare(
      current,
      id,
      parseBody(userBrowserProfilePrepareInputSchema, body),
    );
  }

  @Post(":id/verify")
  verify(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.profiles.verify(current, id);
  }

  @Post(":id/close")
  close(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.profiles.closePreparation(current, id);
  }

  @Post(":id/approve")
  approve(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.profiles.approve(current, id);
  }

  @Post(":id/browser/input")
  input(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.profiles.input(
      current,
      id,
      parseBody(browserInputSchema, body).events,
    );
  }

  @Sse(":id/browser/stream")
  stream(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
  ): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let close: (() => Promise<void>) | undefined;
      let cancelled = false;
      void this.profiles
        .stream(current, id, (event) => subscriber.next({ data: event }))
        .then((cleanup) => {
          if (cancelled) void cleanup().catch(() => undefined);
          else close = cleanup;
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
        cancelled = true;
        void close?.().catch(() => undefined);
      };
    });
  }

  @Post(":id/reauth")
  reauth(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.profiles.reauth(
      current,
      id,
      parseBody(userBrowserProfilePrepareInputSchema, body),
    );
  }

  @Post(":id/disable")
  disable(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.profiles.disable(current, id);
  }

  @Delete(":id")
  @HttpCode(200)
  remove(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.profiles.remove(current, id);
  }
}
