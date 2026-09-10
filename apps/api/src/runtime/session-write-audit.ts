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
