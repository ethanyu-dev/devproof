import type { Prisma } from "@prisma/client";
import type { RuntimeRecoveryQuery } from "@devproof/contracts";

/** Apply the same pending definition before both pagination and counting. */
export function recoveryListWhere(
  teamId: string,
  query: RuntimeRecoveryQuery,
): Prisma.RuntimeSessionRecoveryWhereInput {
  return {
    teamId,
    ...(query.runtimeId ? { runtimeId: query.runtimeId } : {}),
    ...(query.state ? { closureState: query.state } : {}),
    ...(query.writeState ? { writeOutcomeState: query.writeState } : {}),
    ...(query.view === "pending"
      ? {
          resolvedAt: null,
          AND: [{ closureState: { not: "OBSERVED" } }],
        }
      : {}),
  };
}
