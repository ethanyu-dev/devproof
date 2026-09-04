import { randomUUID } from "node:crypto";
import type { RuntimeSessionPermit } from "@devproof/runtime-protocol";
import { describe, expect, it } from "vitest";
import { SessionPermits } from "./session-permits.js";

function fixture() {
  let monotonic = 0;
  let wall = Date.parse("2026-09-04T00:00:00Z");
  const registry = new SessionPermits(
    () => monotonic,
    () => wall,
  );
  const permit: RuntimeSessionPermit = {
    sessionId: randomUUID(),
    leaseToken: randomUUID(),
    fencingToken: "5",
    ownerKind: "AGENT",
    ownerTaskId: randomUUID(),
    ownerFencingToken: "2",
    expiresAt: new Date(wall + 10_000).toISOString(),
  };
  return {
    registry,
    permit,
    advance: (ms: number) => {
      monotonic += ms;
      wall += ms;
    },
    rewindWall: () => {
      wall -= 60_000;
    },
  };
}

describe("local browser execution permits", () => {
  it("never renews an expired permit, even before the watchdog runs", () => {
    const { registry, permit, advance } = fixture();
    registry.accept(permit, permit);
    advance(10_001);
    expect(() =>
      registry.accept(permit, { ...permit, expiresAt: "2026-09-04T00:10:00Z" }),
    ).toThrow(/expired/);
    expect(registry.isRevoked(permit.sessionId)).toBe(true);
    expect(() =>
      registry.accept(permit, {
        ...permit,
        fencingToken: "6",
        expiresAt: "2026-09-04T00:10:00Z",
      }),
    ).toThrow(/revived/);
  });

  it("blocks network on disconnect and validates both command owners", () => {
    const { registry, permit } = fixture();
    registry.accept(permit, permit);
    expect(registry.networkAllowed(permit)).toBe(true);
    expect(() =>
      registry.assert(permit, {
        ownerTaskId: permit.ownerTaskId,
        ownerFencingToken: "1",
      }),
    ).toThrow(/stale executor/);
    registry.setConnected(false);
    expect(registry.networkAllowed(permit)).toBe(false);
    registry.setConnected(true);
    expect(registry.networkAllowed(permit)).toBe(true);
  });

  it("does not extend expiry through a replay or wall clock rollback", () => {
    const { registry, permit, advance, rewindWall } = fixture();
    registry.accept(permit, permit);
    advance(9_000);
    rewindWall();
    expect(registry.accept(permit, permit)).toBe(false);
    advance(1_001);
    expect(registry.networkAllowed(permit)).toBe(false);
  });

  it("ignores an expired older permit while the same owner has a live renewal", () => {
    const { registry, permit, advance } = fixture();
    registry.accept(permit, permit);
    registry.accept(permit, { ...permit, expiresAt: "2026-09-04T00:01:00Z" });
    advance(11_000);
    expect(registry.accept(permit, permit)).toBe(false);
    expect(registry.isRevoked(permit.sessionId)).toBe(false);
    expect(registry.networkAllowed(permit)).toBe(true);
    advance(49_001);
    expect(registry.networkAllowed(permit)).toBe(false);
  });

  it("resumes the same Agent through an explicit new control generation and fences delayed control messages", () => {
    const { registry, permit } = fixture();
    registry.accept(permit, { ...permit, controlGeneration: 0 });
    const human = {
      ...permit,
      ownerKind: "HUMAN" as const,
      controlGeneration: 1,
    };
    registry.accept(permit, human);
    expect(() => registry.accept(permit, permit)).toThrow(/stale control/);
    const resumed = { ...permit, controlGeneration: 2 };
    expect(registry.accept(permit, resumed)).toBe(true);
    expect(() => registry.accept(permit, human)).toThrow(/stale control/);
    expect(() =>
      registry.assert(permit, { ...permit, controlGeneration: 0 }),
    ).toThrow(/stale control/);
    expect(registry.assert(permit, resumed).ownerKind).toBe("AGENT");
    expect(registry.networkAllowed(permit)).toBe(true);
    registry.accept(permit, { ...human, controlGeneration: 3 });
    registry.accept(permit, { ...resumed, controlGeneration: 4 });
    expect(() => registry.accept(permit, resumed)).toThrow(/stale control/);
  });

  it("uses a monotonic server clock for renewed command permits after a local wall clock rollback", () => {
    const { registry, permit, advance, rewindWall } = fixture();
    registry.synchronizeClock("2026-09-04T00:00:00Z", 100);
    registry.accept(permit, permit);
    advance(1_000);
    rewindWall();
    registry.accept(permit, { ...permit, expiresAt: "2026-09-04T00:00:20Z" });
    advance(18_901);
    expect(registry.networkAllowed(permit)).toBe(false);
  });

  it("requires a new executor epoch after human control and rejects late agent commands", () => {
    const { registry, permit } = fixture();
    registry.accept(permit, permit);
    registry.accept(permit, {
      sessionId: permit.sessionId,
      fencingToken: permit.fencingToken,
      leaseToken: permit.leaseToken,
      ownerKind: "HUMAN",
      expiresAt: permit.expiresAt,
    });
    expect(() => registry.accept(permit, permit)).toThrow(/new executor epoch/);
    expect(() =>
      registry.assert(permit, {
        ownerTaskId: permit.ownerTaskId,
        ownerFencingToken: permit.ownerFencingToken,
      }),
    ).toThrow(/stale executor/);
    expect(registry.accept(permit, { ...permit, ownerFencingToken: "3" })).toBe(
      true,
    );
    expect(() =>
      registry.accept(permit, { ...permit, ownerKind: "HUMAN" }),
    ).toThrow(/stale owner/);
  });

  it("keeps startup offline, rejects stale ACK ownership, and fences older executor epochs after human control", () => {
    const { registry, permit } = fixture();
    registry.accept(permit, { ...permit, ownerKind: "STARTUP" });
    expect(registry.networkAllowed(permit)).toBe(false);
    registry.accept(permit, { ...permit, ownerFencingToken: "3" });
    registry.accept(permit, {
      ...permit,
      ownerKind: "HUMAN",
      ownerFencingToken: "3",
    });
    expect(() =>
      registry.assert(permit, {
        ownerKind: "HUMAN",
        ownerTaskId: permit.ownerTaskId,
        ownerFencingToken: "3",
      }),
    ).not.toThrow();
    expect(() => registry.accept(permit, permit)).toThrow(/stale owner/);
    expect(registry.get(permit.sessionId)?.ownerKind).toBe("HUMAN");
  });
});
