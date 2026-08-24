import {
  Controller,
  Get,
  GoneException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { TestSpecificationService } from "./test-specification.service.js";

@Controller("console/api/specifications")
@UseGuards(AuthGuard)
export class TestSpecificationConsoleController {
  constructor(private readonly specifications: TestSpecificationService) {}

  @Get()
  list(@CurrentAuth() current: AuthContext) {
    return this.specifications.list(asToolContext(current));
  }

  @Post("resolve")
  resolve() {
    throw legacySpecificationWriteRemoved();
  }

  @Post("sync")
  sync() {
    throw legacySpecificationWriteRemoved();
  }

  @Get(":id")
  get(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.specifications.get(asToolContext(current), id);
  }

  @Post(":id/regenerate")
  regenerate() {
    throw legacySpecificationWriteRemoved();
  }

  @Post(":id/deployment-target")
  setDeploymentTarget() {
    throw legacySpecificationWriteRemoved();
  }
}

function legacySpecificationWriteRemoved() {
  return new GoneException(
    "Specification writes moved to /console/api/tasks. Create an ISSUE_SPEC task instead.",
  );
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
