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
