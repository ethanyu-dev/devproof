import { describe, expect, it, vi } from "vitest";

import { BrowserSessionManager } from "./index.js";

describe("BrowserSessionManager command cancellation", () => {
  it("retains partial field results when the final permit check fails", async () => {
    const manager = Object.create(
      BrowserSessionManager.prototype,
    ) as BrowserSessionManager;
    const sequence = {
      status: "PARTIAL",
      fields: [
        { ref: "field-1", status: "COMPLETED" },
        { ref: "field-2", status: "FAILED" },
      ],
    };
    Reflect.set(manager, "activeCommands", new Map());
    Reflect.set(
      manager,
      "sessions",
      new Map([
        ["session-1", { page: {}, actionFeedback: { begin: vi.fn() } }],
      ]),
    );
    Reflect.set(manager, "requirePermits", true);
    Reflect.set(manager, "visualObservations", { invalidate: vi.fn() });
    Reflect.set(manager, "pageId", () => "page-1");
    Reflect.set(manager, "executeCommand", async () => ({
      result: { formSequence: sequence },
    }));
    Reflect.set(manager, "permits", {
      assert: () => {
        throw Object.assign(new Error("permit lost"), {
          code: "SESSION_PERMIT_EXPIRED",
        });
      },
    });
    await expect(
      manager.execute({
        commandType: "page.fill_fields",
        commandId: "command-1",
        sessionId: "session-1",
        payload: {},
      } as never),
    ).rejects.toMatchObject({
      code: "SESSION_PERMIT_EXPIRED",
      details: { formSequence: sequence },
    });
  });

  it("force-closes the browser when session.close is cancelled", async () => {
    const manager = Object.create(
      BrowserSessionManager.prototype,
    ) as BrowserSessionManager;
    Reflect.set(manager, "activeCommands", new Map());
    Reflect.set(manager, "cancelledCommands", new Set());
    const close = vi.spyOn(manager, "close").mockResolvedValue(undefined);

    await manager.cancel("session-1", "session.close");

    expect(close).toHaveBeenCalledWith("session-1");
  });
});
