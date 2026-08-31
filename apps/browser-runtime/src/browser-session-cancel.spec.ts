import { describe, expect, it, vi } from "vitest";

import { BrowserSessionManager } from "./index.js";

describe("BrowserSessionManager command cancellation", () => {
  it("force-closes the browser when session.close is cancelled", async () => {
    const manager = Object.create(
      BrowserSessionManager.prototype,
    ) as BrowserSessionManager;
    const close = vi.spyOn(manager, "close").mockResolvedValue(undefined);

    await manager.cancel("session-1", "session.close");

    expect(close).toHaveBeenCalledWith("session-1");
  });
});
