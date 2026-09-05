import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeDrainService } from "./runtime-drain.service.js";
import { leaseDigest } from "./session-recovery.state.js";

const input = {
  snapshotDigest: "snapshot-1",
  idempotencyKey: "key-1",
  note: "Host termination confirmed by infrastructure inventory",
  evidenceRefs: ["infra:termination-1"],
  infrastructureTerminated: true as const,
};
const current = { team: { id: "team-1" }, user: { id: "admin-1" } } as never;
function fixture() {
  const runtime = {
    id: "runtime-1",
    teamId: "team-1",
    connectionGeneration: 2n,
    hostInstanceId: "host-1",
    enabled: false,
    status: "OFFLINE",
    drainState: "FROZEN",
    drainGeneration: 1,
  };
  const drain = {
    id: "drain-1",
    runtimeId: runtime.id,
    teamId: runtime.teamId,
    state: "FROZEN",
    snapshotDigest: "snapshot-1",
    drainGeneration: 1,
    connectionGeneration: runtime.connectionGeneration,
    hostInstanceId: runtime.hostInstanceId,
    idempotencyKey: null,
    attestationDigest: null,
    frozenSessions: [
      {
        sessionId: "session-1",
        fencingToken: "10",
        leaseDigest: "private-lease-digest",
        status: "LOST",
        closureVerifiedAt: null,
      },
    ],
  };
  const tx = {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    browserRuntime: {
      findFirst: vi.fn().mockResolvedValue(runtime),
      update: vi.fn(),
    },
    runtimeDrainAttestation: {
      findFirst: vi.fn().mockResolvedValue(drain),
      update: vi
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ ...drain, ...data }),
        ),
    },
    auditEvent: { create: vi.fn() },
  };
  tx.$transaction.mockImplementation((callback) => callback(tx));
  const recovery = { requireAdmin: vi.fn() };
  const closure = { acceptAdminDrainEvidence: vi.fn() };
  return {
    runtime,
    drain,
    tx,
    recovery,
    closure,
    service: new RuntimeDrainService(
      tx as never,
      recovery as never,
      closure as never,
    ),
  };
}
beforeEach(() => vi.stubEnv("RUNTIME_SESSION_RECOVERY_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("frozen Runtime drain attestation", () => {
  it.each([
    ["online node", { status: "ONLINE" }],
    ["enabled node", { enabled: true }],
    ["new connection", { connectionGeneration: 3n }],
    ["different host", { hostInstanceId: "host-2" }],
    ["new drain generation", { drainGeneration: 2 }],
  ])("rejects %s before accepting any closure", async (_reason, mutation) => {
    const { service, tx, runtime, closure } = fixture();
    tx.browserRuntime.findFirst.mockResolvedValue({ ...runtime, ...mutation });
    await expect(
      service.attest(current, runtime.id, "drain-1", input),
    ).rejects.toThrow("unchanged frozen Runtime");
    expect(closure.acceptAdminDrainEvidence).not.toHaveBeenCalled();
    expect(tx.runtimeDrainAttestation.update).not.toHaveBeenCalled();
  });

  it("passes only the frozen epochs to closure verification and keeps allocation disabled", async () => {
    const { service, runtime, tx, closure } = fixture();
    const result = await service.attest(current, runtime.id, "drain-1", input);
    expect(closure.acceptAdminDrainEvidence).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        sessionId: "session-1",
        expectedFencingToken: "10",
        expectedLeaseDigest: "private-lease-digest",
        actorId: "admin-1",
      }),
    );
    expect(tx.browserRuntime.update).toHaveBeenCalledWith({
      where: { id: runtime.id },
      data: { drainState: "ATTESTED" },
    });
    expect(result).toMatchObject({
      state: "ATTESTED",
      frozenSessions: [{ sessionId: "session-1" }],
    });
    expect(result.frozenSessions[0]).not.toHaveProperty("leaseDigest");
  });

  it("rejects a non-administrator even if the Runtime belongs to their team", async () => {
    const { service, recovery, closure } = fixture();
    recovery.requireAdmin.mockRejectedValue(
      new Error("Administrator required"),
    );
    await expect(
      service.attest(current, "runtime-1", "drain-1", input),
    ).rejects.toThrow("Administrator");
    expect(closure.acceptAdminDrainEvidence).not.toHaveBeenCalled();
  });

  it("an exact repeated attestation returns its durable result without closing again", async () => {
    const { service, tx, drain, closure } = fixture();
    tx.runtimeDrainAttestation.findFirst.mockResolvedValue({
      ...drain,
      state: "ATTESTED",
      idempotencyKey: input.idempotencyKey,
      attestationDigest: leaseDigest(
        JSON.stringify({
          snapshotDigest: input.snapshotDigest,
          note: input.note,
          evidenceRefs: input.evidenceRefs,
          infrastructureTerminated: input.infrastructureTerminated,
        }),
      ),
    });
    expect(
      (await service.attest(current, "runtime-1", "drain-1", input)).state,
    ).toBe("ATTESTED");
    expect(closure.acceptAdminDrainEvidence).not.toHaveBeenCalled();
  });

  it("reusing an idempotency key for altered evidence is rejected", async () => {
    const { service, tx, drain } = fixture();
    tx.runtimeDrainAttestation.findFirst.mockResolvedValue({
      ...drain,
      idempotencyKey: input.idempotencyKey,
      attestationDigest: "different-evidence",
    });
    await expect(
      service.attest(current, "runtime-1", "drain-1", input),
    ).rejects.toThrow("different drain evidence");
  });
});
