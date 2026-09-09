import {
  VISUAL_OBSERVATION_MAX_BYTES,
  visualObservationMetadataSchema,
} from "@devproof/runtime-protocol";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
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
    private readonly storage: ObjectStorageService,
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
    if (execution.runtimeSessionId) {
      const session = await this.prisma.browserRuntimeSession.findUnique({
        where: { id: execution.runtimeSessionId },
        select: { runtime: { select: { capabilities: true } } },
      });
      if (
        !Array.isArray(session?.runtime.capabilities) ||
        !session.runtime.capabilities.includes("dom-vision-v1")
      ) {
        throw new ConflictException({
          code: "BROWSER_RUNTIME_UPGRADE_REQUIRED",
          retryable: false,
          message:
            "This existing browser session does not support DOM + vision. Upgrade Browser Runtime and start a fresh attempt.",
        });
      }
    }
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
        requiredCapabilities: [
          ...new Set([
            ...input.execution.requiredCapabilities,
            "dom-vision-v1",
          ]),
        ],
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
    const result = await this.browser.executeForExecutionRun(
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
    // Only hydrate artifacts returned by this leased task's own command. Never
    // accept storage keys or arbitrary artifact IDs from Agent tool arguments.
    const artifact =
      result.status === "SUCCEEDED"
        ? result.artifacts.findLast(
            (item) =>
              item.kind === "SCREENSHOT" &&
              ["image/jpeg", "image/png"].includes(item.contentType) &&
              visualObservationMetadataSchema.safeParse(
                (item.metadata as Record<string, unknown> | null)
                  ?.visualObservation,
              ).success,
          )
        : undefined;
    if (!artifact) return result;
    if (artifact.byteSize > VISUAL_OBSERVATION_MAX_BYTES) {
      return {
        ...result,
        visualObservationError:
          "VIEWPORT_IMAGE_TOO_LARGE: reduce viewport or capture a JPEG screenshot.",
      };
    }
    try {
      const image = await this.storage.get(artifact.storageKey, {
        start: 0,
        end: VISUAL_OBSERVATION_MAX_BYTES,
      });
      if (
        image.body.byteLength !== artifact.byteSize ||
        image.body.byteLength > VISUAL_OBSERVATION_MAX_BYTES
      )
        throw new Error("Unexpected screenshot byte size.");
      return {
        ...result,
        visualObservation: {
          ...visualObservationMetadataSchema.parse(
            (artifact.metadata as Record<string, unknown>).visualObservation,
          ),
          artifactId: artifact.id,
          contentType: artifact.contentType,
          dataBase64: image.body.toString("base64"),
        },
      };
    } catch {
      // The browser action may already have succeeded. Do not turn a failed
      // image fetch into a transport error that could replay a save/delete.
      return {
        ...result,
        visualObservationError:
          "VIEWPORT_IMAGE_UNAVAILABLE: capture a fresh viewport screenshot before visual interaction.",
      };
    }
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
