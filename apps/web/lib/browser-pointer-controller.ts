import type { BrowserHumanInputEvent } from "@devproof/runtime-protocol";

type PointerInput = Extract<BrowserHumanInputEvent, { type: "pointer" }>;

interface ActivePointer {
  down: PointerInput;
  downSent: boolean;
  pointerId: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface BrowserFrameSize {
  height: number;
  width: number;
}

interface BrowserViewportBounds {
  height: number;
  left: number;
  top: number;
  width: number;
}

const HOLD_DELAY_MS = 120;

export class BrowserPointerController {
  private active: ActivePointer | undefined;

  constructor(
    private readonly send: (events: BrowserHumanInputEvent[]) => Promise<void>,
  ) {}

  down(pointerId: number, event: PointerInput) {
    if (this.active) this.cancel();
    const active: ActivePointer = {
      down: event,
      downSent: false,
      pointerId,
      timer: undefined,
    };
    active.timer = setTimeout(() => this.flushDown(active), HOLD_DELAY_MS);
    this.active = active;
  }

  move(pointerId: number, event: PointerInput) {
    const active = this.active;
    if (!active || active.pointerId !== pointerId) return;
    this.flushDown(active);
    void this.send([event]);
  }

  up(pointerId: number, event: PointerInput) {
    const active = this.active;
    if (!active || active.pointerId !== pointerId) {
      void this.send([{ type: "release" }]);
      return;
    }
    this.clearTimer(active);
    this.active = undefined;
    if (active.downSent) {
      void this.send([event]);
      return;
    }
    void this.send([active.down, event]);
  }

  cancel() {
    if (this.active) this.clearTimer(this.active);
    this.active = undefined;
    void this.send([{ type: "release" }]);
  }

  private flushDown(active: ActivePointer) {
    if (this.active !== active || active.downSent) return;
    this.clearTimer(active);
    active.downSent = true;
    void this.send([active.down]);
  }

  private clearTimer(active: ActivePointer) {
    if (active.timer === undefined) return;
    clearTimeout(active.timer);
    active.timer = undefined;
  }
}

export function normalizedBrowserPoint(
  clientX: number,
  clientY: number,
  bounds: BrowserViewportBounds | null,
  frame: BrowserFrameSize | null,
) {
  if (
    !bounds ||
    !frame ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    frame.width <= 0 ||
    frame.height <= 0
  )
    return null;
  const scale = Math.min(
    bounds.width / frame.width,
    bounds.height / frame.height,
  );
  const width = frame.width * scale;
  const height = frame.height * scale;
  const left = bounds.left + (bounds.width - width) / 2;
  const top = bounds.top + (bounds.height - height) / 2;
  const x = (clientX - left) / width;
  const y = (clientY - top) / height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}
