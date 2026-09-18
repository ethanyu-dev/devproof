import type { Prisma } from "@prisma/client";
import {
  executionResourceClaims,
  resourcesConflict,
} from "./execution-concurrency.js";
/** Caller holds browser-execution-resources advisory lock. Old leases remain
 * attached until verified closure, including cleanup debts for a replaced account. */
export async function coordinateResumedAccounts(
  tx: Prisma.TransactionClient,
  input: {
    sessionId: string;
    targetUrl?: string | undefined;
    concurrencyPolicy: unknown;
    executionPolicy: Record<string, unknown>;
  },
) {
  const claims = executionResourceClaims(
    input.targetUrl,
    input.concurrencyPolicy,
    input.executionPolicy,
  );
  if (!claims.length) return null;
  const leases = await tx.executionResourceLease.findMany({
    where: { rootKey: { in: [...new Set(claims.map((c) => c.rootKey)), "*"] } },
  });
  const conflict = leases.find(
    (l) =>
      l.sessionId !== input.sessionId &&
      claims.some((c) =>
        resourcesConflict(c, {
          ...l,
          mode: l.mode === "READ" ? "READ" : "WRITE",
        }),
      ),
  );
  if (conflict) return { sessionId: conflict.sessionId };
  for (const claim of claims)
    await tx.executionResourceLease.upsert({
      where: {
        sessionId_resourceKey: {
          sessionId: input.sessionId,
          resourceKey: claim.resourceKey,
        },
      },
      create: { ...claim, sessionId: input.sessionId },
      update: {
        mode: leases.some(
          (l) =>
            l.sessionId === input.sessionId &&
            l.resourceKey === claim.resourceKey &&
            l.mode === "WRITE",
        )
          ? "WRITE"
          : claim.mode,
      },
    });
  return null;
}
