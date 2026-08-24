import { describe, expect, it, vi } from "vitest";

import { JsonLogger } from "./json-logger.js";

describe("JsonLogger", () => {
  it("serializes Error details and correlation context", () => {
    const logger = new JsonLogger();
    logger.setContextProvider(() => ({
      requestId: "request-1",
      traceId: "trace-1",
    }));
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    logger.error(
      "operation failed",
      Object.assign(new Error("secret=hidden"), {
        code: "BROKEN",
      }),
    );

    const record = JSON.parse(String(write.mock.calls[0]?.[0])) as {
      details: Array<{
        code: string;
        message: string;
        name: string;
        stack: string;
      }>;
      requestId: string;
      traceId: string;
    };
    expect(record).toMatchObject({
      requestId: "request-1",
      traceId: "trace-1",
    });
    expect(record.details[0]).toMatchObject({
      code: "BROKEN",
      message: "secret=[REDACTED]",
      name: "Error",
    });
    expect(record.details[0]?.stack).toContain("Error: secret=[REDACTED]");
    write.mockRestore();
  });
});
