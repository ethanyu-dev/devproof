import { runtimeEventSchema } from "@devproof/runtime-protocol";
import { describe, expect, it, vi } from "vitest";

import { RuntimeCommandDispatcher } from "./runtime-command-dispatcher.service.js";

const context = {
  runtimeId: "runtime-1",
  connectionId: "connection-1",
  connectionGeneration: 2n,
  negotiatedMinor: 14,
  capabilities: new Set(["closure-evidence-v1"]),
};
const sessionId = "11bb7c5c-cd52-4ae7-8759-6e4e1391357d";
const leaseToken = "70844616-602c-475b-95f6-393015b82ed1";

function videoFailureEvent() {
  return runtimeEventSchema.parse({
    eventId: "4a73bdf6-a1ad-4f78-af39-78e686539314",
    fencingToken: "7",
    kind: "VIDEO_FINALIZATION_FAILED",
    leaseToken,
    payload: {
      attempts: [
        {
          code: "COMMAND_FAILED",
          durationMs: 420,
          message: "Video encoding failed.",
          profile: "native",
        },
      ],
      code: "VIDEO_COMPOSITION_FAILED",
      commandId: "5c934746-41e4-4b41-8cab-5f79bf00cba0",
      durationMs: 421,
      frameCount: 21,
      message: "Step video composition failed for every encoding profile.",
      runtimeVersion: "0.2.16",
    },
    sessionId,
    timestamp: new Date().toISOString(),
    type: "runtime.event",
  });
}

function fixture(persistedCount: number) {
  const prisma = {
    browserRuntime: {
      findFirst: vi.fn().mockResolvedValue({ id: context.runtimeId }),
    },
    browserRuntimeEvent: {
      createMany: vi.fn().mockResolvedValue({ count: persistedCount }),
    },
    browserRuntimeSession: {
      findUnique: vi.fn().mockResolvedValue({
        runtimeId: context.runtimeId,
        fencingToken: BigInt(7),
        leaseToken,
      }),
    },
  };
  const metrics = {
    increment: vi.fn(),
    observe: vi.fn(),
  };
  const observability = { log: vi.fn() };
  const dispatcher = new RuntimeCommandDispatcher(
    prisma as never,
    {} as never,
    {} as never,
    metrics as never,
    observability as never,
  );
  return { dispatcher, metrics, observability, prisma };
}

describe("RuntimeCommandDispatcher video diagnostics", () => {
  it("persists one diagnostic and records bounded failure metrics", async () => {
    const { dispatcher, metrics, observability, prisma } = fixture(1);

    await dispatcher.acceptEvent(videoFailureEvent(), context);

    expect(prisma.browserRuntimeEvent.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "VIDEO_FINALIZATION_FAILED",
        sessionId,
      }),
      skipDuplicates: true,
    });
    expect(metrics.increment).toHaveBeenCalledWith(
      "devproof_runtime_video_finalization_failures_total",
      expect.any(String),
      { code: "video_composition_failed" },
    );
    expect(metrics.observe).toHaveBeenCalledWith(
      "devproof_runtime_video_finalization_duration_seconds",
      expect.any(String),
      0.421,
    );
    expect(metrics.observe).toHaveBeenCalledWith(
      "devproof_runtime_video_finalization_frames",
      expect.any(String),
      21,
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      "devproof_runtime_video_encoding_attempt_failures_total",
      expect.any(String),
      { code: "command_failed", profile: "native" },
    );
    expect(metrics.observe).toHaveBeenCalledWith(
      "devproof_runtime_video_encoding_attempt_duration_seconds",
      expect.any(String),
      0.42,
      { profile: "native" },
    );
    expect(observability.log).toHaveBeenCalledWith(
      "warn",
      "runtime.video_finalization.failed",
      expect.objectContaining({
        commandId: "5c934746-41e4-4b41-8cab-5f79bf00cba0",
        runtimeVersion: "0.2.16",
        sessionId,
      }),
    );
  });

  it("does not count an acknowledged event again after redelivery", async () => {
    const { dispatcher, metrics, observability } = fixture(0);

    await dispatcher.acceptEvent(videoFailureEvent(), context);

    expect(metrics.increment).not.toHaveBeenCalled();
    expect(metrics.observe).not.toHaveBeenCalled();
    expect(observability.log).not.toHaveBeenCalled();
  });
});
