import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runtimeGeneratedSpecCaseSchema } from "@devproof/agent-runtime-protocol";
import {
  taskExecutionCreateInputSchema,
  testGenerationContextSchema,
} from "@devproof/contracts";
import type { ExecutionRunCreateInput } from "@devproof/contracts";
import { TaskExecutionService } from "./task-execution.service.js";
import { TaskProfileResolverService } from "./task-profile-resolver.service.js";
import { ProfileReservationService } from "./profile-reservation.service.js";

// Opt in only with a disposable database; normal unit tests never touch local data.
const url = process.env.DEVPROOF_CASE_RERUN_TEST_DATABASE_URL;
if (
  url &&
  !/^\/devproof_case_rerun_test_[a-f0-9]{8}$/.test(new URL(url).pathname)
)
  throw new Error(
    "Case rerun integration tests require a disposable database.",
  );

describe.skipIf(!url)("Case rerun database lifecycle", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url! }),
    });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it("atomically clones one Case, deduplicates concurrent requests, dispatches its environments and completes without the unselected Case", async () => {
    const suffix = randomUUID();
    const team = await db.team.create({
      data: { slug: suffix, feishuTenantKey: suffix, name: "Case replay test" },
    });
    const current = {
      team,
      credential: { id: "test-credential", name: "test", scopes: [] },
    } as never;
    const oldDate = new Date("2020-01-01T00:00:00Z");
    const source = await db.taskExecution.create({
      data: {
        teamId: team.id,
        idempotencyKey: `source:${suffix}`,
        kind: "ISSUE_SPEC",
        title: "ENG-123",
        inputSnapshot: taskExecutionCreateInputSchema.parse({
          kind: "ISSUE_SPEC",
          issueRef: "ENG-123",
          idempotencyKey: `source:${suffix}`,
          deadlineSeconds: 3600,
        }),
        deadlineAt: oldDate,
        finishedAt: oldDate,
        lifecycle: "COMPLETED",
        executionDisposition: "BLOCKED",
        sourceKind: "LINEAR_ISSUE",
        sourceRef: "ENG-123",
        traceId: "a".repeat(32),
      },
    });
    const stage = await db.taskExecutionStage.create({
      data: {
        taskExecutionId: source.id,
        type: "SPEC_ANALYSIS",
        status: "SUCCEEDED",
        currentAttemptNumber: 1,
      },
    });
    const attempt = await db.taskStageAttempt.create({
      data: {
        stageId: stage.id,
        number: 1,
        status: "SUCCEEDED",
        inputSnapshot: {},
      },
    });
    const sourceRef = `analysis-source://${attempt.id}/${randomUUID()}`;
    await db.taskAnalysisSource.create({
      data: {
        taskExecutionId: source.id,
        teamId: team.id,
        stageAttemptId: attempt.id,
        externalId: sourceRef,
        kind: "LINEAR_ISSUE",
        label: "需求",
        uri: "https://linear.app/team/issue/ENG-123",
        content: { description: "核验页面" },
        contentHash: "c".repeat(64),
        byteSize: 32,
      },
    });
    const definition = runtimeGeneratedSpecCaseSchema.parse({
      name: "独立核验",
      sourceRefs: [sourceRef],
      preconditions: ["环境可用"],
      rationale: "需求核验",
      steps: [
        { order: 1, action: "打开页面", expectedObservation: "页面可见" },
      ],
      criteria: [
        {
          id: "visible",
          description: "目标可见",
          sourceRefs: [sourceRef],
          required: true,
          requiredEvidenceKinds: ["DOM"],
        },
      ],
    });
    const snapshot = await db.taskSpecificationSnapshot.create({
      data: {
        taskExecutionId: source.id,
        stageAttemptId: attempt.id,
        sourceHash: "b".repeat(64),
        generatorKind: "AGENT",
        generatorVersion: "1",
        completeness: "COMPLETE",
        summary: "Two Cases",
        primaryPullRequestUrl: "https://github.com/example/repo/pull/1",
        context: testGenerationContextSchema.parse({
          issue: {
            id: "ENG-123",
            identifier: "ENG-123",
            title: "需求",
            url: "https://linear.app/team/issue/ENG-123",
          },
        }),
        cases: {
          create: [0, 1].map((position) => ({
            position,
            name: position === 0 ? "独立核验" : "不应重跑",
            definition: {
              ...definition,
              name: position === 0 ? "独立核验" : "不应重跑",
            },
            definitionHash: "d".repeat(64),
          })),
        },
      },
      include: { cases: { orderBy: { position: "asc" } } },
    });
    for (const key of ["preview", "staging"]) {
      const deployment = await db.taskDeployment.create({
        data: {
          taskExecutionId: source.id,
          key,
          name: key,
          targetUrl: `https://${key}.example.com`,
        },
      });
      for (const testCase of snapshot.cases) {
        const run = await db.executionRun.create({
          data: {
            teamId: team.id,
            taskExecutionId: source.id,
            idempotencyKey: randomUUID(),
            goal: testCase.name,
            lifecycle: "COMPLETED",
            executionDisposition: "BLOCKED",
            finishedAt: oldDate,
            criteriaSnapshot: [],
            initialDeadlineAt: oldDate,
            deadlineAt: oldDate,
            hardDeadlineAt: oldDate,
            traceId: "e".repeat(32),
          },
        });
        await db.taskCaseExecution.create({
          data: {
            taskExecutionId: source.id,
            caseId: testCase.id,
            deploymentId: deployment.id,
            runId: run.id,
            dispatchStatus: "LINKED",
            executionPolicy: { accessMode: "READ_ONLY" },
          },
        });
      }
    }
    const runs = {
      createForTask: vi.fn(
        async (
          _current: unknown,
          request: ExecutionRunCreateInput,
          taskId: string,
        ) =>
          db.executionRun.create({
            data: {
              taskExecutionId: taskId,
              teamId: team.id,
              idempotencyKey: request.idempotencyKey,
              goal: request.goal,
              lifecycle: "COMPLETED",
              executionDisposition: "EXECUTED",
              verdict: "PASSED",
              finishedAt: new Date(),
              criteriaSnapshot: request.criteria,
              initialDeadlineAt: new Date(Date.now() + 900_000),
              deadlineAt: new Date(Date.now() + 900_000),
              hardDeadlineAt: new Date(Date.now() + 900_000),
              traceId: "f".repeat(32),
            },
          }),
      ),
    };
    const profiles = new TaskProfileResolverService(db as never, {} as never);
    const reservations = new ProfileReservationService(db as never);
    const github = { hasCandidateForRepository: vi.fn() };
    const service = new TaskExecutionService(
      db as never,
      {} as never,
      runs as never,
      profiles as never,
      reservations as never,
      github as never,
    );
    const selected = snapshot.cases[0]!;
    const [first, duplicate] = await Promise.all(
      [1, 2].map(() =>
        service.rerunCaseAsTask(current, source.id, selected.id, {
          idempotencyKey: `replay:${suffix}`,
        }),
      ),
    );
    expect(first.id).toBe(duplicate.id);
    expect(await db.taskExecution.count({ where: { teamId: team.id } })).toBe(
      2,
    );
    expect(first.cases).toHaveLength(1);
    expect(first.counts.total).toBe(2);
    expect(
      first.stages.find((item) => item.type === "SPEC_ANALYSIS")?.status,
    ).toBe("SUCCEEDED");
    expect(first.caseRerunSource).toMatchObject({
      taskId: source.id,
      caseId: selected.id,
    });
    expect(
      (await service.detail(current, source.id)).cases[0]!.latestRerunTaskId,
    ).toBe(first.id);
    expect(
      await db.taskExecution.findUnique({ where: { id: source.id } }),
    ).toMatchObject({
      deadlineAt: oldDate,
      lifecycle: "COMPLETED",
      executionDisposition: "BLOCKED",
    });
    const progress = await service.reconcile();
    expect(progress).toMatchObject({
      analyzed: 0,
      profilesResolved: 1,
      dispatched: 2,
    });
    expect(runs.createForTask).toHaveBeenCalledTimes(2);
    for (const [, request] of runs.createForTask.mock.calls) {
      expect(request.goal).toContain("独立核验");
      expect(request.goal).not.toContain("不应重跑");
      expect(request.criteria).toHaveLength(1);
      expect(request.businessReferences).toHaveLength(1);
      expect(request.businessReferences[0]!.externalId).toContain(first.id);
      expect(request.criteria[0]!.description).toContain(
        request.businessReferences[0]!.externalId,
      );
    }
    await service.projectTask(first.id);
    const completed = await service.detail(current, first.id);
    expect(completed).toMatchObject({
      lifecycle: "COMPLETED",
      verdict: "PASSED",
      counts: { total: 2, passed: 2 },
    });
    expect(github.hasCandidateForRepository).not.toHaveBeenCalled();
    const second = await service.rerun(current, first.id);
    expect(second.cases).toHaveLength(1);
    expect(second.caseRerunSource?.taskId).toBe(first.id);
    expect(second.counts.total).toBe(2);
  }, 30_000);
});
