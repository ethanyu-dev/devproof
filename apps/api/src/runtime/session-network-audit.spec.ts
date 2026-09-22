import { describe, it, expect, vi } from "vitest";
import type { BrowserRuntimeSession, Prisma } from "@prisma/client";
import { hasVerifiedNoWriteNetworkAudit } from "./session-write-audit.js";
function fixture() {
  const session = {
    id: "session",
    protocolMinor: 21,
    purpose: "EXECUTION",
    status: "CLOSED",
    closureVerifiedAt: new Date(),
    closureEvidenceId: "proof",
    controlGeneration: 0,
    ownerTaskId: "owner",
    ownerFencingToken: 1n,
    launchIdentityVersion: 1,
    launchIdentity: { id: "launch" },
    leaseToken: "lease",
    fencingToken: 2n,
  } as BrowserRuntimeSession;
  const audit = {
    version: 1,
    launchIdentityId: "launch",
    coverage: "ISOLATED_CONTEXT_UNTIL_CLOSE",
    complete: true,
    requestCount: 12,
    potentialWrites: 0,
  };
  const tx = {
    sessionClosureEvidence: { findFirst: vi.fn().mockResolvedValue(null) },
    browserRuntimeCommand: {
      findFirst: vi.fn(async () => ({
        result: { closed: true, writeAudit: audit },
      })),
      count: vi.fn(async (_query: unknown) => 0),
    },
  };
  return {
    session,
    audit,
    tx,
    check: () =>
      hasVerifiedNoWriteNetworkAudit(
        tx as unknown as Prisma.TransactionClient,
        session,
      ),
  };
}
describe("closed session no-write proof", () => {
  it("accepts a fenced complete audit independently of verification verdict", async () => {
    const f = fixture();
    expect(await f.check()).toBe(true);
    expect(f.tx.browserRuntimeCommand.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          leaseToken: "lease",
          fencingToken: 2n,
          status: "SUCCEEDED",
        }),
      }),
    );
  });
  it.each([
    { complete: false },
    { potentialWrites: 1 },
    { launchIdentityId: "stale" },
    { coverage: "PARTIAL" },
    { requestCount: -1 },
  ])("rejects inadequate proof %j", async (patch) => {
    const f = fixture();
    Object.assign(f.audit, patch);
    expect(await f.check()).toBe(false);
  });
  it.each([
    { protocolMinor: 20 },
    { closureVerifiedAt: null },
    { closureEvidenceId: null },
    { status: "OPEN" },
  ])("requires isolated verified closure %j", async (patch) => {
    const f = fixture();
    Object.assign(f.session, patch);
    expect(await f.check()).toBe(false);
  });
  it("rejects commands outside the audited context or epoch", async () => {
    const f = fixture();
    f.tx.browserRuntimeCommand.count.mockResolvedValue(1);
    expect(await f.check()).toBe(false);
  });
  it.each([1, 2, 4])(
    "accepts complete no-write proof after human control generation %i",
    async (controlGeneration) => {
      const f = fixture();
      f.session.controlGeneration = controlGeneration;
      expect(await f.check()).toBe(true);
      const filter = f.tx.browserRuntimeCommand.count.mock
        .calls[0]?.[0] as unknown as {
        where: { OR: Array<{ commandType?: { notIn: string[] } }> };
      };
      const audited = filter.where.OR.find((clause) => clause.commandType)!
        .commandType!.notIn;
      expect(audited).toEqual(
        expect.arrayContaining([
          "human.takeover",
          "human.release",
          "page.type",
          "page.reload",
          "page.resize",
        ]),
      );
      expect(audited).not.toContain("http.request");
    },
  );
  it.each([{ complete: false }, { potentialWrites: 1 }])(
    "keeps a cancelled human-controlled session quarantined without no-write proof %j",
    async (patch) => {
      const f = fixture();
      f.session.controlGeneration = 2;
      Object.assign(f.audit, patch);
      expect(await f.check()).toBe(false);
    },
  );
});

it("settles an inconclusive verification only when an independent closed-session audit proves no HTTP writes", async () => {
  const { initialWriteState } = await import("./session-recovery.state.js");
  const f = fixture();
  const tx = {
    ...f.tx,
    agentRuntimeTask: {
      findUnique: vi.fn(async () => ({
        status: "SUCCEEDED",
        fencingToken: 1n,
        completionId: "done",
        result: { kind: "VERIFICATION_COMPLETED", verdict: "INCONCLUSIVE" },
      })),
    },
    executionResourceLease: {
      findMany: vi.fn(async () => [{ mode: "WRITE" }]),
    },
  };
  expect(
    await initialWriteState(
      tx as unknown as Prisma.TransactionClient,
      f.session,
    ),
  ).toBe("NO_WRITE_VERIFIED");
  f.audit.complete = false;
  expect(
    await initialWriteState(
      tx as unknown as Prisma.TransactionClient,
      f.session,
    ),
  ).toBe("UNKNOWN");
});

it("uses the authenticated closure audit when the close RPC timed out", async () => {
  const f = fixture();
  f.tx.browserRuntimeCommand.findFirst.mockResolvedValue(null as never);
  f.tx.sessionClosureEvidence.findFirst.mockResolvedValue({
    summary: { writeAudit: f.audit },
  });
  expect(await f.check()).toBe(true);
  f.audit.potentialWrites = 1;
  expect(await f.check()).toBe(false);
});
