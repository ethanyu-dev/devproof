import { describe, expect, it, vi } from "vitest";

import {
  sanitizeLogBundleValue,
  TaskLogBundleService,
} from "./task-log-bundle.service.js";

describe("sanitizeLogBundleValue", () => {
  it("preserves runtime session logs while removing credentials and identifiers", () => {
    expect(
      sanitizeLogBundleValue({
        runtimeSession: {
          id: "runtime-session-secret",
          commands: [
            {
              payload: {
                headers: [{ name: "Cookie", value: "session=secret" }],
                profileKey: "profile-secret",
                url: "/home",
              },
            },
          ],
          events: [{ kind: "page.loaded" }],
          status: "RELEASED",
        },
        executionPolicy: {
          browser: {
            profile: { key: "persistent-profile-secret", mode: "PERSISTENT" },
          },
        },
        sessionId: "session-secret",
        token: "token-secret",
      }),
    ).toEqual({
      runtimeSession: {
        id: "[REDACTED]",
        commands: [
          {
            payload: {
              headers: [{ name: "Cookie", value: "[REDACTED]" }],
              profileKey: "[REDACTED]",
              url: "/home",
            },
          },
        ],
        events: [{ kind: "page.loaded" }],
        status: "RELEASED",
      },
      executionPolicy: {
        browser: {
          profile: { key: "[REDACTED]", mode: "PERSISTENT" },
        },
      },
      sessionId: "[REDACTED]",
      token: "[REDACTED]",
    });
  });

  it("redacts bearer tokens and sensitive URL parameters in free text", () => {
    const value = sanitizeLogBundleValue(
      "request Bearer abc.def and Cookie: session=secret; role=admin\nhttps://example.com/path?token=secret&view=full",
    );

    expect(value).not.toContain("abc.def");
    expect(value).not.toContain("session=secret");
    expect(value).not.toContain("token=secret");
    expect(value).toContain("view=full");
  });

  it("redacts cloud credentials and private keys from structured and free text", () => {
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const value = sanitizeLogBundleValue({
      accessKeyId: "AKIAEXAMPLE",
      environment: {
        privateKey,
        secretAccessKey: "secret-access-key-value",
      },
      output: `privateKey=${privateKey}`,
    });

    expect(value).toEqual({
      accessKeyId: "[REDACTED]",
      environment: {
        privateKey: "[REDACTED]",
        secretAccessKey: "[REDACTED]",
      },
      output: "privateKey=[REDACTED]",
    });
    expect(JSON.stringify(value)).not.toContain("AKIAEXAMPLE");
    expect(JSON.stringify(value)).not.toContain("secret-access-key-value");
    expect(JSON.stringify(value)).not.toContain("cHJpdmF0ZS1rZXktbWF0ZXJpYWw");
  });
});

describe("Task log export", () => {
  it("exports team-scoped durable events without analysis storage or attachments", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "task-1",
      traceId: "trace-1",
      executionGeneration: 4,
      analysisSources: [],
      caseExecutions: [],
      deployments: [],
      executionRuns: [],
      specificationSnapshots: [],
      stages: [],
    });
    const invocations = vi.fn().mockResolvedValue([]);
    const service = new TaskLogBundleService({
      taskExecution: { findFirst },
      taskExecutionEvent: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "event-1", sequence: 12n, payload: { token: "secret" } },
          ]),
      },
      runEvent: { findMany: vi.fn().mockResolvedValue([]) },
      toolInvocation: { findMany: invocations },
    } as never);
    const result = await service.build("team-1", "task-1");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "task-1", teamId: "team-1" } }),
    );
    expect(invocations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teamId: "team-1", traceId: "trace-1" },
      }),
    );
    expect(result).toEqual({
      bundle: expect.objectContaining({
        schemaVersion: "devproof.task-logs.v2",
        task: expect.objectContaining({
          executionGeneration: 4,
          taskEvents: [
            {
              id: "event-1",
              sequence: "12",
              evidenceRef: "task-event://event-1",
              payload: { token: "[REDACTED]" },
            },
          ],
        }),
        watermarks: { taskEvents: "12", runEvents: {} },
      }),
    });
  });

  it("does not export events for a task outside the authenticated team", async () => {
    const events = vi.fn();
    const service = new TaskLogBundleService({
      taskExecution: { findFirst: vi.fn().mockResolvedValue(null) },
      taskExecutionEvent: { findMany: events },
    } as never);
    await expect(service.build("other-team", "task-1")).rejects.toThrow(
      "was not found",
    );
    expect(events).not.toHaveBeenCalled();
  });
});
