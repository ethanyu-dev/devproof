/** Owns renewal and a conservative local execution deadline, never task retries. */
export class LeaseLostError extends Error {
  readonly code = "RUNTIME_LEASE_LOST";
  constructor(message = "The confirmed Runtime lease is no longer usable.") {
    super(message);
    this.name = "LeaseLostError";
  }
}

export interface LeaseRenewal {
  directive: "CONTINUE" | "CANCEL";
  leaseExpiresAt: string;
  serverTime?: string | undefined;
  leaseDurationMs?: number | undefined;
}

export class LeaseSupervisor<T extends LeaseRenewal> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: AbortController | undefined;
  private stopped = false;
  private failures = 0;
  private safeUntil = 0;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly safetyMs: number;
  private readonly clock: () => number;
  private readonly abortFromExecution = () => this.stop();

  constructor(
    private readonly options: {
      initialLease: Pick<
        LeaseRenewal,
        "leaseExpiresAt" | "serverTime" | "leaseDurationMs"
      >;
      controller: AbortController;
      renew(signal: AbortSignal): Promise<T>;
      onRenewed(response: T): void;
      terminal(error: unknown): boolean;
      onDiagnostic?(event: string, details: Record<string, unknown>): void;
      intervalMs?: number;
      timeoutMs?: number;
      safetyMs?: number;
      clock?: () => number;
      random?: () => number;
    },
  ) {
    this.intervalMs = options.intervalMs ?? 15_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.safetyMs = options.safetyMs ?? 10_000;
    this.clock = options.clock ?? (() => performance.now());
    options.controller.signal.addEventListener(
      "abort",
      this.abortFromExecution,
      { once: true },
    );
    if (options.controller.signal.aborted) {
      this.stop();
      return;
    }
    this.confirm(options.initialLease);
    if (!options.controller.signal.aborted) this.schedule(this.intervalMs);
  }

  stop() {
    this.stopped = true;
    this.options.controller.signal.removeEventListener(
      "abort",
      this.abortFromExecution,
    );
    if (this.timer) clearTimeout(this.timer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.inFlight?.abort(new Error("Lease renewal stopped."));
  }

  private confirm(
    lease: Pick<
      LeaseRenewal,
      "leaseExpiresAt" | "serverTime" | "leaseDurationMs"
    >,
  ) {
    // New control planes supply server-relative duration adjusted by RPC elapsed time.
    // The capped fallback only supports rolling upgrades to an older control plane.
    const duration =
      lease.leaseDurationMs ??
      (lease.serverTime
        ? Date.parse(lease.leaseExpiresAt) - Date.parse(lease.serverTime)
        : Math.min(60_000, Date.parse(lease.leaseExpiresAt) - Date.now()));
    this.safeUntil = this.clock() + Math.max(0, duration - this.safetyMs);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (!Number.isFinite(duration) || duration <= this.safetyMs) {
      this.lose(new LeaseLostError());
      return;
    }
    this.expiryTimer = setTimeout(
      () => this.lose(new LeaseLostError()),
      duration - this.safetyMs,
    );
    this.expiryTimer.unref?.();
  }

  private schedule(delayMs: number) {
    if (this.stopped || this.options.controller.signal.aborted) return;
    this.timer = setTimeout(
      () => void this.tick(),
      Math.min(delayMs, Math.max(0, this.safeUntil - this.clock())),
    );
    this.timer.unref?.();
  }

  private lose(error: unknown) {
    if (this.stopped) return;
    this.options.onDiagnostic?.("runtime.lease.lost", {
      failures: this.failures,
    });
    this.options.controller.abort(error);
    this.stop();
  }

  private async tick() {
    if (this.stopped || this.options.controller.signal.aborted) return;
    const remainingMs = this.safeUntil - this.clock();
    if (remainingMs <= 0) return this.lose(new LeaseLostError());
    const request = new AbortController();
    this.inFlight = request;
    const started = this.clock();
    const timeout = setTimeout(
      () => request.abort(new Error("Lease heartbeat request timed out.")),
      Math.min(this.timeoutMs, remainingMs),
    );
    timeout.unref?.();
    let retryDelay = this.intervalMs;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        );
      });
      const response = await Promise.race([
        this.options.renew(request.signal),
        aborted,
      ]);
      if (this.stopped) return;
      if (response.directive === "CANCEL") {
        return this.lose(new LeaseLostError("Run cancellation requested."));
      }
      this.failures = 0;
      this.confirm(response);
      if (this.stopped) return;
      this.options.onRenewed(response);
      this.options.onDiagnostic?.("runtime.lease.renewed", {
        latencyMs: this.clock() - started,
        remainingMs: this.safeUntil - this.clock(),
      });
    } catch (error) {
      if (this.stopped) return;
      this.failures += 1;
      this.options.onDiagnostic?.("runtime.lease.renewal_failed", {
        failures: this.failures,
        latencyMs: this.clock() - started,
        terminal: this.options.terminal(error),
      });
      if (this.options.terminal(error)) return this.lose(new LeaseLostError());
      retryDelay =
        Math.min(4_000, 1_000 * 2 ** Math.min(2, this.failures - 1)) *
        (0.8 + (this.options.random ?? Math.random)() * 0.4);
    } finally {
      clearTimeout(timeout);
      this.inFlight = undefined;
    }
    this.schedule(retryDelay);
  }
}
