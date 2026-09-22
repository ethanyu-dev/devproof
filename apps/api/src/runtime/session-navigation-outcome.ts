import type { BrowserRuntimeSession, Prisma } from "@prisma/client";

/** A startup load-event timeout can be superseded by the very next verified
 * observation of the requested page. This is not proof of business writes:
 * callers must also require the matching owner's conclusive final outcome.
 */
export async function hasObservedInitialNavigation(
  tx: Prisma.TransactionClient,
  session: BrowserRuntimeSession,
) {
  if (!(session.protocolMinor >= 14) || session.controlGeneration !== 0)
    return false;
  const commands = await tx.browserRuntimeCommand.findMany({
    where: { sessionId: session.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 3,
  });
  const [open, navigation, observation] = commands;
  if (!open || !navigation || !observation) return false;
  if (
    commands.some(
      (c) =>
        c.leaseToken !== session.leaseToken ||
        c.fencingToken !== session.fencingToken,
    )
  )
    return false;
  const opened = open.result as { url?: string } | null;
  const payload = navigation.payload as { url?: string } | null;
  const observed = observation.result as {
    url?: string;
    structuredObservation?: { consistency?: string; pageIdentity?: string };
  } | null;
  return (
    open.commandType === "session.open" &&
    open.source === "SYSTEM" &&
    open.status === "SUCCEEDED" &&
    opened?.url === "about:blank" &&
    navigation.commandType === "page.navigate" &&
    navigation.status === "TIMED_OUT" &&
    navigation.source === "AGENT" &&
    observation.source === "AGENT" &&
    navigation.ownerTaskId === session.ownerTaskId &&
    observation.ownerTaskId === session.ownerTaskId &&
    navigation.ownerFencingToken === session.ownerFencingToken &&
    observation.ownerFencingToken === session.ownerFencingToken &&
    observation.commandType === "page.snapshot" &&
    observation.status === "SUCCEEDED" &&
    observation.createdAt >= navigation.deadlineAt &&
    Boolean(
      navigation.completedAt && observation.createdAt >= navigation.completedAt,
    ) &&
    typeof payload?.url === "string" &&
    /^https?:\/\//u.test(payload.url) &&
    observed?.url === payload.url &&
    observed.structuredObservation?.consistency === "VERIFIED" &&
    observed.structuredObservation.pageIdentity === payload.url
  );
}
