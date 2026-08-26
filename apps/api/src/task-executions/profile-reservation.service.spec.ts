import { describe, expect, it, vi } from "vitest";

import { ProfileReservationService } from "./profile-reservation.service.js";

function readyProfile() {
  return {
    grants: [
      {
        hostnamePattern: "app.example.com",
        triggerSource: "CONSOLE",
      },
    ],
    id: "profile-1",
    inactivityExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    owner: {
      memberships: [{ teamId: "team-1" }],
      status: "ACTIVE",
    },
    status: "READY",
  };
}

describe("ProfileReservationService", () => {
  it("activates only the FIFO head for a ready profile", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      browserProfileReservation: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "reservation-1" }),
        findMany: vi.fn().mockResolvedValue([]),
        updateMany,
        upsert: vi.fn().mockResolvedValue({
          activatedAt: null,
          id: "reservation-1",
          status: "QUEUED",
        }),
      },
      taskExecution: {
        findUnique: vi.fn().mockResolvedValue({
          id: "task-1",
          environmentSnapshot: { targetUrl: "https://app.example.com" },
          lifecycle: "RUNNING",
          profileBinding: {
            resolvedProfile: readyProfile(),
            status: "RESOLVED",
            triggerSource: "CONSOLE",
          },
          teamId: "team-1",
        }),
      },
    };
    const service = new ProfileReservationService(prisma as never);

    await expect(service.acquire("task-1")).resolves.toMatchObject({
      acquired: true,
      profile: { id: "profile-1" },
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACTIVE" }),
        where: { id: "reservation-1", status: "QUEUED" },
      }),
    );
  });

  it("keeps later tasks queued while another reservation is active", async () => {
    const prisma = {
      browserProfileReservation: {
        findFirst: vi.fn().mockResolvedValue({ id: "reservation-active" }),
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
        upsert: vi.fn().mockResolvedValue({
          activatedAt: null,
          id: "reservation-2",
          status: "QUEUED",
        }),
      },
      taskExecution: {
        findUnique: vi.fn().mockResolvedValue({
          id: "task-2",
          environmentSnapshot: { targetUrl: "https://app.example.com" },
          lifecycle: "RUNNING",
          profileBinding: {
            resolvedProfile: readyProfile(),
            status: "RESOLVED",
            triggerSource: "CONSOLE",
          },
          teamId: "team-1",
        }),
      },
    };
    const service = new ProfileReservationService(prisma as never);

    await expect(service.acquire("task-2")).resolves.toMatchObject({
      acquired: false,
      profile: { id: "profile-1" },
    });
    expect(prisma.browserProfileReservation.updateMany).not.toHaveBeenCalled();
  });

  it("invalidates a resolved binding when its trigger grant was revoked before dispatch", async () => {
    const tx = {
      browserProfileReservation: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      taskExecution: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      taskExecutionEvent: { create: vi.fn().mockResolvedValue({}) },
      taskExecutionStage: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      taskDeploymentProfileBinding: { deleteMany: vi.fn() },
      taskProfileBinding: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const revoked = { ...readyProfile(), grants: [] };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
      taskExecution: {
        findUnique: vi.fn().mockResolvedValue({
          environmentSnapshot: { targetUrl: "https://app.example.com" },
          id: "task-3",
          lifecycle: "RUNNING",
          profileBinding: {
            resolvedProfile: revoked,
            status: "RESOLVED",
            triggerSource: "CONSOLE",
          },
          teamId: "team-1",
        }),
      },
    };
    const service = new ProfileReservationService(prisma as never);

    await expect(service.acquire("task-3")).resolves.toMatchObject({
      acquired: false,
      profile: { id: "profile-1" },
    });
    expect(tx.taskProfileBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureCode: "PROFILE_AUTHORIZATION_CHANGED",
          status: "WAITING_INPUT",
        }),
      }),
    );
    expect(tx.taskExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lifecycle: "WAITING_INPUT",
          waitingReason: "PROFILE_AUTHORIZATION_CHANGED",
        }),
      }),
    );
  });

  it("invalidates a resolved binding when the Profile expired before dispatch", async () => {
    const tx = {
      browserProfileReservation: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      taskExecution: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      taskExecutionEvent: { create: vi.fn().mockResolvedValue({}) },
      taskExecutionStage: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      taskDeploymentProfileBinding: { deleteMany: vi.fn() },
      taskProfileBinding: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const expired = {
      ...readyProfile(),
      inactivityExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
      taskExecution: {
        findUnique: vi.fn().mockResolvedValue({
          environmentSnapshot: { targetUrl: "https://app.example.com" },
          id: "task-expired",
          lifecycle: "RUNNING",
          profileBinding: {
            resolvedProfile: expired,
            status: "RESOLVED",
            triggerSource: "CONSOLE",
          },
          teamId: "team-1",
        }),
      },
    };
    const service = new ProfileReservationService(prisma as never);

    await expect(service.acquire("task-expired")).resolves.toMatchObject({
      acquired: false,
      profile: { id: "profile-1" },
    });
    expect(tx.taskProfileBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureCode: "PROFILE_INACTIVITY_EXPIRED",
          status: "WAITING_INPUT",
        }),
      }),
    );
    expect(tx.taskExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lifecycle: "WAITING_INPUT",
          waitingReason: "PROFILE_INACTIVITY_EXPIRED",
        }),
      }),
    );
  });
});
