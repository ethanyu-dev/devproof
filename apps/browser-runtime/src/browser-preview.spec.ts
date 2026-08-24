import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { BrowserSessionManager } from "./index.js";

describe("BrowserSessionManager preview", () => {
  it("streams an OPEN session without granting human input", async () => {
    const emitPreview = vi.fn();
    const manager = new BrowserSessionManager(
      {
        removeSession: vi.fn(),
        replaceSession: vi.fn(),
        value: () => ({ sessions: [] }),
      } as never,
      "http://localhost:1",
      vi.fn(),
      emitPreview,
    );
    const sessionId = randomUUID();
    const leaseToken = randomUUID();
    const session = {
      fencingToken: "9",
      leaseToken,
      page: {
        screenshot: vi.fn().mockResolvedValue(Buffer.from("jpeg")),
        title: vi.fn().mockResolvedValue("Active verification"),
        url: vi.fn().mockReturnValue("https://example.com/verification"),
        viewportSize: vi.fn().mockReturnValue({ height: 720, width: 1280 }),
      },
      sessionId,
      state: "OPEN",
    };
    const sessions = (
      manager as unknown as { sessions: Map<string, typeof session> }
    ).sessions;
    sessions.set(sessionId, session);
    const streamId = randomUUID();

    manager.startPreview({
      fencingToken: "9",
      intervalMs: 60_000,
      leaseToken,
      quality: 65,
      sessionId,
      streamId,
      type: "human.preview.subscribe",
    });

    await vi.waitFor(() =>
      expect(emitPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          dataBase64: Buffer.from("jpeg").toString("base64"),
          sessionId,
          streamId,
          title: "Active verification",
          type: "human.preview.frame",
        }),
      ),
    );
    manager.stopPreview(streamId);

    await expect(
      manager.humanInput({
        dispatchId: randomUUID(),
        events: [],
        fencingToken: "9",
        leaseToken,
        sessionId,
        type: "human.input.dispatch",
      }),
    ).rejects.toThrow("Browser session is not in human control.");
  });
});
