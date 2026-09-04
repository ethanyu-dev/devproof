import type { RuntimeSessionPermit } from "@devproof/runtime-protocol";

type SessionIdentity = {
  sessionId: string;
  leaseToken: string;
  fencingToken: string;
};
type RegisteredPermit = { value: RuntimeSessionPermit; deadline: number };

function denied(message: string) {
  return Object.assign(new Error(message), {
    code: "SESSION_PERMIT_EXPIRED",
    retryable: false,
  });
}

export class SessionPermits {
  private readonly permits = new Map<string, RegisteredPermit>();
  private readonly revoked = new Set<string>();
  private readonly executorEpochs = new Map<
    string,
    { taskId: string; token: bigint }
  >();
  private connected = true;
  private serverClock: { timestamp: number; monotonicAt: number };

  constructor(
    private readonly monotonicNow = () => performance.now(),
    private readonly wallNow = () => Date.now(),
  ) {
    this.serverClock = {
      timestamp: this.wallNow(),
      monotonicAt: this.monotonicNow(),
    };
  }

  synchronizeClock(serverTime: string, roundTripMs = 0) {
    const server = Date.parse(serverTime);
    if (Number.isFinite(server))
      this.serverClock = {
        timestamp: server + Math.max(0, roundTripMs),
        monotonicAt: this.monotonicNow(),
      };
  }

  setConnected(connected: boolean) {
    this.connected = connected;
  }
  isRevoked(sessionId: string) {
    return this.revoked.has(sessionId);
  }

  revoke(sessionId: string) {
    this.revoked.add(sessionId);
    this.permits.delete(sessionId);
  }

  get(sessionId: string) {
    return this.permits.get(sessionId)?.value;
  }

  accept(
    identity: SessionIdentity,
    permit: RuntimeSessionPermit,
    serverTime?: string,
    roundTripMs = 0,
  ) {
    if (this.revoked.has(identity.sessionId))
      throw denied("An expired or closed session cannot be revived.");
    if (
      identity.sessionId !== permit.sessionId ||
      identity.fencingToken !== permit.fencingToken ||
      identity.leaseToken !== permit.leaseToken
    ) {
      throw denied("The session permit belongs to another browser lease.");
    }
    const executor = this.executorEpochs.get(identity.sessionId);
    if (
      executor &&
      permit.ownerTaskId &&
      permit.ownerFencingToken &&
      (executor.taskId !== permit.ownerTaskId ||
        BigInt(permit.ownerFencingToken) < executor.token)
    ) {
      throw denied("The execution permit belongs to a stale owner.");
    }
    const existing = this.permits.get(identity.sessionId);
    if (existing && existing.deadline <= this.monotonicNow()) {
      this.revoke(identity.sessionId);
      throw denied(
        "The previous session permit expired before renewal arrived.",
      );
    }
    const controlGeneration = permit.controlGeneration ?? 0;
    const previousControlGeneration = existing?.value.controlGeneration ?? 0;
    if (existing && controlGeneration < previousControlGeneration)
      throw denied(
        "The execution permit belongs to a stale control generation.",
      );
    if (
      existing?.value.ownerKind === "HUMAN" &&
      permit.ownerKind === "AGENT" &&
      executor &&
      BigInt(permit.ownerFencingToken!) <= executor.token &&
      controlGeneration <= previousControlGeneration
    )
      throw denied(
        "Resuming after human control requires a new executor epoch.",
      );
    if (
      existing?.value.ownerKind === "AGENT" &&
      permit.ownerKind === "STARTUP"
    ) {
      throw denied("An execution permit cannot be downgraded to startup.");
    }
    if (
      existing?.value.ownerFencingToken &&
      permit.ownerFencingToken &&
      (existing.value.ownerTaskId !== permit.ownerTaskId ||
        BigInt(permit.ownerFencingToken) <
          BigInt(existing.value.ownerFencingToken))
    ) {
      throw denied("The execution permit belongs to a stale owner.");
    }
    const sameOwner =
      existing &&
      existing.value.ownerKind === permit.ownerKind &&
      existing.value.ownerTaskId === permit.ownerTaskId &&
      existing.value.ownerFencingToken === permit.ownerFencingToken &&
      previousControlGeneration === controlGeneration;
    // Ignore stale snapshots of an authority we have already renewed. Expiry
    // of the incoming snapshot is not expiry of the current registered lease.
    if (
      sameOwner &&
      Date.parse(permit.expiresAt) <= Date.parse(existing.value.expiresAt)
    )
      return false;
    const remaining =
      Date.parse(permit.expiresAt) -
      (serverTime
        ? Date.parse(serverTime) + Math.max(0, roundTripMs)
        : this.serverClock.timestamp +
          this.monotonicNow() -
          this.serverClock.monotonicAt);
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.revoke(identity.sessionId);
      throw denied("The execution permit has expired.");
    }
    if (permit.ownerTaskId && permit.ownerFencingToken)
      this.executorEpochs.set(identity.sessionId, {
        taskId: permit.ownerTaskId,
        token: BigInt(permit.ownerFencingToken),
      });
    this.permits.set(identity.sessionId, {
      value: permit,
      deadline: this.monotonicNow() + remaining,
    });
    return true;
  }

  assert(
    identity: SessionIdentity,
    owner?: {
      ownerKind?: RuntimeSessionPermit["ownerKind"] | undefined;
      ownerTaskId?: string | undefined;
      ownerFencingToken?: string | undefined;
      controlGeneration?: number | undefined;
    },
    allowStartup = false,
  ) {
    const registered = this.permits.get(identity.sessionId);
    if (this.revoked.has(identity.sessionId) || !registered)
      throw denied("The session has no active execution permit.");
    if (registered.deadline <= this.monotonicNow()) {
      this.revoke(identity.sessionId);
      throw denied("The session execution permit expired.");
    }
    if (!this.connected)
      throw denied("The Runtime is disconnected from its control plane.");
    const permit = registered.value;
    if (
      owner &&
      (owner.controlGeneration ?? 0) !== (permit.controlGeneration ?? 0)
    )
      throw denied("The command belongs to a stale control generation.");
    if (
      permit.leaseToken !== identity.leaseToken ||
      permit.fencingToken !== identity.fencingToken
    )
      throw denied("The command owns a stale browser session.");
    if (permit.ownerKind === "STARTUP" && !allowStartup)
      throw denied("The session is waiting for an execution owner.");
    if (
      ["HUMAN", "SYSTEM"].includes(permit.ownerKind) &&
      (owner?.ownerKind === "AGENT" ||
        (!owner?.ownerKind && (owner?.ownerTaskId || owner?.ownerFencingToken)))
    )
      throw denied("The command owns a stale executor lease.");
    if (
      permit.ownerKind === "AGENT" &&
      owner &&
      (owner.ownerTaskId !== permit.ownerTaskId ||
        owner.ownerFencingToken !== permit.ownerFencingToken)
    ) {
      throw denied("The command owns a stale executor lease.");
    }
    return permit;
  }

  networkAllowed(identity: SessionIdentity) {
    try {
      this.assert(identity);
      return true;
    } catch {
      return false;
    }
  }

  expired() {
    return [...this.permits]
      .filter(([, permit]) => permit.deadline <= this.monotonicNow())
      .map(([id]) => id);
  }
}
