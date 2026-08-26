import { verificationRequestSchema } from "@devproof/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  BrowserExecutionRunner,
  supportsBrowserAgentProtocol,
} from "./browser-execution-runner.service.js";

describe("Browser Runtime protocol selection", () => {
  it("rejects legacy runtimes before allocating a session", () => {
    expect(
      supportsBrowserAgentProtocol({ protocolMajor: 1, protocolMinor: 1 }),
    ).toBe(false);
    expect(
      supportsBrowserAgentProtocol({ protocolMajor: 1, protocolMinor: 2 }),
    ).toBe(false);
    expect(
      supportsBrowserAgentProtocol({ protocolMajor: 1, protocolMinor: 7 }),
    ).toBe(true);
    expect(
      supportsBrowserAgentProtocol({ protocolMajor: 2, protocolMinor: 2 }),
    ).toBe(false);
  });
});

describe("Browser Runtime flexible pool selection", () => {
  it("prefers the idle node and preserves capacity for its pinned queues", async () => {
    const runtimes = [
      {
        capabilities: [],
        id: "runtime-a",
        maxConcurrency: 4,
        protocolMajor: 1,
        protocolMinor: 7,
      },
      {
        capabilities: [],
        id: "runtime-b",
        maxConcurrency: 8,
        protocolMajor: 1,
        protocolMinor: 7,
      },
    ];
    const prisma = {
      browserExecution: {
        groupBy: vi
          .fn()
          .mockResolvedValue([
            { _count: { _all: 6 }, targetRuntimeId: "runtime-a" },
          ]),
      },
      browserRuntime: { findMany: vi.fn().mockResolvedValue(runtimes) },
      browserRuntimeSlot: {
        groupBy: vi
          .fn()
          .mockResolvedValue([{ _count: { _all: 4 }, runtimeId: "runtime-a" }]),
      },
      runtimeRoutingRule: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const runner = new BrowserExecutionRunner(
      prisma as never,
      { isRuntimeOnline: vi.fn().mockResolvedValue(true) } as never,
      {} as never,
      {} as never,
    );
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Page loads", id: "loads" }],
      execution: {
        requiredCapabilities: ["browser"],
        targetUrl: "https://unmatched.example.net",
      },
      goal: "Verify the page",
      idempotencyKey: "flexible-runtime-selection",
    });

    const selection = await (
      runner as unknown as {
        selectRuntimes: (
          teamId: string,
          request: typeof request,
        ) => Promise<{ runtimes: typeof runtimes }>;
      }
    ).selectRuntimes("team-1", request);

    expect(selection.runtimes.map((runtime) => runtime.id)).toEqual([
      "runtime-b",
      "runtime-a",
    ]);
  });
});

describe("Browser Runtime persistent Profile affinity", () => {
  it("routes a reused Profile back to the Runtime that last held it", async () => {
    const prisma = {
      browserRuntimeSession: {
        findFirst: vi.fn(async () => ({ runtimeId: "runtime-2" })),
      },
      verificationRun: {
        findFirst: vi.fn(async () => ({ runtimeSessionId: null })),
      },
      userBrowserProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const runner = new BrowserExecutionRunner(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const selectRuntimes = vi
      .spyOn(runner as never, "selectRuntimes" as never)
      .mockResolvedValue({
        availabilityPolicyOverride: undefined,
        routing: { source: "POOL" },
        runtimes: [],
      } as never);
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Dashboard loads", id: "loads" }],
      execution: {
        profile: { key: "fp-issue-cycle", mode: "PERSISTENT" },
        requiredCapabilities: ["browser"],
      },
      goal: "Verify the dashboard",
      idempotencyKey: "profile-affinity",
    });

    await expect(runner.acquire("team-1", "run-1", request)).rejects.toThrow(
      "No online Browser Runtime",
    );

    expect(selectRuntimes).toHaveBeenCalledWith("team-1", request, "runtime-2");
    expect(prisma.browserRuntimeSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          profileKey: "fp-issue-cycle",
          profileMode: "PERSISTENT",
          teamId: "team-1",
        }),
      }),
    );
  });
});

describe("Browser Runtime user Profile authorization", () => {
  it("rejects a raw user Profile key not bound by the control plane", async () => {
    const prisma = {
      browserExecution: {
        findFirst: vi.fn().mockResolvedValue({
          run: { browserProfileId: null },
          runId: "run-1",
          runtimeSessionId: null,
        }),
      },
      userBrowserProfile: {
        findUnique: vi.fn().mockResolvedValue({
          id: "profile-1",
          runtimeProfileKey: "opaque-user-profile",
          status: "READY",
        }),
      },
    };
    const runner = new BrowserExecutionRunner(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Dashboard loads", id: "loads" }],
      execution: {
        profile: { key: "opaque-user-profile", mode: "PERSISTENT" },
        requiredCapabilities: ["browser"],
      },
      goal: "Verify the dashboard",
      idempotencyKey: "profile-authorization",
    });

    await expect(
      runner.acquireForExecutionRun("team-1", "execution-1", request),
    ).rejects.toThrow("not authorized by this execution Run");
  });

  it("rejects a bound user Profile after its inactivity deadline", async () => {
    const prisma = {
      browserExecution: {
        findFirst: vi.fn().mockResolvedValue({
          run: { browserProfileId: "profile-1" },
          runId: "run-1",
          runtimeSessionId: null,
        }),
      },
      userBrowserProfile: {
        findUnique: vi.fn().mockResolvedValue({
          id: "profile-1",
          inactivityExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
          runtimeProfileKey: "opaque-user-profile",
          status: "READY",
        }),
      },
    };
    const runner = new BrowserExecutionRunner(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Dashboard loads", id: "loads" }],
      execution: {
        profile: { key: "opaque-user-profile", mode: "PERSISTENT" },
        requiredCapabilities: ["browser"],
      },
      goal: "Verify the dashboard",
      idempotencyKey: "profile-expiry",
    });

    await expect(
      runner.acquireForExecutionRun("team-1", "execution-1", request),
    ).rejects.toThrow("expired");
  });

  it("rejects a user Profile key on the legacy Verification Run path", async () => {
    const prisma = {
      userBrowserProfile: {
        findUnique: vi.fn().mockResolvedValue({ id: "profile-1" }),
      },
      verificationRun: {
        findFirst: vi.fn().mockResolvedValue({ runtimeSessionId: null }),
      },
    };
    const runner = new BrowserExecutionRunner(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Dashboard loads", id: "loads" }],
      execution: {
        profile: { key: "opaque-user-profile", mode: "PERSISTENT" },
        requiredCapabilities: ["browser"],
      },
      goal: "Verify the dashboard",
      idempotencyKey: "legacy-profile-authorization",
    });

    await expect(runner.acquire("team-1", "run-1", request)).rejects.toThrow(
      "cannot open a user Browser Profile by raw key",
    );
  });

  it("rejects raw-key purge unless the logical user Profile id is authorized", async () => {
    const prisma = {
      userBrowserProfile: {
        findUnique: vi.fn().mockResolvedValue({ id: "profile-1" }),
      },
    };
    const runner = new BrowserExecutionRunner(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      runner.purgeProfile("team-1", "opaque-user-profile"),
    ).rejects.toThrow("logical profile resource");
  });
});
