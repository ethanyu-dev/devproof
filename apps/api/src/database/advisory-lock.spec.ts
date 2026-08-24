import { describe, expect, it, vi } from "vitest";

import { acquireAdvisoryTransactionLock } from "./advisory-lock.js";

describe("acquireAdvisoryTransactionLock", () => {
  it("casts PostgreSQL's void lock result to a Prisma-supported scalar", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ locked: "" }]);

    await acquireAdvisoryTransactionLock(
      { $queryRaw: queryRaw } as never,
      "team-1:artifact-1",
    );

    const query = queryRaw.mock.calls[0]?.[0] as {
      strings: string[];
      values: unknown[];
    };
    expect(query.strings.join("?")).toContain(
      'pg_advisory_xact_lock(hashtextextended(?, 0))::text AS "locked"',
    );
    expect(query.values).toEqual(["team-1:artifact-1"]);
  });
});
