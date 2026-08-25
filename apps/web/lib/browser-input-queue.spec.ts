import type { BrowserHumanInputEvent } from "@devproof/runtime-protocol";
import { describe, expect, it, vi } from "vitest";

import { BrowserInputQueue } from "./browser-input-queue";

const down: BrowserHumanInputEvent[] = [
  { button: "left", phase: "down", type: "pointer", x: 0.5, y: 0.5 },
];
const up: BrowserHumanInputEvent[] = [
  { button: "left", phase: "up", type: "pointer", x: 0.5, y: 0.5 },
];

describe("BrowserInputQueue", () => {
  it("waits for an input acknowledgement before dispatching the next input", async () => {
    let acknowledgeFirst: (() => void) | undefined;
    const dispatch = vi.fn((events: BrowserHumanInputEvent[]) => {
      if (events === down) {
        return new Promise<void>((resolve) => {
          acknowledgeFirst = resolve;
        });
      }
      return Promise.resolve();
    });
    const queue = new BrowserInputQueue(dispatch);

    const first = queue.enqueue(down);
    const second = queue.enqueue(up);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenNthCalledWith(1, down);

    acknowledgeFirst?.();
    await Promise.all([first, second]);
    expect(dispatch).toHaveBeenNthCalledWith(2, up);
  });

  it("keeps only the latest queued pointer move without dropping its waiters", async () => {
    let acknowledgeDown: (() => void) | undefined;
    const dispatched: BrowserHumanInputEvent[][] = [];
    const dispatch = vi.fn((events: BrowserHumanInputEvent[]) => {
      dispatched.push(events);
      if (events === down) {
        return new Promise<void>((resolve) => {
          acknowledgeDown = resolve;
        });
      }
      return Promise.resolve();
    });
    const queue = new BrowserInputQueue(dispatch);
    const firstMove: BrowserHumanInputEvent[] = [
      { button: "left", phase: "move", type: "pointer", x: 0.6, y: 0.6 },
    ];
    const latestMove: BrowserHumanInputEvent[] = [
      { button: "left", phase: "move", type: "pointer", x: 0.7, y: 0.7 },
    ];

    const promises = [
      queue.enqueue(down),
      queue.enqueue(firstMove),
      queue.enqueue(latestMove),
      queue.enqueue(up),
    ];
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    acknowledgeDown?.();
    await Promise.all(promises);

    expect(dispatched).toEqual([down, latestMove, up]);
  });

  it("continues dispatching after a failed input", async () => {
    const failure = new Error("runtime unavailable");
    const dispatch = vi
      .fn<(events: BrowserHumanInputEvent[]) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce();
    const queue = new BrowserInputQueue(dispatch);

    const first = queue.enqueue(down);
    const second = queue.enqueue(up);

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBeUndefined();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
