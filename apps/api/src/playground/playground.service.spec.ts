import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/auth.types.js";
import { resetEnvForTests } from "../config/env.js";
import { PlaygroundService } from "./playground.service.js";

const current: AuthContext = {
  sessionId: "session-1",
  team: { id: "team-1", name: "DevProof", slug: "devproof" },
  user: {
    avatarUrl: null,
    email: "tester@devproof.local",
    id: "user-1",
    name: "Tester",
  },
};

beforeEach(() => {
  vi.stubEnv(
    "CREDENTIAL_ENCRYPTION_KEY",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  );
  vi.stubEnv("FEISHU_ALLOWED_TENANT_KEY", "ci-test-tenant");
  vi.stubEnv("FEISHU_APP_ID", "ci-test-app");
  vi.stubEnv("FEISHU_APP_SECRET", "ci-test-secret");
  vi.stubEnv(
    "FEISHU_REDIRECT_URI",
    "http://localhost:3344/auth/feishu/callback",
  );
  vi.stubEnv("NODE_ENV", "test");
  resetEnvForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

function createService(options?: {
  browserRuntimes?: unknown[];
  resolverReadiness?: Record<string, unknown>;
  task?: Record<string, unknown>;
}) {
  const runtimes = {
    list: vi.fn().mockResolvedValue(options?.browserRuntimes ?? []),
  };
  const tasks = {
    create: vi.fn().mockResolvedValue(options?.task ?? { id: "task-1" }),
  };
  const resolver = {
    readiness: vi.fn().mockReturnValue(
      options?.resolverReadiness ?? {
        github: { configured: false },
        knowledge: { configured: false },
        linear: { configured: true },
        ready: true,
      },
    ),
  };
  return {
    resolver,
    service: new PlaygroundService(
      runtimes as never,
      tasks as never,
      resolver as never,
    ),
    tasks,
  };
}

describe("PlaygroundService", () => {
  it("combines the Spec pipeline, Agent Runtime lease endpoint and Browser Runner readiness", async () => {
    const { service } = createService({
      browserRuntimes: [
        { id: "runner-1", name: "Browser local", status: "ONLINE" },
      ],
    });

    const readiness = await service.readiness(current);

    expect(readiness).toMatchObject({
      canExecuteNow: true,
      canSubmit: true,
      components: {
        agentRuntime: {
          provider: "LEASED_WORKER",
          ready: true,
          status: "LEASE_ENDPOINT_READY",
        },
        execution: { matchingRunners: 1, ready: true, status: "READY" },
        specification: { ready: true },
      },
      ready: true,
      setupRequired: false,
      status: "READY",
    });
  });

  it("reports degraded readiness without rejecting Run v2 submissions", async () => {
    const { service } = createService();

    const readiness = await service.readiness(current);

    expect(readiness).toMatchObject({
      canExecuteNow: false,
      canSubmit: true,
      ready: true,
      status: "DEGRADED",
    });
  });

  it("reports degraded readiness when Issue context resolution is not configured", async () => {
    const { service } = createService({
      browserRuntimes: [
        { id: "runner-1", name: "Browser local", status: "ONLINE" },
      ],
      resolverReadiness: {
        github: { configured: false },
        knowledge: { configured: false },
        linear: { configured: false },
        ready: false,
      },
    });

    await expect(service.readiness(current)).resolves.toMatchObject({
      canExecuteNow: true,
      canSubmit: true,
      status: "DEGRADED",
    });
  });

  it("creates direct Playground work as a task execution", async () => {
    const { service, tasks } = createService({ task: { id: "task-direct" } });

    await expect(
      service.createRun(current, {
        acceptanceCriterion: "Example Domain is visible.",
        goal: "Open the page.",
        hitlEnabled: false,
        submissionId: "d63bd843-b89d-48ea-90c9-caad5b51d526",
        targetUrl: "https://example.com",
      }),
    ).resolves.toEqual({ id: "task-direct" });

    expect(tasks.create).toHaveBeenCalledOnce();
    expect(tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({ id: "user-1" }),
        team: current.team,
      }),
      expect.objectContaining({
        idempotencyKey: "playground-task:d63bd843-b89d-48ea-90c9-caad5b51d526",
        kind: "DIRECT_RUN",
        run: expect.objectContaining({
          environment: expect.objectContaining({
            targetUrl: "https://example.com",
          }),
          goal: "Open the page.",
          idempotencyKey: "playground-run:d63bd843-b89d-48ea-90c9-caad5b51d526",
          source: { kind: "PLAYGROUND" },
        }),
      }),
      { kind: "USER", triggerSource: "CONSOLE", userId: "user-1" },
    );
  });

  it("creates an Issue task with an optional deployment target", async () => {
    const { service, tasks } = createService({ task: { id: "task-issue" } });

    const result = await service.resolveSpecification(current, {
      issueRef: "ENG-123",
      submissionId: "d63bd843-b89d-48ea-90c9-caad5b51d526",
      targetUrl: "https://preview.example.com",
    });

    expect(result).toEqual({ id: "task-issue" });
    expect(tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({ team: current.team }),
      expect.objectContaining({
        idempotencyKey:
          "playground-issue-task:d63bd843-b89d-48ea-90c9-caad5b51d526",
        issueRef: "ENG-123",
        kind: "ISSUE_SPEC",
        targetUrl: "https://preview.example.com",
      }),
      { kind: "USER", triggerSource: "CONSOLE", userId: "user-1" },
    );
  });

  it("reuses the same task idempotency key when a submission is retried", async () => {
    const { service, tasks } = createService({ task: { id: "task-issue" } });
    const input = {
      issueRef: "ENG-123",
      submissionId: "d63bd843-b89d-48ea-90c9-caad5b51d526",
      targetUrl: "https://preview.example.com",
    };

    await Promise.all([
      service.resolveSpecification(current, input),
      service.resolveSpecification(current, input),
    ]);

    expect(tasks.create).toHaveBeenCalledTimes(2);
    expect(
      tasks.create.mock.calls.map((call) => call[1].idempotencyKey),
    ).toEqual([
      "playground-issue-task:d63bd843-b89d-48ea-90c9-caad5b51d526",
      "playground-issue-task:d63bd843-b89d-48ea-90c9-caad5b51d526",
    ]);
  });
});
