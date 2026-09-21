/** Cumulative metadata only; never retain request URLs, bodies or credentials. */
export class SessionWriteAudit {
  private requestCount = 0;
  private potentialWrites = 0;
  private complete: boolean;
  constructor(freshIsolatedLaunch: boolean) {
    this.complete = freshIsolatedLaunch;
  }
  request(method: string) {
    this.requestCount++;
    if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()))
      this.potentialWrites++;
  }
  invalidate() {
    this.complete = false;
  }
  closed(launchIdentityId: string | undefined) {
    return {
      version: 1 as const,
      launchIdentityId,
      coverage: "ISOLATED_CONTEXT_UNTIL_CLOSE" as const,
      complete: this.complete && Boolean(launchIdentityId),
      requestCount: this.requestCount,
      potentialWrites: this.potentialWrites,
    };
  }
}

export type ClosedSessionWriteAudit = ReturnType<SessionWriteAudit["closed"]>;
