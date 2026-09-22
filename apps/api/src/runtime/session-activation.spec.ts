import { describe, expect, it, vi } from "vitest";
import { activateOpenedSession } from "./session-activation.js";
import { sessionExecutionPermit } from "./session-permit.js";

function fixture() {
  const now = new Date();
  const session = {
    id: "session",
    leaseToken: "lease",
    fencingToken: 2n,
    profileMode: "EPHEMERAL" as const,
    status: "OPENING",
    leaseExpiresAt: new Date(now.getTime() + 10_000),
    executionPermitExpiresAt: new Date(now.getTime() + 10_000),
    createdAt: new Date(now.getTime() - 50_000),
  };
  const tx = {
    browserRuntimeSession: {
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(session, data);
        return { count: 1 };
      }),
    },
    browserRuntimeSlot: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    browserRuntimeProfileLease: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    browserExecution: {
      findFirst: vi.fn().mockResolvedValue({ id: "execution" }),
    },
  };
  return { tx, session, now };
}

describe("browser startup lease handoff", () => {
  it("keeps a slow successful startup alive through the next heartbeat", async () => {
    const { tx, session, now } = fixture();
    const expiresAt = await activateOpenedSession(tx as never, session, now);
    const permit = await sessionExecutionPermit(
      tx as never,
      session as never,
      new Date(now.getTime() + 15_000),
    );
    expect(permit?.ownerKind).toBe("STARTUP");
    expect(Date.parse(permit!.expiresAt)).toBeGreaterThan(
      now.getTime() + 15_000,
    );
    expect(tx.browserRuntimeSlot.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { expiresAt } }),
    );
    expect(tx.browserRuntimeSession.updateMany.mock.calls[0]![0]).toMatchObject(
      {
        where: {
          id: session.id,
          leaseToken: session.leaseToken,
          fencingToken: session.fencingToken,
          status: "OPENING",
          quarantinedAt: null,
          closureVerifiedAt: null,
          leaseExpiresAt: { gt: now },
        },
      },
    );
  });

  it("cannot revive expired, revoked, or superseded session ownership", async () => {
    const { tx, session, now } = fixture();
    tx.browserRuntimeSession.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await activateOpenedSession(tx as never, session, now)).toBeNull();
    expect(tx.browserRuntimeSlot.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a missing slot so the activation transaction rolls back", async () => {
    const { tx, session, now } = fixture();
    tx.browserRuntimeSlot.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      activateOpenedSession(tx as never, session, now),
    ).rejects.toThrow("slot ownership changed");
  });

  it("renews the matching persistent profile lease and rejects lost ownership", async () => {
    const { tx, session, now } = fixture();
    const persistent = { ...session, profileMode: "PERSISTENT" as const };
    await activateOpenedSession(tx as never, persistent, now);
    expect(tx.browserRuntimeProfileLease.updateMany).toHaveBeenCalledWith(
      tx.browserRuntimeSlot.updateMany.mock.calls[0]![0],
    );
    tx.browserRuntimeProfileLease.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    await expect(
      activateOpenedSession(tx as never, persistent, now),
    ).rejects.toThrow("profile ownership changed");
  });
});
