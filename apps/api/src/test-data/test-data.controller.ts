import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import {
  testCaseInputSchema,
  testCaseVersionInputSchema,
  testEnvironmentInputSchema,
  testProjectInputSchema,
  testRunCheckpointResolveInputSchema,
  testRunCreateInputSchema,
} from "@devproof/contracts";

import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/current-auth.decorator.js";
import { parseBody } from "../common/validation.js";
import { TestDataService } from "./test-data.service.js";

@Controller("console/api")
@UseGuards(AuthGuard)
export class TestDataController {
  constructor(private readonly testData: TestDataService) {}

  @Get("test-projects")
  projects(@CurrentAuth() current: AuthContext) {
    return this.testData.listProjects(current);
  }

  @Post("test-projects")
  createProject(@CurrentAuth() current: AuthContext, @Body() body: unknown) {
    return this.testData.createProject(
      current,
      parseBody(testProjectInputSchema, body),
    );
  }

  @Put("test-projects/:projectId")
  updateProject(
    @CurrentAuth() current: AuthContext,
    @Param("projectId") projectId: string,
    @Body() body: unknown,
  ) {
    return this.testData.updateProject(
      current,
      projectId,
      parseBody(testProjectInputSchema, body),
    );
  }

  @Get("test-projects/:projectId/environments")
  environments(
    @CurrentAuth() current: AuthContext,
    @Param("projectId") projectId: string,
  ) {
    return this.testData.listEnvironments(current, projectId);
  }

  @Post("test-projects/:projectId/environments")
  createEnvironment(
    @CurrentAuth() current: AuthContext,
    @Param("projectId") projectId: string,
    @Body() body: unknown,
  ) {
    return this.testData.createEnvironment(
      current,
      projectId,
      parseBody(testEnvironmentInputSchema, body),
    );
  }

  @Put("test-environments/:environmentId")
  updateEnvironment(
    @CurrentAuth() current: AuthContext,
    @Param("environmentId") environmentId: string,
    @Body() body: unknown,
  ) {
    return this.testData.updateEnvironment(
      current,
      environmentId,
      parseBody(testEnvironmentInputSchema, body),
    );
  }

  @Get("test-projects/:projectId/cases")
  cases(
    @CurrentAuth() current: AuthContext,
    @Param("projectId") projectId: string,
  ) {
    return this.testData.listCases(current, projectId);
  }

  @Post("test-projects/:projectId/cases")
  createCase(
    @CurrentAuth() current: AuthContext,
    @Param("projectId") projectId: string,
    @Body() body: unknown,
  ) {
    return this.testData.createCase(
      current,
      projectId,
      parseBody(testCaseInputSchema, body),
    );
  }

  @Get("test-cases/:caseId")
  caseDetail(
    @CurrentAuth() current: AuthContext,
    @Param("caseId") caseId: string,
  ) {
    return this.testData.caseDetail(current, caseId);
  }

  @Put("test-cases/:caseId")
  updateCase(
    @CurrentAuth() current: AuthContext,
    @Param("caseId") caseId: string,
    @Body() body: unknown,
  ) {
    return this.testData.updateCase(
      current,
      caseId,
      parseBody(testCaseInputSchema, body),
    );
  }

  @Post("test-cases/:caseId/versions")
  createCaseVersion(
    @CurrentAuth() current: AuthContext,
    @Param("caseId") caseId: string,
    @Body() body: unknown,
  ) {
    return this.testData.createCaseVersion(
      current,
      caseId,
      parseBody(testCaseVersionInputSchema, body),
    );
  }

  @Get("test-runs")
  runs(@CurrentAuth() current: AuthContext) {
    return this.testData.listRuns(current);
  }

  @Post("test-runs")
  createRun(@CurrentAuth() current: AuthContext, @Body() body: unknown) {
    return this.testData.createRun(
      current,
      parseBody(testRunCreateInputSchema, body),
    );
  }

  @Get("test-runs/:runId")
  runDetail(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
  ) {
    return this.testData.runDetail(current, runId);
  }

  @Post("test-runs/:runId/checkpoints/:checkpointId/resolve")
  resolveCheckpoint(
    @CurrentAuth() current: AuthContext,
    @Param("runId") runId: string,
    @Param("checkpointId") checkpointId: string,
    @Body() body: unknown,
  ) {
    return this.testData.resolveCheckpoint(
      current,
      runId,
      checkpointId,
      parseBody(testRunCheckpointResolveInputSchema, body),
    );
  }
}
