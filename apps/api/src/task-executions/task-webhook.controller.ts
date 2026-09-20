import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ToolAuthGuard } from "../tool-auth/tool-auth.guard.js";
import { CurrentToolAuth } from "../tool-auth/current-tool-auth.decorator.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { requireToolScope } from "../tool-auth/tool-scope.js";
import { TaskWebhookService } from "./task-webhook.service.js";

@Controller("v2/tasks/:taskId/webhooks")
@UseGuards(ToolAuthGuard)
export class TaskWebhookController {
  constructor(private readonly hooks: TaskWebhookService) {}
  @Post()
  create(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("taskId", new ParseUUIDPipe()) taskId: string,
    @Body() body: unknown,
  ) {
    requireToolScope(current, "run:write");
    requireToolScope(current, "run:read");
    return this.hooks.create(current, taskId, body);
  }
  @Get()
  list(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("taskId", new ParseUUIDPipe()) taskId: string,
  ) {
    requireToolScope(current, "run:read");
    return this.hooks.list(current, taskId);
  }
  @Get(":id/deliveries")
  deliveries(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("taskId", new ParseUUIDPipe()) taskId: string,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    requireToolScope(current, "run:read");
    return this.hooks.deliveries(current, taskId, id);
  }
  @Post(":id/deliveries/:deliveryId/retry")
  retryDelivery(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("taskId", new ParseUUIDPipe()) taskId: string,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("deliveryId", new ParseUUIDPipe()) deliveryId: string,
  ) {
    requireToolScope(current, "run:write");
    return this.hooks.retryDelivery(current, taskId, id, deliveryId);
  }
  @Delete(":id")
  disable(
    @CurrentToolAuth() current: ToolAuthContext,
    @Param("taskId", new ParseUUIDPipe()) taskId: string,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    requireToolScope(current, "run:write");
    return this.hooks.disable(current, taskId, id);
  }
}
