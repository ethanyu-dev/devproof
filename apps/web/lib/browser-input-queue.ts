import type { BrowserHumanInputEvent } from "@devproof/runtime-protocol";

interface PendingInput {
  events: BrowserHumanInputEvent[];
  reject: Array<(reason?: unknown) => void>;
  resolve: Array<() => void>;
}

export class BrowserInputQueue {
  private draining = false;
  private readonly pending: PendingInput[] = [];

  constructor(
    private readonly dispatch: (
      events: BrowserHumanInputEvent[],
    ) => Promise<void>,
  ) {}

  enqueue(events: BrowserHumanInputEvent[]) {
    return new Promise<void>((resolve, reject) => {
      const last = this.pending.at(-1);
      if (last && canReplacePointerMove(last.events, events)) {
        last.events = events;
        last.resolve.push(resolve);
        last.reject.push(reject);
      } else {
        this.pending.push({ events, reject: [reject], resolve: [resolve] });
      }
      void this.drain();
    });
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const input = this.pending.shift();
        if (!input) continue;
        try {
          await this.dispatch(input.events);
          for (const resolve of input.resolve) resolve();
        } catch (error) {
          for (const reject of input.reject) reject(error);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

function canReplacePointerMove(
  previous: BrowserHumanInputEvent[],
  next: BrowserHumanInputEvent[],
) {
  return isSinglePointerMove(previous) && isSinglePointerMove(next);
}

function isSinglePointerMove(events: BrowserHumanInputEvent[]) {
  const event = events[0];
  return (
    events.length === 1 && event?.type === "pointer" && event.phase === "move"
  );
}
