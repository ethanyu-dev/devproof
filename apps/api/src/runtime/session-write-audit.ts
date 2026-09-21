import type { BrowserRuntimeSession, Prisma } from "@prisma/client";

const SAFE_OBSERVATION_COMMANDS = [
  "page.snapshot",
  "page.get_text",
  "page.get_url",
  "page.get_title",
  "page.errors",
  "page.screenshot",
  "page.dom",
  "page.console",
  "page.network",
  "tab.list",
  "frame.snapshot",
  "element.state",
  "locator.count",
  "network.status",
];

/** All sources matter: a Console operation or human takeover can also write. */
export const potentialWriteCommandWhere: Prisma.BrowserRuntimeCommandWhereInput =
  {
    commandType: { notIn: [...SAFE_OBSERVATION_COMMANDS, "session.close"] },
    NOT: {
      AND: [
        { commandType: "session.open" },
        { source: "SYSTEM" },
        {
          session: {
            protocolMinor: { gte: 13 },
            purpose: "EXECUTION",
            // Only an admitted execution opens under a network-disabled STARTUP permit.
            browserExecutions: { some: {} },
          },
        },
      ],
    },
  };

/** Only a fenced, audited new launch can make command absence meaningful.
 * Navigation remains a potential write: page scripts may submit requests.
 * Call under the resource lock after command admission has been stopped.
 */
export async function hasVerifiedObservationOnlyHistory(
  tx: Prisma.TransactionClient,
  session: BrowserRuntimeSession,
) {
  const identity = session.launchIdentity as {
    id?: unknown;
    version?: unknown;
  } | null;
  if (
    session.purpose !== "EXECUTION" ||
    session.protocolMinor < 14 ||
    !session.ownerTaskId ||
    session.ownerFencingToken === null ||
    session.launchIdentityVersion !== 1 ||
    identity?.version !== 1 ||
    typeof identity.id !== "string" ||
    !identity.id ||
    !session.launchHostInstanceId ||
    session.launchConnectionGeneration == null ||
    session.controlGeneration !== 0 ||
    (!session.quarantinedAt && !session.closureVerifiedAt)
  )
    return false;

  const execution = await tx.browserExecution.findFirst({
    where: {
      runtimeSessionId: session.id,
      attempt: { task: { id: session.ownerTaskId } },
    },
    select: { id: true },
  });
  if (!execution) return false;
  const launch = await tx.browserRuntimeCommand.findFirst({
    where: {
      sessionId: session.id,
      commandType: "session.open",
      source: "SYSTEM",
      status: "SUCCEEDED",
      leaseToken: session.leaseToken,
      fencingToken: session.fencingToken,
      payload: { path: ["launchIdentityId"], equals: identity.id },
      result: { path: ["url"], equals: "about:blank" },
    },
    select: { id: true },
  });
  if (!launch) return false;
  // Include pending/failed commands and every actor and epoch. A submitted
  // write is uncertain even when its result or dispatch acknowledgement is lost.
  return (
    (await tx.browserRuntimeCommand.count({
      where: { sessionId: session.id, ...potentialWriteCommandWhere },
    })) === 0
  );
}

/** Runtime 1.21 reports all context HTTP requests from blank launch until close.
 * Unknown channels, persistent pages and human control cannot attest no writes.
 * Verification verdicts and the model's textual cleanup claims are not evidence.
 */
export async function hasVerifiedNoWriteNetworkAudit(
  tx: Prisma.TransactionClient,
  session: BrowserRuntimeSession,
) {
  const identity = session.launchIdentity as { id?: string } | null;
  if (
    session.protocolMinor < 21 ||
    session.purpose !== "EXECUTION" ||
    session.status !== "CLOSED" ||
    !session.closureVerifiedAt ||
    !session.closureEvidenceId ||
    session.controlGeneration !== 0 ||
    !session.ownerTaskId ||
    session.ownerFencingToken === null ||
    session.launchIdentityVersion !== 1 ||
    !identity?.id
  )
    return false;
  const close = await tx.browserRuntimeCommand.findFirst({
    where: {
      sessionId: session.id,
      commandType: "session.close",
      status: "SUCCEEDED",
      leaseToken: session.leaseToken,
      fencingToken: session.fencingToken,
    },
    orderBy: { createdAt: "desc" },
    select: { result: true },
  });
  const result = close?.result as {
    closed?: boolean;
    writeAudit?: {
      version?: number;
      launchIdentityId?: string;
      coverage?: string;
      complete?: boolean;
      requestCount?: number;
      potentialWrites?: number;
    };
  } | null;
  const audit = result?.writeAudit;
  if (
    result?.closed !== true ||
    audit?.version !== 1 ||
    !audit.complete ||
    audit.launchIdentityId !== identity.id ||
    audit.coverage !== "ISOLATED_CONTEXT_UNTIL_CLOSE" ||
    audit.potentialWrites !== 0 ||
    !Number.isSafeInteger(audit.requestCount) ||
    audit.requestCount! < 0
  )
    return false;
  // Out-of-band HTTP/API commands and any different owner/epoch are outside this proof.
  return (
    (await tx.browserRuntimeCommand.count({
      where: {
        sessionId: session.id,
        OR: [
          { leaseToken: { not: session.leaseToken } },
          { fencingToken: { not: session.fencingToken } },
          {
            commandType: {
              notIn: [
                ...SAFE_OBSERVATION_COMMANDS,
                "session.open",
                "session.close",
                "page.navigate",
                "page.click",
                "page.fill",
                "page.scroll",
                "page.wait",
                "page.press",
                "page.select",
                "page.check",
                "page.uncheck",
              ],
            },
          },
          { status: { in: ["PENDING", "DISPATCHED"] } },
        ],
      },
    })) === 0
  );
}
