import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  taskDeploymentTargetInputSchema,
  taskDeploymentsInputSchema,
  taskExecutionCreateInputSchema,
  taskProfileSelectionInputSchema,
  taskStageRetryInputSchema,
  executionConcurrencyPolicySchema,
} from "@devproof/contracts";

import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import { parseBody } from "../common/validation.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { TaskExecutionService } from "./task-execution.service.js";

@Controller("console/api/tasks")
@UseGuards(AuthGuard)
export class TaskExecutionConsoleController {
  constructor(private readonly tasks: TaskExecutionService) {}

  @Post()
  @HttpCode(202)
  create(@CurrentAuth() current: AuthContext, @Body() body: unknown) {
    return this.tasks.create(
      taskToolContext(current),
      parseBody(taskExecutionCreateInputSchema, body),
      { kind: "USER", triggerSource: "CONSOLE", userId: current.user.id },
    );
  }

  @Get()
  list(
    @CurrentAuth() current: AuthContext,
    @Query("page") rawPage?: string,
    @Query("pageSize") rawPageSize?: string,
    @Query("query") rawQuery?: string,
    @Query("status") rawStatus?: string,
    @Query("kind") rawKind?: string,
    @Query("createdAfter") rawCreatedAfter?: string,
  ) {
    const createdAfter = optionalDate(rawCreatedAfter, "createdAfter");
    const kind = optionalEnum(
      rawKind,
      ["ISSUE_SPEC", "DIRECT_RUN", "LEGACY_RUN"] as const,
      "kind",
    );
    const query = optionalText(rawQuery, 200, "query");
    const status = optionalEnum(
      rawStatus,
      [
        "ACTIVE",
        "WAITING_HUMAN",
        "PASSED",
        "FAILED",
        "VERIFICATION_FAILED",
        "EXECUTION_FAILED",
        "COMPLETED",
        "CANCELLED",
        "TIMED_OUT",
      ] as const,
      "status",
    );
    return this.tasks.listPage(
      taskToolContext(current),
      positiveInteger(rawPage, 1, 1, 10_000, "page"),
      positiveInteger(rawPageSize, 10, 5, 50, "pageSize"),
      {
        ...(createdAfter ? { createdAfter } : {}),
        ...(kind ? { kind } : {}),
        ...(query ? { query } : {}),
        ...(status ? { status } : {}),
      },
    );
  }

  @Get(":id")
  detail(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.tasks.detail(taskToolContext(current), id);
  }

  @Get(":id/events")
  events(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.tasks.events(taskToolContext(current), id);
  }

  @Post(":id/cases/:caseExecutionId/policy")
  setCaseExecutionPolicy(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Param("caseExecutionId") caseExecutionId: string,
    @Body() body: unknown,
  ) {
    return this.tasks.setCaseExecutionPolicy(
      taskToolContext(current),
      id,
      caseExecutionId,
      parseBody(executionConcurrencyPolicySchema, body),
    );
  }

  @Get(":id/logs/export")
  exportLogs(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.tasks.exportLogs(taskToolContext(current), id);
  }

  @Post(":id/deployment-target")
  setDeploymentTarget(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(taskDeploymentTargetInputSchema, body);
    return this.tasks.setDeploymentTarget(
      taskToolContext(current),
      id,
      input.url,
    );
  }

  @Post(":id/deployments")
  setDeployments(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.tasks.setDeployments(
      taskToolContext(current),
      id,
      parseBody(taskDeploymentsInputSchema, body),
    );
  }

  @Post(":id/profile")
  selectProfile(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.tasks.selectProfile(
      taskToolContext(current),
      current.user.id,
      id,
      parseBody(taskProfileSelectionInputSchema, body),
    );
  }

  @Post(":id/stages/:stage/retry")
  retryStage(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Param("stage") stage: string,
    @Body() body: unknown,
  ) {
    return this.tasks.retryStage(
      taskToolContext(current),
      id,
      stage,
      parseBody(taskStageRetryInputSchema, body),
    );
  }

  @Post(":id/cases/:caseId/rerun")
  rerunCase(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Param("caseId") caseId: string,
  ) {
    return this.tasks.rerunCase(taskToolContext(current), id, caseId);
  }

  @Post(":id/cases/:caseId/deployments/:deploymentId/rerun")
  rerunCaseDeployment(
    @CurrentAuth() current: AuthContext,
    @Param("id") id: string,
    @Param("caseId") caseId: string,
    @Param("deploymentId") deploymentId: string,
  ) {
    return this.tasks.rerunCase(
      taskToolContext(current),
      id,
      caseId,
      deploymentId,
    );
  }

  @Post(":id/cancel")
  cancel(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.tasks.cancel(taskToolContext(current), id);
  }

  @Post(":id/rerun")
  rerun(@CurrentAuth() current: AuthContext, @Param("id") id: string) {
    return this.tasks.rerun(taskToolContext(current), id, {
      kind: "USER",
      triggerSource: "CONSOLE",
      userId: current.user.id,
    });
  }
}

function positiveInteger(
  rawValue: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
) {
  if (rawValue === undefined) return fallback;
  if (!/^\d+$/u.test(rawValue)) {
    throw new BadRequestException(`${field} must be an integer.`);
  }
  const value = Number(rawValue);
  if (value < minimum || value > maximum) {
    throw new BadRequestException(
      `${field} must be between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function optionalText(
  rawValue: string | undefined,
  maximum: number,
  field: string,
) {
  if (rawValue === undefined) return undefined;
  const value = rawValue.trim();
  if (!value) return undefined;
  if (value.length > maximum) {
    throw new BadRequestException(
      `${field} must not exceed ${maximum} characters.`,
    );
  }
  return value;
}

function optionalDate(rawValue: string | undefined, field: string) {
  if (rawValue === undefined) return undefined;
  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} must be an ISO date-time.`);
  }
  return date;
}

function optionalEnum<const Values extends readonly string[]>(
  rawValue: string | undefined,
  values: Values,
  field: string,
): Values[number] | undefined {
  if (rawValue === undefined) return undefined;
  if (!(values as readonly string[]).includes(rawValue)) {
    throw new BadRequestException(`${field} is not supported.`);
  }
  return rawValue as Values[number];
}

export function taskToolContext(current: AuthContext): ToolAuthContext {
  return {
    credential: {
      id: current.user.id,
      name: current.user.name ?? current.user.email ?? "Console user",
      scopes: ["run:read", "run:write", "run:cancel"],
    },
    team: current.team,
  };
}
