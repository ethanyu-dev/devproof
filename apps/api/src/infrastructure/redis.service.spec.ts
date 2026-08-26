import { describe, expect, it } from "vitest";

import { fairConcurrencyShare } from "./redis.service.js";

describe("Agent Runtime concurrency allocation", () => {
  it("shares Browser capacity across active worker replicas", () => {
    const workers = ["worker-c", "worker-a", "worker-b"];
    expect(
      workers.map((workerId) => fairConcurrencyShare(8, workers, workerId)),
    ).toEqual([2, 3, 3]);
    expect(
      workers.reduce(
        (total, workerId) => total + fairConcurrencyShare(8, workers, workerId),
        0,
      ),
    ).toBe(8);
  });
});
