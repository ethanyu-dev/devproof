import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { toolCredentialCreateInputSchema } from "@devproof/contracts";

import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import { parseBody } from "../common/validation.js";
import { ToolAuthService } from "./tool-auth.service.js";

@Controller("console/api/tool-credentials")
@UseGuards(AuthGuard)
export class ToolCredentialsController {
  constructor(private readonly credentials: ToolAuthService) {}

  @Get()
  list(@CurrentAuth() current: AuthContext) {
    return this.credentials.list(current);
  }

  @Post()
  create(@CurrentAuth() current: AuthContext, @Body() body: unknown) {
    return this.credentials.create(
      current,
      parseBody(toolCredentialCreateInputSchema, body),
    );
  }

  @Delete(":id")
  async revoke(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    await this.credentials.revoke(current, id);
    return { ok: true };
  }
}
