import { describe, expect, it, vi } from "vitest";
import { BrowserAdmissionService } from "./browser-admission.service.js";

function fixture(attempts: number, resolved = false) {
  const prisma = {
    $transaction: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([]),
    runtimeSessionRecovery: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ resolvedAt: resolved ? new Date() : null }),
    },
    browserExecution: {
      findUnique: vi
        .fn()
        .mockImplementation(({ select }) =>
          select?.admissionAttempts ? { admissionAttempts: attempts } : null,
        ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  prisma.$transaction.mockImplementation((operation) => operation(prisma));
  const service = new BrowserAdmissionService(prisma as never, {} as never);
  const defer = Reflect.get(service, "defer").bind(service) as (
    ...args: unknown[]
  ) => Promise<void>;
  return { defer, prisma };
}
describe("Recovery admission retry timing", () => {
  it.each([
    [1, 5000],
    [2, 15000],
    [3, 30000],
    [4, 60000],
    [20, 60000],
  ])(
    "backs off recovery attempt %s without modifying the Run deadline",
    async (attempt, delay) => {
      const { defer, prisma } = fixture(attempt);
      const before = Date.now();
      await defer("execution", "LEASE_RECOVERY", "pending", "allocation", {
        recoveryId: "recovery",
      });
      const args = prisma.browserExecution.updateMany.mock.calls[0]![0];
      expect(args.data.nextAdmissionAt.getTime()).toBeGreaterThanOrEqual(
        before + delay,
      );
      expect(args.data.nextAdmissionAt.getTime()).toBeLessThan(
        Date.now() + delay + 1,
      );
      expect(args.data).not.toHaveProperty("deadlineAt");
      expect(args.data.blockingRecoveryId).toBe("recovery");
    },
  );
  it("runs admission immediately if closure resolution raced the blocker registration", async () => {
    const { defer, prisma } = fixture(20, true);
    const before = Date.now();
    await defer("execution", "LEASE_RECOVERY", "pending", "allocation", {
      recoveryId: "recovery",
    });
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    const at =
      prisma.browserExecution.updateMany.mock.calls[0]![0].data.nextAdmissionAt.getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
  it("keeps ordinary data waiters on the existing two-second cadence", async () => {
    const { defer, prisma } = fixture(20);
    const before = Date.now();
    await defer("execution", "DATA_LOCK", "writer active", "allocation");
    const at =
      prisma.browserExecution.updateMany.mock.calls[0]![0].data.nextAdmissionAt.getTime();
    expect(at).toBeGreaterThanOrEqual(before + 2000);
    expect(at).toBeLessThanOrEqual(Date.now() + 2000);
    expect(prisma.runtimeSessionRecovery.findUnique).not.toHaveBeenCalled();
  });
});
