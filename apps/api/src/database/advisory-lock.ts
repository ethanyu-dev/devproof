import { Prisma } from "@prisma/client";

type AdvisoryLockClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Acquire a transaction-scoped PostgreSQL advisory lock for a stable text key.
 *
 * PostgreSQL returns `void` from pg_advisory_xact_lock. Prisma cannot decode
 * that type, so the result must be cast to a supported scalar even though the
 * caller does not use the returned value.
 */
export async function acquireAdvisoryTransactionLock(
  client: AdvisoryLockClient,
  key: string,
): Promise<void> {
  await client.$queryRaw<Array<{ locked: string }>>(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS "locked"
    `,
  );
}
