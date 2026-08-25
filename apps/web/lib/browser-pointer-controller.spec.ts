import type { BrowserHumanInputEvent } from "@devproof/runtime-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserPointerController,
  normalizedBrowserPoint,
} from "./browser-pointer-controller";

const down = {
  button: "left",
  phase: "down",
  type: "pointer",
  x: 0.5,
  y: 0.5,
} as const;
const up = { ...down, phase: "up" } as const;

afterEach(() => vi.useRealTimers());

describe("BrowserPointerController", () => {
  it("sends a quick click as one atomic input batch", () => {
    vi.useFakeTimers();
    const send = vi
      .fn<(events: BrowserHumanInputEvent[]) => Promise<void>>()
      .mockResolvedValue();
    const pointer = new BrowserPointerController(send);

    pointer.down(1, down);
    pointer.up(1, up);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith([down, up]);
  });

  it("flushes pointer down before a drag and preserves move/up order", () => {
    vi.useFakeTimers();
    const send = vi
      .fn<(events: BrowserHumanInputEvent[]) => Promise<void>>()
      .mockResolvedValue();
    const pointer = new BrowserPointerController(send);
    const move = { ...down, phase: "move", x: 0.7 } as const;

    pointer.down(1, down);
    pointer.move(1, move);
    pointer.up(1, up);

    expect(send.mock.calls.map(([events]) => events)).toEqual([
      [down],
      [move],
      [up],
    ]);
  });

  it("sends pointer down after the hold delay", () => {
    vi.useFakeTimers();
    const send = vi
      .fn<(events: BrowserHumanInputEvent[]) => Promise<void>>()
      .mockResolvedValue();
    const pointer = new BrowserPointerController(send);

    pointer.down(1, down);
    vi.advanceTimersByTime(119);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(send).toHaveBeenCalledWith([down]);
  });

  it("releases remote input when the gesture cannot be completed", () => {
    const send = vi
      .fn<(events: BrowserHumanInputEvent[]) => Promise<void>>()
      .mockResolvedValue();
    const pointer = new BrowserPointerController(send);

    pointer.up(1, up);

    expect(send).toHaveBeenCalledWith([{ type: "release" }]);
  });
});

describe("normalizedBrowserPoint", () => {
  it("maps against frame metadata and excludes letterbox bars", () => {
    const bounds = { height: 800, left: 100, top: 50, width: 800 };
    const frame = { height: 720, width: 1280 };

    expect(normalizedBrowserPoint(500, 450, bounds, frame)).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(normalizedBrowserPoint(500, 100, bounds, frame)).toBeNull();
  });
});
