import { ConflictException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  runtimeTaskSnapshotSchema,
  type RuntimeBrowserAcquireInput,
  type RuntimeBrowserAcquireOutput,
  type RuntimeBrowserCommandInput,
  type RuntimeBrowserReleaseInput,
} from "@devproof/agent-runtime-protocol";
import { verificationRequestSchema } from "@devproof/contracts";

import { PrismaService } from "../database/prisma.service.js";
import { BrowserExecutionRunner } from "../verification/browser-execution-runner.service.js";
import { ExecutionRunnerUnavailableError } from "../verification/runtime-adapters.js";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

type LeaseInput = RuntimeBrowserReleaseInput;

@Injectable()
export class UnifiedBrowserExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly browser: BrowserExecutionRunner,
  ) {}

  async acquire(
    teamId: string,
    taskId: string,
    input: RuntimeBrowserAcquireInput,
  ): Promise<RuntimeBrowserAcquireOutput> {
    const task = await this.requireLeasedTask(teamId, taskId, input);
    const snapshot = runtimeTaskSnapshotSchema.parse(task.snapshot);
    const execution = await this.prisma.browserExecution.upsert({
      create: {
        attemptId: task.attemptId,
        input: json(input.execution),
        runId: task.runId,
      },
      update: { input: json(input.execution) },
      where: { attemptId: task.attemptId },
    });
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [
        {
          description:
            "Run v2 delegates its acceptance criteria to the Browser Verification Executor.",
          id: "run-v2-browser-execution",
          required: true,
        },
      ],
      agentRuntime: { metadata: {}, provider: "GENERIC" },
      evidencePolicy: { requiredKinds: [], retentionDays: 90 },
      execution: {
        acquireTimeoutSeconds: 300,
        availabilityPolicy: input.execution.availabilityPolicy,
        profile: input.execution.profile,
        requiredCapabilities: input.execution.requiredCapabilities,
        runTimeoutSeconds: Math.max(
          120,
          Math.floor((Date.parse(snapshot.deadlineAt) - Date.now()) / 1_000),
        ),
        ...(input.execution.targetUrl
          ? { targetUrl: input.execution.targetUrl }
          : {}),
      },
      goal: snapshot.goal.slice(0, 8_000),
      hitlPolicy: {
        enabled: true,
        notificationChannels: ["FEISHU"],
        onTimeout: "INCONCLUSIVE",
        timeoutSeconds: 3_600,
      },
      idempotencyKey: `execution-${execution.id}`,
      inputs: {},
      mode: "TEST",
      schemaVersion: 1,
      secretRefs: {},
    });
    try {
      const lease = await this.browser.acquireForExecutionRun(
        teamId,
        execution.id,
        request,
      );
      return {
        browserExecutionId: execution.id,
        expiresAt: lease.expiresAt.toISOString(),
        fencingToken: lease.fencingToken,
        leaseId: lease.leaseId,
        runnerId: lease.runnerId,
        runnerKind: "BROWSER",
        status: "ACQUIRED",
      };
    } catch (error) {
      if (!(error instanceof ExecutionRunnerUnavailableError)) throw error;

      const availabilityPolicy =
        error.availabilityPolicyOverride ?? input.execution.availabilityPolicy;
      if (availabilityPolicy === "FAIL_FAST") {
        throw new ConflictException({
          code: error.reason,
          message: error.message,
          retryable: false,
        });
      }

      return {
        browserExecutionId: execution.id,
        reason: error.reason,
        retryAfterMs: 2_000,
        status: "WAITING_CAPACITY",
      };
    }
  }

  async execute(
    teamId: string,
    taskId: string,
    input: RuntimeBrowserCommandInput,
  ) {
    const task = await this.requireLeasedTask(teamId, taskId, input);
    const execution = await this.prisma.browserExecution.findUnique({
      where: { attemptId: task.attemptId },
    });
    if (!execution) {
      throw new ConflictException(
        "Acquire browser execution before sending commands.",
      );
    }
    return this.browser.executeForExecutionRun(
      teamId,
      execution.id,
      input.command,
      undefined,
      {
        taskId,
        fencingToken: input.fencingToken,
        leaseToken: input.leaseToken,
        workerId: input.workerId,
        expiresAt: task.leaseExpiresAt!,
      },
    );
  }

  async release(teamId: string, taskId: string, input: LeaseInput) {
    const task = await this.requireLeasedTask(teamId, taskId, input, true);
    const execution = await this.prisma.browserExecution.findUnique({
      where: { attemptId: task.attemptId },
    });
    if (execution) {
      await this.browser.releaseForExecutionRun(teamId, execution.id, {
        taskId,
        fencingToken: input.fencingToken,
        leaseToken: input.leaseToken,
        workerId: input.workerId,
        expiresAt: task.leaseExpiresAt!,
      });
    }
    return { released: true };
  }

  private async requireLeasedTask(
    teamId: string,
    taskId: string,
    input: LeaseInput,
    allowTerminal = false,
  ) {
    const task = await this.prisma.agentRuntimeTask.findFirst({
      include: { run: true },
      where: { id: taskId, run: { teamId } },
    });
    if (
      !task ||
      task.leaseOwner !== input.workerId ||
      task.leaseToken !== input.leaseToken ||
      task.fencingToken.toString() !== input.fencingToken ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt <= new Date()
    ) {
      throw new ConflictException({
        code: "RUNTIME_LEASE_LOST",
        message: "The Runtime task lease is stale.",
      });
    }
    if (
      !allowTerminal &&
      (task.status !== "RUNNING" || task.run.lifecycle !== "RUNNING")
    ) {
      throw new ConflictException("The Runtime task is not active.");
    }
    if (
      !allowTerminal &&
      (!task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= Date.now())
    ) {
      throw new ConflictException("The Runtime task lease expired.");
    }
    return task;
  }
}
