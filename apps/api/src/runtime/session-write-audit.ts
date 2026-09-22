import type { BrowserRuntimeSession, Prisma } from "@prisma/client";
import { z } from "zod";

export const closedSessionWriteAuditSchema = z.object({
  version: z.literal(1),
  launchIdentityId: z.string().min(1),
  coverage: z.literal("ISOLATED_CONTEXT_UNTIL_CLOSE"),
  complete: z.boolean(),
  requestCount: z.number().int().nonnegative(),
  potentialWrites: z.number().int().nonnegative(),
});

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

/** An unclaimed execution starts offline. A lost open acknowledgement cannot
 * turn that isolated startup into an unknown business write after proven closure.
 * The recovery keeps the run binding when startup retry detaches the session.
 */
export async function hasVerifiedOfflineStartup(
  tx: Prisma.TransactionClient,
  session: BrowserRuntimeSession,
  sourceRunId: string | null,
) {
  const identity = session.launchIdentity as {
    version?: number;
    id?: string;
  } | null;
  if (
    !sourceRunId ||
    session.purpose !== "EXECUTION" ||
    session.protocolMinor < 14 ||
    session.profileMode !== "EPHEMERAL" ||
    session.ownerTaskId !== null ||
    session.ownerFencingToken !== null ||
    session.openedAt !== null ||
    session.controlGeneration !== 0 ||
    session.status !== "CLOSED" ||
    !session.closureVerifiedAt ||
    !session.closureEvidenceId ||
    session.launchIdentityVersion !== 1 ||
    identity?.version !== 1 ||
    !identity.id ||
    !session.launchHostInstanceId ||
    session.launchConnectionGeneration == null
  )
    return false;
  const execution = await tx.browserExecution.findFirst({
    where: { runId: sourceRunId, createdAt: { lte: session.createdAt } },
    select: { id: true },
  });
  if (!execution) return false;
  const launch = await tx.browserRuntimeCommand.findFirst({
    where: {
      sessionId: session.id,
      commandType: "session.open",
      source: "SYSTEM",
      leaseToken: session.leaseToken,
      fencingToken: session.fencingToken,
      AND: [
        { payload: { path: ["launchIdentityId"], equals: identity.id } },
        { payload: { path: ["profileMode"], equals: "EPHEMERAL" } },
        { payload: { path: ["allowedOrigins"], equals: [] } },
      ],
    },
    select: { id: true },
  });
  if (!launch) return false;
  return (
    (await tx.browserRuntimeCommand.count({
      where: {
        sessionId: session.id,
        OR: [
          { commandType: { notIn: ["session.open", "session.close"] } },
          { source: { not: "SYSTEM" } },
          { leaseToken: { not: session.leaseToken } },
          { fencingToken: { not: session.fencingToken } },
          { ownerTaskId: { not: null } },
          { ownerFencingToken: { not: null } },
          { status: { in: ["PENDING", "DISPATCHED"] } },
        ],
      },
    })) === 0
  );
}

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
 * The context observer stays attached during human takeover and release.
 * Unknown channels and persistent pages cannot attest no writes.
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
  // Closure evidence is durable even when the close RPC timed out. Prefer its
  // independently authenticated audit; retain successful-command compatibility.
  const proof = await tx.sessionClosureEvidence.findFirst({
    where: {
      id: session.closureEvidenceId,
      sessionId: session.id,
      sessionFence: session.fencingToken,
      method: "LIVE_SESSION_TERMINATED",
    },
    select: { summary: true },
  });
  const summary = proof?.summary as { writeAudit?: unknown } | null;
  const parsed = closedSessionWriteAuditSchema.safeParse(
    summary?.writeAudit ?? result?.writeAudit,
  );
  const audit = parsed.success ? parsed.data : undefined;
  if (
    (!summary?.writeAudit && result?.closed !== true) ||
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
                "human.takeover",
                "human.release",
                "page.navigate",
                "page.reload",
                "page.resize",
                "page.click",
                "page.fill",
                "page.type",
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
