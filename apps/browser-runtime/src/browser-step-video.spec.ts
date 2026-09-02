import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { BrowserSessionManager } from "./index.js";

function composer(result: Promise<unknown>) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockReturnValue(result),
  };
}

function setup(composers: Array<ReturnType<typeof composer>>) {
  const store = {
    removeSession: vi.fn().mockResolvedValue(undefined),
    replaceSession: vi.fn().mockResolvedValue(undefined),
    value: () => ({ sessions: [] }),
  };
  const emitEvent = vi.fn();
  const manager = new BrowserSessionManager(
    store as never,
    "http://127.0.0.1:1",
    emitEvent,
    vi.fn(),
  );
  const sessionId = randomUUID();
  const context = {
    newPage: vi.fn(),
    unrouteAll: vi.fn().mockResolvedValue(undefined),
  };
  for (const value of composers) context.newPage.mockResolvedValueOnce(value);
  const testable = manager as unknown as {
    captureStepArtifact: () => Promise<null>;
    sessions: Map<string, unknown>;
  };
  vi.spyOn(testable, "captureStepArtifact").mockResolvedValue(null);
  testable.sessions.set(sessionId, {
    browser: { close: vi.fn().mockResolvedValue(undefined) },
    context,
    fencingToken: "1",
    leaseToken: randomUUID(),
    networkFaultPolicies: new Map(),
    profileKey: `video-${sessionId}`,
    profileMode: "EPHEMERAL",
    sessionId,
    state: "OPEN",
    stepFrames: [
      {
        capturedAt: new Date().toISOString(),
        commandType: "page.click",
        data: Buffer.from("jpeg-frame"),
        height: 720,
        index: 1,
        title: "Example",
        url: "https://example.com",
        width: 1280,
      },
    ],
    stepSequence: 1,
  });
  const executeClose = () =>
    manager.execute({
      commandId: randomUUID(),
      commandType: "session.close",
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      fencingToken: "1",
      leaseToken: (testable.sessions.get(sessionId) as { leaseToken: string })
        .leaseToken,
      payload: {},
      sessionId,
      type: "command.execute",
    });
  return { context, emitEvent, executeClose, store };
}

describe("step video finalization", () => {
  it("falls back to a compatibility encoding profile", async () => {
    const primary = composer(Promise.reject(new Error("VP9 encoder failed")));
    const fallback = composer(
      Promise.resolve({
        dataBase64: Buffer.from("webm-video").toString("base64"),
        height: 540,
        mimeType: "video/webm;codecs=vp8",
        width: 960,
      }),
    );
    const { context, executeClose } = setup([primary, fallback]);

    const result = (await executeClose()) as {
      artifacts?: Array<{ kind: string; metadata: Record<string, unknown> }>;
      result?: Record<string, unknown>;
    };

    expect(context.newPage).toHaveBeenCalledTimes(2);
    expect(primary.close).toHaveBeenCalledOnce();
    expect(fallback.close).toHaveBeenCalledOnce();
    expect(result.result).toMatchObject({ videoCreated: true });
    expect(
      result.artifacts?.find((artifact) => artifact.kind === "VIDEO"),
    ).toMatchObject({
      metadata: {
        encodingProfile: "compatibility",
        fallbackUsed: true,
        height: 540,
        width: 960,
      },
    });
  });

  it("reports a durable finalization error when every profile fails", async () => {
    const { emitEvent, executeClose, store } = setup([
      composer(Promise.reject(new Error("VP9 encoder failed"))),
      composer(Promise.reject(new Error("VP8 encoder failed"))),
    ]);

    const result = (await executeClose()) as {
      artifacts?: Array<{ kind: string }>;
      result?: Record<string, unknown>;
    };

    expect(result.artifacts).toEqual([]);
    expect(result.result).toMatchObject({
      stepFrameCount: 1,
      videoCreated: false,
      videoError: {
        code: "VIDEO_COMPOSITION_FAILED",
        details: {
          attempts: [
            { durationMs: expect.any(Number), profile: "native" },
            { durationMs: expect.any(Number), profile: "compatibility" },
          ],
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: expect.any(String) }),
      "VIDEO_FINALIZATION_FAILED",
      expect.objectContaining({
        attempts: [
          expect.objectContaining({
            durationMs: expect.any(Number),
            profile: "native",
          }),
          expect.objectContaining({
            durationMs: expect.any(Number),
            profile: "compatibility",
          }),
        ],
        code: "VIDEO_COMPOSITION_FAILED",
        commandId: expect.any(String),
        durationMs: expect.any(Number),
        frameCount: 1,
        runtimeVersion: "0.2.16",
      }),
    );
    expect(store.removeSession).toHaveBeenCalledOnce();
  });
});
