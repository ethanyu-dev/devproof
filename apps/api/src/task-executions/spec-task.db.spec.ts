import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runtimeGeneratedSpecSchema } from "@devproof/agent-runtime-protocol";
import type { ExecutionRunCreateInput } from "@devproof/contracts";
import { taskProfilePolicySchema } from "@devproof/contracts";
import { ContextSourceError } from "../specifications/context-source.error.js";
import { TaskExecutionService } from "./task-execution.service.js";
import { TaskProfileResolverService } from "./task-profile-resolver.service.js";
import { ProfileReservationService } from "./profile-reservation.service.js";
import { SpecAnalysisRuntimeService } from "../agent-runtime/spec-analysis-runtime.service.js";
import { IssueContextResolverService } from "../specifications/issue-context-resolver.service.js";
import { resetEnvForTests } from "../config/env.js";

const databaseUrl = process.env.DEVPROOF_SPEC_TASK_TEST_DATABASE_URL;
if (
  databaseUrl &&
  !/^\/devproof_spec_task_test_[a-f0-9]{8}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error("Spec task integration tests require a disposable database.");
const prUrl = "https://github.com/acme/web/pull/42";
const targetUrl = "https://preview.example.com";
const goal = "保存订单后显示已保存状态。";

describe.skipIf(!databaseUrl)(
  "source-independent task database lifecycle",
  () => {
    let db: PrismaClient;
    beforeAll(() => {
      db = new PrismaClient({
        adapter: new PrismaPg({ connectionString: databaseUrl! }),
      });
    });
    afterAll(async () => {
      await db?.$disconnect();
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      resetEnvForTests();
    });

    async function harness(mode = "AGENT") {
      vi.stubEnv("SPEC_ANALYSIS_MODE", mode);
      resetEnvForTests();
      const suffix = randomUUID();
      const team = await db.team.create({
        data: { name: "Spec task test", slug: suffix, feishuTenantKey: suffix },
      });
      const current = {
        team,
        credential: { id: "test", name: "test", scopes: [] },
      } as never;
      const linear = {
        getIssue: vi.fn().mockResolvedValue({
          issue: {
            id: "linear-1",
            identifier: "ENG-1",
            title: "订单保存",
            description: goal,
            url: "https://linear.app/acme/issue/ENG-1",
          },
          pullRequestUrls: [],
        }),
      };
      const github = {
        hasCandidateForRepository: vi.fn().mockResolvedValue(true),
        discoverIssuePullRequests: vi
          .fn()
          .mockResolvedValue({ pullRequestUrls: [], diagnostics: [] }),
        getPullRequest: vi.fn().mockResolvedValue({
          diagnostics: [],
          pullRequest: {
            id: "pr-42",
            title: "订单保存",
            body: goal,
            url: prUrl,
            repository: "acme/web",
            organization: "acme",
            number: 42,
            isPrimary: true,
            headSha: "head-a",
            changedFiles: ["src/save.ts"],
            deploymentUrl: targetUrl,
          },
        }),
        changedFiles: vi.fn().mockResolvedValue({
          revision: "head-a",
          total: 1,
          truncated: false,
          files: [
            {
              path: "src/save.ts",
              status: "modified",
              patch: "+ saveOrder();",
              patchTruncated: false,
            },
          ],
        }),
        readPullRequestFile: vi.fn().mockResolvedValue({
          revision: "head-a",
          content: "saveOrder();",
          path: "src/save.ts",
          startLine: 1,
          endLine: 1,
        }),
      };
      const runs = {
        createForTask: vi.fn(
          async (
            _: unknown,
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
      const service = new TaskExecutionService(
        db as never,
        new IssueContextResolverService(linear as never, github as never),
        runs as never,
        profiles,
        new ProfileReservationService(db as never),
        github as never,
      );
      const analysis = new SpecAnalysisRuntimeService(
        db as never,
        {
          candidatesForPool: async () => [
            {
              apiKey: "test",
              baseUrl: "https://models.example.com",
              displayName: "test",
              modelId: "test",
            },
          ],
        } as never,
        linear as never,
        github as never,
      );
      return {
        team,
        current,
        service,
        analysis,
        linear,
        github,
        runs,
        profiles,
      };
    }

    it.each(["PR", "ISSUE", "BRIEF", "PR_SHADOW"])(
      "generates and executes %s without the other source type",
      async (sourceKind) => {
        const h = await harness(
          sourceKind === "PR_SHADOW" ? "SHADOW" : "AGENT",
        );
        const isPr = sourceKind.startsWith("PR");
        const input = {
          kind: "SPEC_TASK",
          idempotencyKey: randomUUID(),
          targetUrl,
          ...(isPr
            ? { pullRequestUrls: [prUrl] }
            : sourceKind === "ISSUE"
              ? { issueRef: "ENG-1" }
              : { goal }),
        };
        const [created, duplicate] = await Promise.all([
          h.service.create(h.current, input),
          h.service.create(h.current, input),
        ]);
        expect(duplicate.id).toBe(created.id);
        const claim = await h.analysis.claim(h.team.id, {
          protocol: { minor: 21 },
          workerId: "test-worker",
        });
        expect(claim.task?.snapshot.contextVersion).toBe(2);
        const lease = claim.task!;
        const identity = {
          fencingToken: lease.fencingToken,
          leaseToken: lease.leaseToken,
          workerId: "test-worker",
        };
        const bootstrap = await h.analysis.executeTool(
          h.team.id,
          lease.taskId,
          {
            ...identity,
            callId: randomUUID(),
            name: "get_task_context",
            arguments: { analysisSummary: "读取测试依据" },
          },
        );
        expect(bootstrap.inputRequest).toBeUndefined();
        const refs = [...bootstrap.sourceRefs];
        if (isPr) {
          expect(h.linear.getIssue).not.toHaveBeenCalled();
          await expect(
            h.analysis.executeTool(h.team.id, lease.taskId, {
              ...identity,
              callId: randomUUID(),
              name: "github_get_pull_request",
              arguments: {
                analysisSummary: "越界来源",
                pullRequestUrl: "https://github.com/other/private/pull/1",
              },
            }),
          ).rejects.toThrow("selected for this task");
          for (const name of [
            "github_list_changed_files",
            "github_read_file",
          ] as const) {
            const output = await h.analysis.executeTool(
              h.team.id,
              lease.taskId,
              {
                ...identity,
                callId: randomUUID(),
                name,
                arguments: {
                  analysisSummary: "核对变更",
                  pullRequestUrl: prUrl,
                  path: "src/save.ts",
                },
              },
            );
            refs.push(...output.sourceRefs);
          }
          expect(h.github.readPullRequestFile).toHaveBeenCalledWith(
            expect.objectContaining({ expectedRevision: "head-a" }),
          );
        } else expect(h.github.getPullRequest).not.toHaveBeenCalled();
        const source = refs[0]!;
        const spec = runtimeGeneratedSpecSchema.parse({
          scopePolicy: "CHANGE_FOCUSED",
          summary: "验证订单保存",
          scope: { inScope: ["订单保存"] },
          requirements: [
            {
              id: "save",
              description: "订单保存状态持久化",
              sourceRef: source.externalId,
              quote: goal,
              ...(isPr
                ? {
                    changeBasis: {
                      sourceRef: source.externalId,
                      quote: goal,
                      reason: "PR 明确要求保存后显示状态。",
                    },
                  }
                : {}),
            },
          ],
          cases: [
            {
              name: "保存订单",
              accountRequirementsVersion: 2,
              accountRequirements: [],
              rationale: "验证保存结果",
              preconditions: ["环境可用"],
              sourceRefs: [source.externalId],
              steps: [
                {
                  order: 1,
                  action: "保存订单",
                  expectedObservation: "状态已保存",
                },
              ],
              criteria: [
                {
                  id: "saved",
                  requirementId: "save",
                  description: "显示已保存状态",
                  sourceRefs: [source.externalId],
                  basis: {
                    sourceRef: source.externalId,
                    quote: goal,
                    observationTarget: "保存状态",
                  },
                  observationTargets: [
                    { label: "保存状态", expectedText: "已保存" },
                  ],
                  requiredEvidenceKinds: ["DOM"],
                },
              ],
            },
          ],
        });
        const result = await h.analysis.submitOutcome(h.team.id, lease.taskId, {
          ...identity,
          completionId: randomUUID(),
          outcome: {
            kind: "SPEC_GENERATED",
            spec,
            sourceRefs: refs,
            summary: spec.summary,
          },
        });
        expect(result.stageStatus).toBe("SUCCEEDED");
        const snapshot = await db.taskSpecificationSnapshot.findFirstOrThrow({
          where: { taskExecutionId: created.id },
        });
        expect(snapshot.primaryPullRequestUrl).toBe(isPr ? prUrl : null);
        if (sourceKind !== "ISSUE")
          expect(snapshot.context).toMatchObject({ issue: null });
        await h.service.reconcile();
        const complete = await h.service.detail(h.current, created.id);
        expect(complete).toMatchObject({
          lifecycle: "COMPLETED",
          verdict: "PASSED",
          counts: { total: 1, passed: 1 },
        });
        expect(h.runs.createForTask).toHaveBeenCalledOnce();
        expect(
          await db.notificationOutbox.count({
            where: { taskExecutionId: created.id, channel: "GITHUB" },
          }),
        ).toBe(isPr ? 1 : 0);
        const fresh = await h.service.create(h.current, {
          ...input,
          idempotencyKey: randomUUID(),
        });
        expect(fresh.id).not.toBe(created.id);
        await h.service.cancel(h.current, fresh.id);
        const caseRerun = await h.service.rerunCaseAsTask(
          h.current,
          created.id,
          complete.cases[0]!.id,
          { idempotencyKey: randomUUID() },
        );
        expect(caseRerun.kind).toBe("SPEC_TASK");
        expect(caseRerun.specification?.context).toEqual(
          snapshot.context instanceof Object
            ? expect.objectContaining({
                issue: sourceKind === "ISSUE" ? expect.any(Object) : null,
              })
            : snapshot.context,
        );
        await h.service.reconcile();
        expect((await h.service.detail(h.current, caseRerun.id)).verdict).toBe(
          "PASSED",
        );
        const fullRerun = await h.service.rerun(h.current, created.id);
        expect(fullRerun.id).not.toBe(created.id);
        expect(fullRerun).toMatchObject({
          kind: "SPEC_TASK",
          input: {
            ...(isPr
              ? { pullRequestUrls: [prUrl] }
              : sourceKind === "ISSUE"
                ? { issueRef: "ENG-1" }
                : { goal }),
          },
        });
        await h.service.cancel(h.current, fullRerun.id);
      },
    );

    it("resumes a manual brief with an environment and preserves original creation idempotency", async () => {
      const h = await harness();
      const input = { kind: "SPEC_TASK", idempotencyKey: randomUUID(), goal };
      const created = await h.service.create(h.current, input);
      const { task } = await h.analysis.claim(h.team.id, {
        protocol: { minor: 21 },
        workerId: "test-worker",
      });
      const identity = {
        fencingToken: task!.fencingToken,
        leaseToken: task!.leaseToken,
        workerId: "test-worker",
      };
      const output = await h.analysis.executeTool(h.team.id, task!.taskId, {
        ...identity,
        callId: randomUUID(),
        name: "get_task_context",
        arguments: { analysisSummary: "读取测试说明" },
      });
      expect(output.inputRequest?.missing).toEqual(["DEPLOYMENT_TARGET"]);
      await h.analysis.submitOutcome(h.team.id, task!.taskId, {
        ...identity,
        completionId: randomUUID(),
        outcome: {
          kind: "INPUT_REQUIRED",
          request: output.inputRequest!,
          summary: "需要测试环境",
        },
      });
      const correction = {
        expectedAttemptId: task!.taskId,
        deployments: [
          { key: "preview", name: "Preview", targetUrl, environment: {} },
        ],
      };
      await h.service.provideAnalysisInput(h.current, created.id, correction);
      expect((await h.service.create(h.current, input)).id).toBe(created.id);
      await expect(
        h.service.provideAnalysisInput(h.current, created.id, correction),
      ).rejects.toThrow("任务已变化");
      expect(
        await db.taskStageAttempt.count({
          where: { stage: { taskExecutionId: created.id } },
        }),
      ).toBe(2);
    });

    it("allows replacing an unreadable Issue and its owner policy without losing the analysis wait", async () => {
      const h = await harness();
      h.linear.getIssue.mockRejectedValue(
        new ContextSourceError(
          "LINEAR",
          "NOT_FOUND",
          "Issue unavailable",
          "ENG-1",
          404,
        ),
      );
      const input = {
        kind: "ISSUE_SPEC",
        idempotencyKey: randomUUID(),
        issueRef: "ENG-1",
        targetUrl,
        profilePolicy: { strategy: "ISSUE_ASSIGNEE" },
      };
      const created = await h.service.create(h.current, input);
      const { task: lease } = await h.analysis.claim(h.team.id, {
        protocol: { minor: 21 },
        workerId: "owner-test",
      });
      const identity = {
        fencingToken: lease!.fencingToken,
        leaseToken: lease!.leaseToken,
        workerId: "owner-test",
      };
      const bootstrap = await h.analysis.executeTool(h.team.id, lease!.taskId, {
        ...identity,
        callId: randomUUID(),
        name: "get_task_context",
        arguments: { analysisSummary: "读取测试依据" },
      });
      expect(bootstrap.inputRequest?.missing).toEqual(["ISSUE"]);
      await h.analysis.submitOutcome(h.team.id, lease!.taskId, {
        ...identity,
        completionId: randomUUID(),
        outcome: {
          kind: "INPUT_REQUIRED",
          request: bootstrap.inputRequest!,
          summary: "需要修正来源",
        },
      });
      await h.profiles.select(h.team.id, "unused-user", created.id, {
        profilePolicy: taskProfilePolicySchema.parse({ strategy: "EPHEMERAL" }),
      });
      const waiting = await h.service.detail(h.current, created.id);
      expect(waiting).toMatchObject({
        lifecycle: "WAITING_INPUT",
        currentStage: "SPEC_ANALYSIS",
        waitingReason: "ANALYSIS_INPUT_REQUIRED",
      });
      await h.service.provideAnalysisInput(h.current, created.id, {
        expectedAttemptId: lease!.taskId,
        issueRef: null,
        pullRequestUrls: [],
        goal,
      });
      const resumed = await h.service.detail(h.current, created.id);
      expect(resumed).toMatchObject({
        kind: "SPEC_TASK",
        input: { goal, profilePolicy: { strategy: "EPHEMERAL" } },
      });
      expect(resumed.input).not.toHaveProperty("issueRef");
      expect((await h.service.create(h.current, input)).id).toBe(created.id);
    });

    it("supports PR-only deterministic analysis", async () => {
      const h = await harness("DETERMINISTIC");
      const created = await h.service.create(h.current, {
        kind: "SPEC_TASK",
        idempotencyKey: randomUUID(),
        pullRequestUrls: [prUrl],
        targetUrl,
      });
      await h.service.reconcile();
      expect(h.linear.getIssue).not.toHaveBeenCalled();
      expect((await h.service.detail(h.current, created.id)).verdict).toBe(
        "PASSED",
      );
    });
  },
);
