import { afterEach, describe, expect, it, vi } from "vitest";
import { LeaseLostError, LeaseSupervisor } from "./lease-supervisor.js";

afterEach(() => vi.useRealTimers());

function setup(
  renew: (signal: AbortSignal) => Promise<{
    directive: "CONTINUE";
    leaseExpiresAt: string;
    leaseDurationMs: number;
  }>,
) {
  const controller = new AbortController();
  const onRenewed = vi.fn();
  const supervisor = new LeaseSupervisor({
    initialLease: {
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      leaseDurationMs: 60_000,
    },
    controller,
    renew,
    onRenewed,
    terminal: (error) => (error as { status?: number }).status === 409,
    clock: () => Date.now(),
    random: () => 0.5,
  });
  return { controller, onRenewed, supervisor };
}

const renewed = () => ({
  directive: "CONTINUE" as const,
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  leaseDurationMs: 60_000,
});

describe("confirmed lease supervisor", () => {
  it("retries one transient failure inside the confirmed lease without cancelling execution", async () => {
    vi.useFakeTimers();
    const renew = vi
      .fn()
      .mockRejectedValueOnce(new Error("network disconnected"))
      .mockImplementation(async () => renewed());
    const state = setup(renew);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(state.onRenewed).toHaveBeenCalledOnce();
    expect(state.controller.signal.aborted).toBe(false);
    state.supervisor.stop();
  });

  it("aborts a slow heartbeat before retrying and never overlaps live requests", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let peak = 0;
    const renew = vi.fn(
      (signal: AbortSignal) =>
        new Promise<ReturnType<typeof renewed>>((_resolve, reject) => {
          peak = Math.max(peak, ++inFlight);
          signal.addEventListener(
            "abort",
            () => {
              inFlight -= 1;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const state = setup(renew);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(peak).toBe(1);
    expect(renew.mock.calls.length).toBeGreaterThan(1);
    state.supervisor.stop();
    expect(inFlight).toBe(0);
  });

  it("stops before confirmed expiry and ignores late renewal results", async () => {
    vi.useFakeTimers();
    let resolve: ((value: ReturnType<typeof renewed>) => void) | undefined;
    const state = setup(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await vi.advanceTimersByTimeAsync(50_000);
    expect(state.controller.signal.reason).toBeInstanceOf(LeaseLostError);
    resolve?.(renewed());
    await Promise.resolve();
    expect(state.onRenewed).not.toHaveBeenCalled();
    expect(state.controller.signal.aborted).toBe(true);
  });

  it("immediately stops on a definitive stale-owner response", async () => {
    vi.useFakeTimers();
    const state = setup(async () => {
      throw Object.assign(new Error("stale"), { status: 409 });
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.controller.signal.reason).toBeInstanceOf(LeaseLostError);
  });
});
