import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { taskExecutionCreateInputSchema } from "@devproof/contracts";
import {
  prepareTestAccountPlans,
  provideTaskTestAccounts,
  readAccountPlan,
  taskAccountPreparation,
  accountsReady,
  expireTestAccountPlans,
} from "./task-test-accounts.js";
const connectionString = process.env.DEVPROOF_CONCURRENCY_TEST_DATABASE_URL;
if (
  !connectionString ||
  !/^postgresql:\/\/devproof_test:[^@]+@127\.0\.0\.1:\d+\/devproof_concurrency_test_[a-f\d]{8}$/u.test(
    connectionString,
  )
)
  throw new Error("Use the disposable PostgreSQL concurrency test launcher.");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "teams", "users" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => {
  await db.$disconnect();
});

async function fixture(
  teamId?: string,
  usage = "CREATE_OR_MODIFY",
  url = "https://test.example.com",
) {
  const team = teamId
    ? { id: teamId }
    : await db.team.create({
        data: {
          name: "Account preparation",
          slug: randomUUID(),
          feishuTenantKey: randomUUID(),
        },
      });
  const input = taskExecutionCreateInputSchema.parse({
    kind: "ISSUE_SPEC",
    issueRef: "PFRD-3551",
    targetUrl: url,
    idempotencyKey: randomUUID(),
  });
  const task = await db.taskExecution.create({
    data: {
      teamId: team.id,
      kind: "ISSUE_SPEC",
      sourceKind: "LINEAR_ISSUE",
      idempotencyKey: randomUUID(),
      title: "Account preparation",
      lifecycle: "RUNNING",
      inputSnapshot: input as Prisma.InputJsonValue,
      traceId: "a".repeat(32),
      deadlineAt: new Date(Date.now() + 60_000),
    },
  });
  const stage = await db.taskExecutionStage.create({
    data: {
      taskExecutionId: task.id,
      type: "SPEC_ANALYSIS",
      status: "SUCCEEDED",
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
  const snapshot = await db.taskSpecificationSnapshot.create({
    data: {
      taskExecutionId: task.id,
      stageAttemptId: attempt.id,
      sourceHash: "b".repeat(64),
      context: {},
      completeness: "COMPLETE",
      generatorKind: "AGENT",
      generatorVersion: "test",
      summary: "账号准备",
    },
  });
  const deployment = await db.taskDeployment.create({
    data: {
      taskExecutionId: task.id,
      key: "test",
      name: "Test",
      targetUrl: url,
    },
  });
  const definitions = [
    { name: "只读查看", accountRequirements: [] },
    {
      name: "两个独立场景",
      accountRequirements: [
        {
          role: "subject",
          label: "业务测试对象",
          count: 2,
          usage,
          rationale: "两个独立的数据场景",
        },
      ],
    },
  ];
  for (const [position, definition] of definitions.entries()) {
    const testCase = await db.taskGeneratedTestCase.create({
      data: {
        snapshotId: snapshot.id,
        position,
        name: definition.name,
        definition,
        definitionHash: "c".repeat(64),
      },
    });
    await db.taskCaseExecution.create({
      data: {
        taskExecutionId: task.id,
        caseId: testCase.id,
        deploymentId: deployment.id,
      },
    });
  }
  await prepareTestAccountPlans(db as never, task.id);
  async function current() {
    const rows = await db.taskCaseExecution.findMany({
      where: { taskExecutionId: task.id },
      include: { testCase: true, deployment: true },
    });
    return { rows, preparation: taskAccountPreparation(rows, snapshot.id) };
  }
  async function submission(accounts = ["subject-a", "subject-b"]) {
    const { preparation } = await current();
    const writable = preparation.cases.find((c) => c.slots.length)!;
    return {
      submissionId: randomUUID(),
      expectedRevision: preparation.revision,
      assignments: accounts.map((account, i) => ({
        caseExecutionId: writable.caseExecutionId,
        slotId: writable.slots[i]!.slotId,
        account,
      })),
    };
  }
  return { task, team, snapshot, current, submission };
}

describe("task account preparation", () => {
  it("accepts a reused account on a new task without changing historical recovery state", async () => {
    const original = await historicalUnusedAccount();
    const rerun = await fixture(original.team.id);
    await db.taskExecutionEvent.create({
      data: {
        taskExecutionId: rerun.task.id,
        teamId: original.team.id,
        actor: "CONTROL_PLANE",
        kind: "task.rerun.linked",
        payload: { sourceTaskId: original.task.id },
      },
    });
    const input = await rerun.submission();
    await provideTaskTestAccounts(
      db as never,
      rerun.team.id,
      rerun.task.id,
      input,
    );
    expect((await rerun.current()).preparation.missingCount).toBe(0);
    const audit = await db.runEvent.findMany({
      where: { runId: original.run.id, kind: "execution.account.reused" },
    });
    expect(audit).toHaveLength(0);
    const historical = await db.executionRun.findUniqueOrThrow({
      where: { id: original.run.id },
    });
    expect(historical.executionPolicy).toEqual(original.run.executionPolicy);
    await provideTaskTestAccounts(
      db as never,
      rerun.team.id,
      rerun.task.id,
      input,
    );
    expect(
      await db.runEvent.count({
        where: { runId: original.run.id, kind: "execution.account.reused" },
      }),
    ).toBe(0);
  });
  it("accepts an account despite a historical timed-out browser write", async () => {
    const original = await historicalUnusedAccount();
    await db.browserRuntimeCommand.create({
      data: {
        sessionId: original.session.id,
        commandType: "page.click",
        source: "AGENT",
        status: "TIMED_OUT",
        payload: {},
        leaseToken: original.session.leaseToken,
        fencingToken: 1n,
        deadlineAt: new Date("2026-09-15T02:10:00Z"),
        createdAt: new Date("2026-09-15T02:08:00Z"),
      },
    });
    const rerun = await fixture(original.team.id);
    await provideTaskTestAccounts(
      db as never,
      rerun.team.id,
      rerun.task.id,
      await rerun.submission(),
    );
    expect((await rerun.current()).preparation.missingCount).toBe(0);
    expect(
      await db.runEvent.count({
        where: { runId: original.run.id, kind: "execution.account.reused" },
      }),
    ).toBe(0);
  });
  it("does not create Runs while collecting two roles and admits zero-account cases", async () => {
    const f = await fixture();
    const { rows, preparation } = await f.current();
    expect(preparation.missingCount).toBe(2);
    expect(await db.executionRun.count()).toBe(0);
    expect(
      rows
        .map((row) =>
          accountsReady(row.testAccountPlan, row.testCase.definition),
        )
        .sort(),
    ).toEqual([false, true]);
  });
  it("persists both roles, refreshes the parent budget once and accepts retries idempotently", async () => {
    const f = await fixture();
    const input = await f.submission();
    await provideTaskTestAccounts(db as never, f.team.id, f.task.id, input);
    const resolved = await db.taskExecution.findUniqueOrThrow({
      where: { id: f.task.id },
    });
    expect(resolved.deadlineAt.getTime()).toBeGreaterThan(
      f.task.deadlineAt.getTime(),
    );
    expect((await f.current()).preparation.missingCount).toBe(0);
    await provideTaskTestAccounts(db as never, f.team.id, f.task.id, input);
    expect(
      (await db.taskExecution.findUniqueOrThrow({ where: { id: f.task.id } }))
        .deadlineAt,
    ).toEqual(resolved.deadlineAt);
    expect(
      await db.taskExecutionEvent.count({
        where: { kind: "task.accounts.assigned" },
      }),
    ).toBe(1);
  });
  it("expires only missing account preparation and rejects late replies", async () => {
    const f = await fixture();
    const input = await f.submission();
    const { rows } = await f.current();
    for (const row of rows) {
      const plan = readAccountPlan(row.testAccountPlan)!;
      plan.expiresAt = new Date(Date.now() - 1000).toISOString();
      await db.taskCaseExecution.update({
        where: { id: row.id },
        data: { testAccountPlan: plan },
      });
    }
    await expect(
      provideTaskTestAccounts(db as never, f.team.id, f.task.id, input),
    ).rejects.toThrow("过期");
    await expireTestAccountPlans(db as never, f.task.id);
    const current = await f.current();
    expect(
      current.rows.filter((r) => r.dispatchStatus === "FAILED"),
    ).toHaveLength(1);
    expect(
      current.rows.filter((r) => r.dispatchStatus === "PENDING"),
    ).toHaveLength(1);
    expect(current.preparation.missingCount).toBe(0);
  });
  it("accepts simultaneous assignments of the same accounts across tasks", async () => {
    const a = await fixture(),
      b = await fixture(a.team.id);
    const results = await Promise.allSettled(
      [a, b].map(async (f) =>
        provideTaskTestAccounts(
          db as never,
          f.team.id,
          f.task.id,
          await f.submission(),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(
      (await a.current()).preparation.missingCount +
        (await b.current()).preparation.missingCount,
    ).toBe(0);
  });
  it("allows the user to assign the same account to multiple roles", async () => {
    const f = await fixture();
    const input = await f.submission();
    input.assignments = input.assignments.map((assignment) => ({
      ...assignment,
      account: "shared-subject",
    }));
    await provideTaskTestAccounts(db as never, f.team.id, f.task.id, input);
    expect((await f.current()).preparation.missingCount).toBe(0);
    const assigned = (await f.current()).preparation.cases.flatMap(
      (c) => c.slots,
    );
    expect(assigned.map((s) => s.account)).toEqual([
      "shared-subject",
      "shared-subject",
    ]);
  });
  it("retains supplied roles when only the missing role is submitted later", async () => {
    const f = await fixture();
    const input = await f.submission();
    await provideTaskTestAccounts(db as never, f.team.id, f.task.id, {
      ...input,
      assignments: input.assignments.slice(0, 1),
    });
    expect((await f.current()).preparation.missingCount).toBe(1);
    await provideTaskTestAccounts(db as never, f.team.id, f.task.id, {
      ...input,
      submissionId: randomUUID(),
      assignments: input.assignments.slice(1),
    });
    const row = (await f.current()).rows.find(
      (r) => readAccountPlan(r.testAccountPlan)!.bindings.length,
    )!;
    expect(
      readAccountPlan(row.testAccountPlan)!.bindings.map((b) => b.account),
    ).toEqual(["subject-a", "subject-b"]);
  });
  it.each([false, true])(
    "reuses prior role assignments even with pending historical cleanup (%s)",
    async (started) => {
      const f = await fixture();
      const input = await f.submission();
      await provideTaskTestAccounts(db as never, f.team.id, f.task.id, input);
      const row = (await f.current()).rows.find(
        (r) => r.id === input.assignments[0]!.caseExecutionId,
      )!;
      await db.taskCaseExecution.update({
        where: { id: row.id },
        data: { dispatchStatus: "CANCELLED" },
      });
      if (started) {
        const deadline = new Date(Date.now() + 600_000);
        const previousRun = await db.executionRun.create({
          data: {
            teamId: f.team.id,
            taskExecutionId: f.task.id,
            idempotencyKey: randomUUID(),
            goal: "旧执行有未清理记录",
            lifecycle: "COMPLETED",
            criteriaSnapshot: [],
            environmentSnapshot: {},
            executionPolicy: {
              testAccounts: readAccountPlan(row.testAccountPlan)!.bindings,
              executionState: {
                records: [
                  {
                    id: "124",
                    account: "subject-a",
                    ownership: "CREATED_THIS_RUN",
                    evidenceRefs: ["proof"],
                    cleanup: { instruction: "删除本次记录", status: "PENDING" },
                  },
                ],
              },
            },
            traceId: randomUUID().replaceAll("-", ""),
            deadlineAt: deadline,
            initialDeadlineAt: deadline,
            hardDeadlineAt: deadline,
          },
        });
        await db.taskCaseExecution.update({
          where: { id: row.id },
          data: { runId: previousRun.id },
        });
      }
      const retry = await db.taskCaseExecution.create({
        data: {
          taskExecutionId: f.task.id,
          caseId: row.caseId,
          deploymentId: row.deploymentId,
          executionOrdinal: 2,
        },
      });
      await prepareTestAccountPlans(db as never, f.task.id);
      const current = await f.current();
      const plan = readAccountPlan(
        current.rows.find((r) => r.id === retry.id)!.testAccountPlan,
      )!;
      expect(plan.bindings.map((b) => b.account)).toEqual([
        "subject-a",
        "subject-b",
      ]);
      expect(current.preparation.missingCount).toBe(0);
    },
  );
  it("rejects stale plans and duplicate roles without a partial allocation", async () => {
    const f = await fixture();
    const input = await f.submission();
    await expect(
      provideTaskTestAccounts(db as never, f.team.id, f.task.id, {
        ...input,
        expectedRevision: "outdated",
      }),
    ).rejects.toThrow("刷新");
    await expect(
      provideTaskTestAccounts(db as never, f.team.id, f.task.id, {
        ...input,
        assignments: [input.assignments[0]!, input.assignments[0]!],
      }),
    ).rejects.toThrow("重复");
    expect((await f.current()).preparation.missingCount).toBe(2);
  });
  it("accepts supplied accounts for readers and writers in the same environment", async () => {
    const a = await fixture(undefined, "READ_EXISTING"),
      b = await fixture(a.team.id, "READ_EXISTING"),
      c = await fixture(
        a.team.id,
        "CREATE_OR_MODIFY",
        "https://other.example.com",
      );
    for (const f of [a, b, c])
      await provideTaskTestAccounts(
        db as never,
        f.team.id,
        f.task.id,
        await f.submission(),
      );
    const writer = await fixture(a.team.id);
    await provideTaskTestAccounts(
      db as never,
      writer.team.id,
      writer.task.id,
      await writer.submission(),
    );
    expect((await writer.current()).preparation.missingCount).toBe(0);
  });
});

async function historicalUnusedAccount() {
  const f = await fixture();
  await db.taskExecution.update({
    where: { id: f.task.id },
    data: { lifecycle: "COMPLETED" },
  });
  const deadline = new Date("2026-09-15T02:21:24Z");
  const run = await db.executionRun.create({
    data: {
      teamId: f.team.id,
      taskExecutionId: f.task.id,
      idempotencyKey: randomUUID(),
      goal: "使用账号 A 核对白名单",
      lifecycle: "TIMED_OUT",
      criteriaSnapshot: [],
      environmentSnapshot: { targetUrl: "https://test.example.com" },
      executionPolicy: {
        testAccountClaim: { account: "subject-a", aliases: [] },
        executionState: { account: "A" },
      },
      traceId: "d".repeat(32),
      initialDeadlineAt: deadline,
      deadlineAt: deadline,
      hardDeadlineAt: deadline,
      attempts: {
        create: { number: 1, status: "TIMED_OUT", inputSnapshot: {} },
      },
    },
    include: { attempts: true },
  });
  const attemptId = run.attempts[0]!.id;
  const agentTask = await db.agentRuntimeTask.create({
    data: {
      runId: run.id,
      attemptId,
      capability: "BROWSER_VERIFICATION",
      status: "TIMED_OUT",
      snapshot: {},
      deadlineAt: deadline,
    },
  });
  const runtime = await db.browserRuntime.create({
    data: {
      teamId: f.team.id,
      instanceKey: randomUUID(),
      name: "Closed old runtime",
      tokenHash: randomUUID(),
      tokenHint: "test",
    },
  });
  const launchId = randomUUID();
  const session = await db.browserRuntimeSession.create({
    data: {
      teamId: f.team.id,
      runtimeId: runtime.id,
      status: "CLOSED",
      profileMode: "EPHEMERAL",
      profileKey: randomUUID(),
      purpose: "EXECUTION",
      slotNumber: 0,
      protocolMajor: 1,
      protocolMinor: 17,
      leaseToken: randomUUID(),
      leaseExpiresAt: deadline,
      fencingToken: 1n,
      ownerTaskId: agentTask.id,
      ownerFencingToken: 1n,
      launchIdentityVersion: 1,
      launchIdentity: { version: 1, id: launchId },
      launchHostInstanceId: "fixture-host",
      launchConnectionGeneration: 1n,
      closureVerifiedAt: new Date("2026-09-15T03:51:46Z"),
      closureEvidenceId: randomUUID(),
    },
  });
  await db.browserExecution.create({
    data: {
      runId: run.id,
      attemptId,
      runtimeSessionId: session.id,
      status: "RELEASED",
      input: {},
    },
  });
  for (const commandType of ["session.open", "page.navigate"]) {
    await db.browserRuntimeCommand.create({
      data: {
        sessionId: session.id,
        commandType,
        source: commandType === "session.open" ? "SYSTEM" : "AGENT",
        status: "SUCCEEDED",
        payload:
          commandType === "session.open"
            ? { launchIdentityId: launchId }
            : { url: "https://test.example.com" },
        result: {
          url:
            commandType === "session.open"
              ? "about:blank"
              : "https://test.example.com",
        },
        leaseToken: session.leaseToken,
        fencingToken: 1n,
        deadlineAt: deadline,
        createdAt: new Date("2026-09-15T01:49:00Z"),
        completedAt: new Date("2026-09-15T01:50:00Z"),
      },
    });
  }
  const intervention = await db.humanIntervention.create({
    data: {
      teamId: f.team.id,
      runId: run.id,
      attemptId,
      taskId: agentTask.id,
      kind: "TEST_ACCOUNT",
      status: "RESOLVED",
      prompt: "提供测试账号",
      response: { account: "subject-a" },
      requestedAt: new Date("2026-09-15T01:50:57Z"),
      resolvedAt: new Date("2026-09-15T02:07:21Z"),
    },
  });
  return { ...f, run, session, intervention };
}
