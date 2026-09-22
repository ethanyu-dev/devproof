import type { BrowserRuntimeSession, Prisma } from "@prisma/client";
import { env } from "../config/env.js";

/** Called after a successful open, inside the browser resource transaction lock. */
export async function activateOpenedSession(
  tx: Prisma.TransactionClient,
  session: Pick<
    BrowserRuntimeSession,
    "id" | "leaseToken" | "fencingToken" | "profileMode"
  >,
  now: Date,
) {
  // Chromium startup consumes the initial lease. Its live acknowledgment grants
  // a full handoff window so the first agent command can reach the next heartbeat.
  const expiresAt = new Date(
    now.getTime() + env().RUNTIME_LEASE_SECONDS * 1000,
  );
  const identity = {
    leaseToken: session.leaseToken,
    fencingToken: session.fencingToken,
  };
  const activated = await tx.browserRuntimeSession.updateMany({
    where: {
      id: session.id,
      ...identity,
      status: "OPENING",
      quarantinedAt: null,
      closureVerifiedAt: null,
      leaseExpiresAt: { gt: now },
    },
    data: {
      openedAt: now,
      status: "ACTIVE",
      leaseExpiresAt: expiresAt,
      executionPermitExpiresAt: expiresAt,
    },
  });
  if (activated.count !== 1) return null;
  const where = { sessionId: session.id, ...identity, expiresAt: { gt: now } };
  const slot = await tx.browserRuntimeSlot.updateMany({
    where,
    data: { expiresAt },
  });
  if (slot.count !== 1)
    throw new Error("Browser slot ownership changed before activation.");
  if (session.profileMode === "PERSISTENT") {
    const profile = await tx.browserRuntimeProfileLease.updateMany({
      where,
      data: { expiresAt },
    });
    if (profile.count !== 1)
      throw new Error("Browser profile ownership changed before activation.");
  }
  return expiresAt;
}
