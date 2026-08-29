import { describe, expect, it, vi } from "vitest";

import { TaskProfileResolverService } from "./task-profile-resolver.service.js";

describe("TaskProfileResolverService", () => {
  it("restarts the full task window when a human updates Profile selection", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-28T02:00:00.000Z");
    vi.setSystemTime(now);
    try {
      const tx = {
        taskDeploymentProfileBinding: { deleteMany: vi.fn() },
        taskExecution: { update: vi.fn() },
        taskExecutionEvent: { create: vi.fn() },
        taskExecutionStage: { updateMany: vi.fn() },
        taskProfileBinding: { update: vi.fn() },
      };
      const prisma = {
        $transaction: vi.fn((callback) => callback(tx)),
        taskExecution: {
          findFirst: vi.fn().mockResolvedValue({
            executionRuns: [],
            id: "task-profile-resume",
            inputSnapshot: {
              idempotencyKey: "profile-resume-key",
              issueRef: "PROD-6781",
              kind: "ISSUE_SPEC",
            },
            kind: "ISSUE_SPEC",
            lifecycle: "WAITING_INPUT",
            profileBinding: { id: "binding-1" },
            requestedByUserId: "user-1",
          }),
        },
      };
      const service = new TaskProfileResolverService(
        prisma as never,
        {} as never,
      );
      vi.spyOn(service, "resolve").mockResolvedValue({
        status: "RESOLVED",
      } as never);

      await service.select("team-1", "user-1", "task-profile-resume", {
        profilePolicy: {
          onUnavailable: "WAIT_FOR_PROFILE",
          scope: { authRole: "default", environmentKey: "default" },
          strategy: "EPHEMERAL",
        },
      });

      expect(tx.taskExecution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deadlineAt: new Date(now.getTime() + 7_200_000),
            lifecycle: "RUNNING",
          }),
          where: { id: "task-profile-resume" },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces unexpected resolution failures after processing the batch", async () => {
    const prisma = {
      taskProfileRecoveryEvent: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
      taskExecution: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "task-a" }, { id: "task-b" }]),
      },
    };
    const service = new TaskProfileResolverService(
      prisma as never,
      {} as never,
    );
    const resolve = vi
      .spyOn(service, "resolve")
      .mockRejectedValueOnce(new Error("missing relation"))
      .mockResolvedValueOnce({ status: "RESOLVED" } as never);

    await expect(service.reconcile()).rejects.toThrow(
      "Profile resolution failed for 1 task(s): task-a",
    );
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("durably refreshes Profile-waiting task deadlines in bounded batches", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-28T02:00:00.000Z");
    vi.setSystemTime(now);
    try {
      const recoveryId = "c9892583-0abe-46bb-88d6-a6d39bdb92bb";
      const taskUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const taskFindMany = vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: "d4076202-4620-4d34-accc-0a553acaf426",
            inputSnapshot: {
              idempotencyKey: "durable-profile-recovery",
              issueRef: "PROD-6781",
              kind: "ISSUE_SPEC",
            },
          },
        ])
        .mockResolvedValueOnce([]);
      const recoveryUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const prisma = {
        taskExecution: {
          findMany: taskFindMany,
          updateMany: taskUpdateMany,
        },
        taskProfileRecoveryEvent: {
          findMany: vi.fn().mockResolvedValue([{ id: recoveryId }]),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            attempts: 0,
            cursorTaskId: null,
            id: recoveryId,
            profileId: "profile-1",
            resumedAt: now,
          }),
          updateMany: recoveryUpdateMany,
        },
      };
      const service = new TaskProfileResolverService(
        prisma as never,
        {} as never,
      );

      await expect(service.reconcile()).resolves.toBe(0);

      expect(taskUpdateMany).toHaveBeenCalledWith({
        data: {
          deadlineAt: new Date(now.getTime() + 7_200_000),
          projectionNeededAt: now,
        },
        where: {
          cancelRequestedAt: null,
          id: "d4076202-4620-4d34-accc-0a553acaf426",
          lifecycle: "WAITING_INPUT",
          profileBinding: {
            failureCode: { startsWith: "PROFILE_" },
            requestedProfileId: "profile-1",
            status: "WAITING_INPUT",
          },
          waitingReason: { startsWith: "PROFILE_" },
        },
      });
      expect(recoveryUpdateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "COMPLETED" }),
          where: expect.objectContaining({
            id: recoveryId,
            status: "PROCESSING",
          }),
        }),
      );
      expect(taskFindMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ take: 100 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed Profile recovery event without rolling back Profile state", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-28T02:00:00.000Z");
    vi.setSystemTime(now);
    try {
      const recoveryId = "c9892583-0abe-46bb-88d6-a6d39bdb92bb";
      const recoveryUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const prisma = {
        taskExecution: {
          findMany: vi
            .fn()
            .mockRejectedValueOnce(new Error("task database offline"))
            .mockResolvedValueOnce([]),
        },
        taskProfileRecoveryEvent: {
          findMany: vi.fn().mockResolvedValue([{ id: recoveryId }]),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            attempts: 0,
            cursorTaskId: null,
            id: recoveryId,
            profileId: "profile-1",
            resumedAt: now,
          }),
          updateMany: recoveryUpdateMany,
        },
      };
      const service = new TaskProfileResolverService(
        prisma as never,
        {} as never,
      );

      await expect(service.reconcile()).resolves.toBe(0);

      expect(recoveryUpdateMany).toHaveBeenLastCalledWith({
        data: {
          attempts: { increment: 1 },
          lastError: "task database offline",
          leaseExpiresAt: null,
          leaseToken: null,
          nextAttemptAt: new Date(now.getTime() + 5_000),
          status: "FAILED",
        },
        where: {
          id: recoveryId,
          leaseToken: expect.any(String),
          status: "PROCESSING",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds a distinct ready Profile to every Deployment hostname", async () => {
    const tx = {
      notificationOutbox: { createMany: vi.fn() },
      taskDeploymentProfileBinding: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      taskExecution: { update: vi.fn() },
      taskExecutionEvent: { create: vi.fn() },
      taskExecutionStage: { updateMany: vi.fn() },
      taskProfileBinding: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
      taskExecution: {
        findUnique: vi.fn().mockResolvedValue({
          deployments: [
            {
              id: "deployment-a",
              targetUrl: "https://staging.example.com",
            },
            {
              id: "deployment-b",
              targetUrl: "https://production.example.com",
            },
          ],
          environmentSnapshot: {
            targetUrl: "https://staging.example.com",
          },
          id: "task-multi-deployment",
          inputSnapshot: {
            idempotencyKey: "multi-deployment-key",
            issueRef: "ENG-200",
            kind: "ISSUE_SPEC",
            profilePolicy: {
              onUnavailable: "WAIT_FOR_PROFILE",
              scope: { authRole: "default", environmentKey: "default" },
              strategy: "REQUESTER",
            },
            targetUrl: "https://staging.example.com",
          },
          kind: "ISSUE_SPEC",
          lifecycle: "RUNNING",
          notificationContext: {},
          profileBinding: {
            id: "binding-multi",
            status: "PENDING",
            triggerSource: "CONSOLE",
            version: 1,
          },
          requestedByUserId: "user-1",
          specificationSnapshots: [],
          stages: [
            { status: "SUCCEEDED", type: "SPEC_ANALYSIS" },
            { startedAt: null, type: "PROFILE_RESOLUTION" },
          ],
          teamId: "team-1",
          title: "ENG-200",
        }),
      },
      taskProfileBinding: {
        findUnique: vi.fn().mockResolvedValue({ status: "RESOLVED" }),
      },
    };
    const profiles = {
      provisionForTask: vi.fn(),
      resolveProfile: vi
        .fn()
        .mockResolvedValueOnce({ id: "profile-a" })
        .mockResolvedValueOnce({ id: "profile-b" }),
    };
    const service = new TaskProfileResolverService(
      prisma as never,
      profiles as never,
    );

    await expect(service.resolve("task-multi-deployment")).resolves.toEqual({
      status: "RESOLVED",
    });
    expect(tx.taskDeploymentProfileBinding.createMany).toHaveBeenCalledWith({
      data: [
        {
          deploymentId: "deployment-a",
          profileId: "profile-a",
          taskExecutionId: "task-multi-deployment",
          teamId: "team-1",
        },
        {
          deploymentId: "deployment-b",
          profileId: "profile-b",
          taskExecutionId: "task-multi-deployment",
          teamId: "team-1",
        },
      ],
    });
    expect(profiles.provisionForTask).not.toHaveBeenCalled();
  });

  it("rebuilds a deleted requester Profile from the task target", async () => {
    const tx = {
      notificationOutbox: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      taskExecution: { update: vi.fn() },
      taskExecutionEvent: { create: vi.fn() },
      taskExecutionStage: { updateMany: vi.fn() },
      taskDeploymentProfileBinding: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      taskProfileBinding: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
        callback(tx),
      ),
      taskExecution: {
        findUnique: vi.fn().mockResolvedValue({
          environmentSnapshot: {
            targetUrl: "https://preview.example.com/dashboard",
          },
          id: "task-auto-profile",
          inputSnapshot: {
            idempotencyKey: "task-key-auto-profile",
            issueRef: "ENG-100",
            kind: "ISSUE_SPEC",
            profilePolicy: {
              onUnavailable: "WAIT_FOR_PROFILE",
              scope: { authRole: "default", environmentKey: "default" },
              strategy: "REQUESTER",
            },
            targetUrl: "https://preview.example.com/dashboard",
          },
          kind: "ISSUE_SPEC",
          lifecycle: "WAITING_INPUT",
          notificationContext: {},
          profileBinding: {
            failureCode: "PROFILE_OWNER_DELETED",
            failureMessage: "The profile owner deleted this browser profile.",
            id: "binding-auto",
            profileOwnerUserId: null,
            requestedProfileId: null,
            status: "WAITING_INPUT",
            triggerSource: "CONSOLE",
            version: 1,
          },
          requestedByUserId: "user-1",
          specificationSnapshots: [],
          stages: [
            { status: "SUCCEEDED", type: "SPEC_ANALYSIS" },
            {
              startedAt: new Date(),
              status: "WAITING_INPUT",
              type: "PROFILE_RESOLUTION",
              waitingReason: "PROFILE_OWNER_DELETED",
            },
          ],
          teamId: "team-1",
          title: "ENG-100",
          waitingReason: "PROFILE_OWNER_DELETED",
        }),
      },
      taskProfileBinding: {
        findUnique: vi.fn().mockResolvedValue({
          failureCode: "PROFILE_LOGIN_REQUIRED",
          requestedProfileId: "profile-1",
          status: "WAITING_INPUT",
        }),
      },
    };
    const profiles = {
      ensurePendingTaskRequest: vi.fn().mockResolvedValue(true),
      provisionForTask: vi.fn().mockResolvedValue({
        id: "profile-1",
        status: "UNINITIALIZED",
      }),
      resolveProfile: vi.fn().mockResolvedValue(null),
    };
    const service = new TaskProfileResolverService(
      prisma as never,
      profiles as never,
    );

    await expect(service.resolve("task-auto-profile")).resolves.toMatchObject({
      failureCode: "PROFILE_LOGIN_REQUIRED",
      requestedProfileId: "profile-1",
    });
    expect(profiles.provisionForTask).toHaveBeenCalledWith({
      authRole: "default",
      environmentKey: "default",
      ownerUserId: "user-1",
      targetUrl: "https://preview.example.com/dashboard",
      teamId: "team-1",
      triggerSource: "CONSOLE",
    });
    expect(profiles.resolveProfile).toHaveBeenCalledWith({
      ownerUserId: "user-1",
      policy: expect.objectContaining({ strategy: "REQUESTER" }),
      targetHostname: "preview.example.com",
      teamId: "team-1",
      triggerSource: "CONSOLE",
    });
    expect(profiles.ensurePendingTaskRequest).toHaveBeenCalledWith({
      profileId: "profile-1",
      triggerSource: "CONSOLE",
    });
    expect(tx.taskProfileBinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureCode: "PROFILE_LOGIN_REQUIRED",
          profileOwnerUserId: "user-1",
          requestedProfileId: "profile-1",
        }),
      }),
    );
  });

  it("does not rewrite or renotify an unchanged Profile waiting state", async () => {
    const tx = {
      notificationOutbox: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      taskExecution: { update: vi.fn() },
      taskExecutionEvent: { create: vi.fn() },
      taskExecutionStage: { updateMany: vi.fn() },
      taskDeploymentProfileBinding: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      taskProfileBinding: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
        callback(tx),
      ),
      taskProfileBinding: {
        findUnique: vi.fn().mockResolvedValue({
          id: "binding-waiting",
          status: "WAITING_INPUT",
        }),
      },
    };
    const service = new TaskProfileResolverService(
      prisma as never,
      {} as never,
    );
    const unavailable = Reflect.get(service, "unavailable") as (
      this: TaskProfileResolverService,
      task: never,
      policy: never,
      failure: never,
      targetHostname?: string,
      pending?: never,
    ) => Promise<unknown>;

    await unavailable.call(
      service,
      {
        id: "task-waiting",
        lifecycle: "WAITING_INPUT",
        notificationContext: {},
        profileBinding: {
          failureCode: "PROFILE_LOGIN_REQUIRED",
          failureMessage:
            "The profile owner must complete browser login before execution.",
          id: "binding-waiting",
          profileOwnerUserId: "user-1",
          requestedProfileId: "profile-1",
          status: "WAITING_INPUT",
          version: 3,
        },
        stages: [
          {
            status: "WAITING_INPUT",
            type: "PROFILE_RESOLUTION",
            waitingReason: "PROFILE_LOGIN_REQUIRED",
          },
        ],
        teamId: "team-1",
        title: "ENG-126",
        waitingReason: "PROFILE_LOGIN_REQUIRED",
      } as never,
      { onUnavailable: "WAIT_FOR_PROFILE" } as never,
      {
        code: "PROFILE_LOGIN_REQUIRED",
        message:
          "The profile owner must complete browser login before execution.",
      } as never,
      "preview.example.com",
      { ownerUserId: "user-1", requestedProfileId: "profile-1" } as never,
    );

    expect(tx.taskProfileBinding.update).not.toHaveBeenCalled();
    expect(tx.taskExecution.update).not.toHaveBeenCalled();
    expect(tx.taskExecutionStage.updateMany).not.toHaveBeenCalled();
    expect(tx.notificationOutbox.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            dedupeKey:
              "task:task-waiting:waiting-input:browser_profile:3:feishu",
          }),
        ],
      }),
    );
    expect(tx.taskExecutionEvent.create).not.toHaveBeenCalled();
  });

  it("requests a deployment URL before Profile resolution without applying the Profile failure policy", async () => {
    const tx = {
      notificationOutbox: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      taskExecution: { update: vi.fn() },
      taskExecutionEvent: { create: vi.fn() },
      taskExecutionStage: { updateMany: vi.fn() },
      taskDeploymentProfileBinding: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      taskProfileBinding: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
        callback(tx),
      ),
      taskExecution: {
        findUnique: vi.fn().mockResolvedValue({
          environmentSnapshot: {},
          id: "task-needs-target",
          inputSnapshot: {
            idempotencyKey: "task-needs-target",
            issueRef: "ENG-127",
            kind: "ISSUE_SPEC",
            profilePolicy: {
              onUnavailable: "FAIL",
              scope: { authRole: "default", environmentKey: "default" },
              strategy: "REQUESTER",
            },
          },
          kind: "ISSUE_SPEC",
          lifecycle: "RUNNING",
          notificationContext: {},
          profileBinding: {
            failureCode: null,
            failureMessage: null,
            id: "binding-needs-target",
            profileOwnerUserId: null,
            requestedProfileId: null,
            status: "PENDING",
            triggerSource: "CONSOLE",
            version: 1,
          },
          requestedByUserId: "user-1",
          specificationSnapshots: [],
          stages: [
            { status: "SUCCEEDED", type: "SPEC_ANALYSIS" },
            { startedAt: null, status: "PENDING", type: "PROFILE_RESOLUTION" },
          ],
          teamId: "team-1",
          title: "ENG-127",
          waitingReason: null,
        }),
      },
      taskProfileBinding: {
        findUnique: vi.fn().mockResolvedValue({
          failureCode: "DEPLOYMENT_TARGET_REQUIRED",
          status: "WAITING_INPUT",
        }),
      },
    };
    const profiles = { resolveProfile: vi.fn() };
    const service = new TaskProfileResolverService(
      prisma as never,
      profiles as never,
    );

    await expect(service.resolve("task-needs-target")).resolves.toMatchObject({
      failureCode: "DEPLOYMENT_TARGET_REQUIRED",
      status: "WAITING_INPUT",
    });
    expect(profiles.resolveProfile).not.toHaveBeenCalled();
    expect(tx.taskExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lifecycle: "WAITING_INPUT",
          waitingReason: "DEPLOYMENT_TARGET_REQUIRED",
        }),
      }),
    );
    expect(tx.notificationOutbox.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            dedupeKey:
              "task:task-needs-target:waiting-input:deployment_target:2:feishu",
            payload: expect.objectContaining({ input: "DEPLOYMENT_TARGET" }),
          }),
        ],
      }),
    );
  });

  it("resolves the default ephemeral strategy without touching a user profile", async () => {
    const transaction = vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback({
        taskExecution: { update: vi.fn() },
        taskExecutionEvent: { create: vi.fn() },
        taskExecutionStage: { updateMany: vi.fn() },
        taskDeploymentProfileBinding: {
          createMany: vi.fn(),
          deleteMany: vi.fn(),
        },
        taskProfileBinding: { update: vi.fn() },
      }),
    );
    const profileBinding = { id: "binding-1", status: "RESOLVED" };
    const prisma = {
      $transaction: transaction,
      taskExecution: {
        findUnique: vi.fn().mockResolvedValue({
          environmentSnapshot: {
            targetUrl: "https://preview.example.com/login",
          },
          id: "task-1",
          inputSnapshot: {
            idempotencyKey: "task-key-1",
            issueRef: "ENG-123",
            kind: "ISSUE_SPEC",
            profilePolicy: {
              onUnavailable: "WAIT_FOR_PROFILE",
              scope: { authRole: "default", environmentKey: "default" },
              strategy: "EPHEMERAL",
            },
            targetUrl: "https://preview.example.com/login",
          },
          kind: "ISSUE_SPEC",
          lifecycle: "RUNNING",
          profileBinding: { id: "binding-1", triggerSource: "CONSOLE" },
          specificationSnapshots: [],
          stages: [
            { status: "SUCCEEDED", type: "SPEC_ANALYSIS" },
            { startedAt: null, type: "PROFILE_RESOLUTION" },
          ],
          teamId: "team-1",
        }),
      },
      taskProfileBinding: {
        findUnique: vi.fn().mockResolvedValue(profileBinding),
      },
    };
    const profiles = { resolveProfile: vi.fn() };
    const service = new TaskProfileResolverService(
      prisma as never,
      profiles as never,
    );

    await expect(service.resolve("task-1")).resolves.toEqual(profileBinding);
    expect(profiles.resolveProfile).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("does not map a Linear agent assignee to a human browser profile", async () => {
    const updates: unknown[] = [];
    const tx = {
      notificationOutbox: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      taskExecution: { update: vi.fn((value) => updates.push(value)) },
      taskExecutionEvent: { create: vi.fn() },
      taskExecutionStage: { updateMany: vi.fn() },
      taskDeploymentProfileBinding: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      taskProfileBinding: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
        callback(tx),
      ),
      taskExecution: {
        findUnique: vi.fn().mockResolvedValue({
          environmentSnapshot: { targetUrl: "https://preview.example.com" },
          id: "task-2",
          inputSnapshot: {
            idempotencyKey: "task-key-2",
            issueRef: "ENG-124",
            kind: "ISSUE_SPEC",
            profilePolicy: {
              onUnavailable: "WAIT_FOR_PROFILE",
              scope: { authRole: "default", environmentKey: "default" },
              strategy: "ISSUE_ASSIGNEE",
            },
            targetUrl: "https://preview.example.com",
          },
          kind: "ISSUE_SPEC",
          lifecycle: "RUNNING",
          notificationContext: {},
          profileBinding: {
            failureCode: null,
            failureMessage: null,
            id: "binding-2",
            profileOwnerUserId: null,
            requestedProfileId: null,
            status: "PENDING",
            triggerSource: "ISSUE_ASSIGNEE",
            version: 1,
          },
          specificationSnapshots: [
            {
              context: {
                issue: {
                  assignee: {
                    email: null,
                    externalId: "linear-agent-1",
                    issuerKey: "workspace-1",
                    name: "DevProof Agent",
                    type: "AGENT",
                  },
                  description: "Verify flow",
                  id: "issue-uuid",
                  identifier: "ENG-124",
                  labels: [],
                  priority: null,
                  state: "Todo",
                  title: "Verify flow",
                  url: "https://linear.app/acme/issue/ENG-124/verify-flow",
                },
                knowledge: [],
                pullRequests: [],
                resolution: { completeness: "COMPLETE", diagnostics: [] },
              },
            },
          ],
          stages: [
            { status: "SUCCEEDED", type: "SPEC_ANALYSIS" },
            { startedAt: null, type: "PROFILE_RESOLUTION" },
          ],
          teamId: "team-1",
          title: "ENG-124",
          waitingReason: null,
        }),
      },
      taskProfileBinding: {
        findUnique: vi.fn().mockResolvedValue({
          failureCode: "PROFILE_ISSUE_ASSIGNEE_IS_AGENT",
          status: "WAITING_INPUT",
        }),
      },
    };
    const profiles = { resolveProfile: vi.fn() };
    const service = new TaskProfileResolverService(
      prisma as never,
      profiles as never,
    );

    await expect(service.resolve("task-2")).resolves.toMatchObject({
      failureCode: "PROFILE_ISSUE_ASSIGNEE_IS_AGENT",
      status: "WAITING_INPUT",
    });
    expect(profiles.resolveProfile).not.toHaveBeenCalled();
    expect(tx.taskProfileBinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureCode: "PROFILE_ISSUE_ASSIGNEE_IS_AGENT",
          status: "WAITING_INPUT",
        }),
      }),
    );
  });

  it("allows a signed-in user to claim an orphaned rerun requester", async () => {
    const tx = {
      taskExecution: { update: vi.fn() },
      taskExecutionEvent: { create: vi.fn() },
      taskExecutionStage: { updateMany: vi.fn() },
      taskDeploymentProfileBinding: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      taskProfileBinding: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
        callback(tx),
      ),
      taskExecution: {
        findFirst: vi.fn().mockResolvedValue({
          executionRuns: [],
          id: "task-orphaned-rerun",
          inputSnapshot: {
            idempotencyKey: "rerun-task-orphaned",
            issueRef: "ENG-125",
            kind: "ISSUE_SPEC",
            profilePolicy: {
              onUnavailable: "WAIT_FOR_PROFILE",
              scope: { authRole: "default", environmentKey: "default" },
              strategy: "REQUESTER",
            },
          },
          kind: "ISSUE_SPEC",
          lifecycle: "WAITING_INPUT",
          profileBinding: { id: "binding-orphaned" },
          requestedByUserId: null,
        }),
      },
    };
    const service = new TaskProfileResolverService(
      prisma as never,
      {} as never,
    );
    vi.spyOn(service, "resolve").mockResolvedValue({
      status: "WAITING_INPUT",
    } as never);

    await service.select("team-1", "user-1", "task-orphaned-rerun", {
      profilePolicy: {
        onUnavailable: "WAIT_FOR_PROFILE",
        scope: { authRole: "default", environmentKey: "default" },
        strategy: "REQUESTER",
      },
    });

    expect(tx.taskExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestedByKind: "USER",
          requestedByUserId: "user-1",
        }),
      }),
    );
    expect(tx.taskExecutionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({ requesterClaimed: true }),
        }),
      }),
    );
  });

  it("releases every obsolete pending Profile when a task switches to ephemeral", async () => {
    const tx = {
      taskExecution: { update: vi.fn() },
      taskExecutionEvent: { create: vi.fn() },
      taskExecutionStage: { updateMany: vi.fn() },
      taskDeploymentProfileBinding: { deleteMany: vi.fn() },
      taskProfileBinding: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
      taskExecution: {
        findFirst: vi.fn().mockResolvedValue({
          executionRuns: [],
          id: "task-public-page",
          inputSnapshot: {
            idempotencyKey: "task-public-page",
            issueRef: "ENG-130",
            kind: "ISSUE_SPEC",
            profilePolicy: {
              onUnavailable: "WAIT_FOR_PROFILE",
              scope: { authRole: "default", environmentKey: "default" },
              strategy: "REQUESTER",
            },
          },
          kind: "ISSUE_SPEC",
          lifecycle: "WAITING_INPUT",
          profileBinding: {
            externalIdentitySnapshot: {
              pendingProfiles: [
                { profileId: "profile-a" },
                { profileId: "profile-b" },
              ],
            },
            id: "binding-public-page",
            requestedProfileId: "profile-a",
            triggerSource: "FEISHU",
          },
          requestedByUserId: "user-1",
        }),
      },
    };
    const profiles = { releasePendingTaskRequest: vi.fn() };
    const service = new TaskProfileResolverService(
      prisma as never,
      profiles as never,
    );
    vi.spyOn(service, "resolve").mockResolvedValue({
      status: "RESOLVED",
    } as never);

    await service.select("team-1", "user-1", "task-public-page", {
      profilePolicy: {
        onUnavailable: "WAIT_FOR_PROFILE",
        scope: { authRole: "default", environmentKey: "default" },
        strategy: "EPHEMERAL",
      },
    });

    expect(profiles.releasePendingTaskRequest).toHaveBeenCalledTimes(2);
    expect(profiles.releasePendingTaskRequest).toHaveBeenNthCalledWith(
      1,
      {
        profileId: "profile-a",
        triggerSource: "FEISHU",
      },
      tx,
    );
    expect(profiles.releasePendingTaskRequest).toHaveBeenNthCalledWith(
      2,
      {
        profileId: "profile-b",
        triggerSource: "FEISHU",
      },
      tx,
    );
  });
});

describe("TaskProfileResolverService terminal request cleanup", () => {
  it("releases every pending Profile reference in the caller transaction", async () => {
    const tx = {
      taskProfileBinding: {
        findUnique: vi.fn().mockResolvedValue({
          externalIdentitySnapshot: {
            pendingProfiles: [
              { profileId: "profile-a" },
              { profileId: "profile-b" },
            ],
          },
          requestedProfileId: "profile-a",
          triggerSource: "ISSUE_ASSIGNEE",
        }),
      },
    };
    const releasePendingTaskRequest = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const service = new TaskProfileResolverService(
      {} as never,
      {
        releasePendingTaskRequest,
      } as never,
    );

    await expect(
      service.releasePendingRequests("task-1", tx as never),
    ).resolves.toBe(1);

    expect(tx.taskProfileBinding.findUnique).toHaveBeenCalledWith({
      select: {
        externalIdentitySnapshot: true,
        requestedProfileId: true,
        triggerSource: true,
      },
      where: { taskExecutionId: "task-1" },
    });
    expect(releasePendingTaskRequest).toHaveBeenNthCalledWith(
      1,
      { profileId: "profile-a", triggerSource: "ISSUE_ASSIGNEE" },
      tx,
    );
    expect(releasePendingTaskRequest).toHaveBeenNthCalledWith(
      2,
      { profileId: "profile-b", triggerSource: "ISSUE_ASSIGNEE" },
      tx,
    );
  });
});
