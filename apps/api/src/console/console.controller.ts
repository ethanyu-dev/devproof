import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import {
  humanControlInputSchema,
  runtimeCommandInputSchema,
  runtimeConfigurationInputSchema,
  runtimeRoutingRuleInputSchema,
  runtimeSessionCreateInputSchema,
  runtimeSettingsInputSchema,
} from "@devproof/contracts";

import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import { parseBody } from "../common/validation.js";
import { BrowserRuntimeService } from "./browser-runtime.service.js";
import { ConsoleService } from "./console.service.js";
import { RuntimeSessionsService } from "../runtime/runtime-sessions.service.js";
import { RuntimeRoutingService } from "./runtime-routing.service.js";

@Controller("console/api")
@UseGuards(AuthGuard)
export class ConsoleController {
  constructor(
    private readonly consoleService: ConsoleService,
    private readonly runtimes: BrowserRuntimeService,
    private readonly routing: RuntimeRoutingService,
    private readonly runtimeSessions: RuntimeSessionsService,
  ) {}

  @Get("runtime-settings")
  runtimeSettings(@CurrentAuth() current: AuthContext) {
    return this.consoleService.getRuntimeSettings(current);
  }

  @Put("runtime-settings")
  saveRuntimeSettings(
    @CurrentAuth() current: AuthContext,
    @Body() body: unknown,
  ) {
    return this.consoleService.saveRuntimeSettings(
      current,
      parseBody(runtimeSettingsInputSchema, body),
    );
  }

  @Get("browser-runtimes")
  browserRuntimes(@CurrentAuth() current: AuthContext) {
    return this.runtimes.list(current);
  }

  @Post("browser-runtimes/pairing-tokens")
  createPairingToken(@CurrentAuth() current: AuthContext) {
    return this.runtimes.createPairingToken(current);
  }

  @Put("browser-runtimes/:id/configuration")
  updateRuntimeConfiguration(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.runtimes.updateConfiguration(
      current,
      id,
      parseBody(runtimeConfigurationInputSchema, body),
    );
  }

  @Delete("browser-runtimes/:id")
  async revokeRuntime(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
  ) {
    await this.runtimes.revoke(current, id);
    return { ok: true };
  }

  @Get("runtime-routing-rules")
  runtimeRoutingRules(@CurrentAuth() current: AuthContext) {
    return this.routing.list(current);
  }

  @Post("runtime-routing-rules")
  createRuntimeRoutingRule(
    @CurrentAuth() current: AuthContext,
    @Body() body: unknown,
  ) {
    return this.routing.create(
      current,
      parseBody(runtimeRoutingRuleInputSchema, body),
    );
  }

  @Put("runtime-routing-rules/:id")
  updateRuntimeRoutingRule(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.routing.update(
      current,
      id,
      parseBody(runtimeRoutingRuleInputSchema, body),
    );
  }

  @Delete("runtime-routing-rules/:id")
  async deleteRuntimeRoutingRule(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
  ) {
    await this.routing.remove(current, id);
    return { ok: true };
  }

  @Get("runtime-sessions")
  sessions(@CurrentAuth() current: AuthContext) {
    return this.runtimeSessions.list(current);
  }

  @Post("runtime-sessions")
  createSession(@CurrentAuth() current: AuthContext, @Body() body: unknown) {
    return this.runtimeSessions.create(
      current,
      parseBody(runtimeSessionCreateInputSchema, body),
    );
  }

  @Get("runtime-sessions/:id")
  session(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.runtimeSessions.detail(current, id);
  }

  @Post("runtime-sessions/:id/commands")
  executeRuntimeCommand(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.runtimeSessions.execute(
      current,
      id,
      parseBody(runtimeCommandInputSchema, body),
    );
  }

  @Delete("runtime-sessions/:id/commands/:commandId")
  cancelRuntimeCommand(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Param("commandId") commandId: string,
  ) {
    return this.runtimeSessions.cancel(current, id, commandId);
  }

  @Post("runtime-sessions/:id/close")
  closeRuntimeSession(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
  ) {
    return this.runtimeSessions.close(current, id);
  }

  @Post("runtime-sessions/:id/human-control")
  takeoverRuntimeSession(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.runtimeSessions.takeover(
      current,
      id,
      parseBody(humanControlInputSchema, body),
    );
  }

  @Delete("runtime-sessions/:id/human-control")
  releaseRuntimeSession(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
  ) {
    return this.runtimeSessions.release(current, id);
  }
}
