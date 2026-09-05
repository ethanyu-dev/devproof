import { describe, expect, it, vi } from "vitest";

import { RuntimeLeaseSweeper } from "./runtime-lease-sweeper.service.js";

describe("RuntimeLeaseSweeper", () => {
  it("recovers stale verifying Profiles that no longer have a live session", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      browserRuntimeCommand: { findMany: vi.fn().mockResolvedValue([]) },
      browserRuntimeSession: {
        findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
      },
      userBrowserProfile: { updateMany },
    };
    const sweeper = new RuntimeLeaseSweeper(
      prisma as never,
      { cancel: vi.fn(), execute: vi.fn() } as never,
    );

    await sweeper.sweep();

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ status: "UNINITIALIZED" }),
        where: expect.objectContaining({
          lastVerifiedAt: null,
          status: "VERIFYING",
        }),
      }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ status: "REAUTH_REQUIRED" }),
        where: expect.objectContaining({
          lastVerifiedAt: { not: null },
          status: "VERIFYING",
        }),
      }),
    );
  });
});

it("does not quarantine a session renewed after the expired-session scan", async () => {
  const prisma = {
    $transaction: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([]),
    browserRuntimeSession: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([{ id: "session-1" }])
        .mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    browserRuntimeCommand: { findMany: vi.fn().mockResolvedValue([]) },
    userBrowserProfile: { updateMany: vi.fn() },
    executionResourceLease: { updateMany: vi.fn() },
  };
  prisma.$transaction.mockImplementation((operation) => operation(prisma));
  await new RuntimeLeaseSweeper(prisma as never, {} as never).sweep();
  expect(prisma.browserRuntimeSession.updateMany).toHaveBeenCalledOnce();
  expect(prisma.browserRuntimeSession.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        leaseExpiresAt: { lte: expect.any(Date) },
        closureVerifiedAt: null,
      }),
    }),
  );
  expect(prisma.executionResourceLease.updateMany).not.toHaveBeenCalled();
});
