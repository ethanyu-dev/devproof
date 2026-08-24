import {
  Controller,
  Get,
  GoneException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CurrentToolAuth } from "../tool-auth/current-tool-auth.decorator.js";
import { ToolAuthGuard } from "../tool-auth/tool-auth.guard.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { requireToolScope } from "../tool-auth/tool-scope.js";
import { TestSpecificationService } from "./test-specification.service.js";

@Controller("v2/specifications")
@UseGuards(ToolAuthGuard)
export class TestSpecificationController {
  constructor(private readonly specifications: TestSpecificationService) {}

  @Get()
  list(@CurrentToolAuth() current: ToolAuthContext) {
    requireToolScope(current, "run:read");
    return this.specifications.list(current);
  }

  @Post("resolve")
  resolve(@CurrentToolAuth() current: ToolAuthContext) {
    requireToolScope(current, "run:write");
    throw legacySpecificationWriteRemoved();
  }

  @Post("sync")
  sync(@CurrentToolAuth() current: ToolAuthContext) {
    requireToolScope(current, "run:write");
    throw legacySpecificationWriteRemoved();
  }

  @Get(":id")
  get(@CurrentToolAuth() current: ToolAuthContext, @Param("id") id: string) {
    requireToolScope(current, "run:read");
    return this.specifications.get(current, id);
  }

  @Post(":id/regenerate")
  regenerate(@CurrentToolAuth() current: ToolAuthContext) {
    requireToolScope(current, "run:write");
    throw legacySpecificationWriteRemoved();
  }

  @Post(":id/deployment-target")
  setDeploymentTarget(@CurrentToolAuth() current: ToolAuthContext) {
    requireToolScope(current, "run:write");
    throw legacySpecificationWriteRemoved();
  }
}

function legacySpecificationWriteRemoved() {
  return new GoneException(
    "Specification writes moved to /v2/tasks. Create an ISSUE_SPEC task instead.",
  );
}
