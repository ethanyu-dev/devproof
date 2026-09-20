import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWebhookOrigin,
  TaskWebhookService,
  webhookSignature,
} from "./task-webhook.service.js";
vi.mock("../config/env.js", () => ({
  env: () => ({
    TASK_WEBHOOK_ALLOWED_ORIGINS: "https://hooks.example.com",
    BACKGROUND_WORKERS_ENABLED: false,
  }),
}));
afterEach(() => vi.unstubAllGlobals());
function harness(attempts = 1) {
  const row = {
    id: "delivery",
    eventId: "event",
    attempts,
    event: {
      kind: "task.completed",
      sequence: 9007199254740993n,
      occurredAt: new Date("2026-09-20T00:00:00Z"),
      payload: { password: "must-not-leak" },
    },
    webhook: {
      taskId: "task",
      url: "https://hooks.example.com/result",
      secretEnvelope: "encrypted",
      disabledAt: null,
      credential: { revokedAt: null, expiresAt: null },
      task: { externalSource: "ci", externalId: "123" },
    },
  };
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    taskWebhookDelivery: {
      updateMany,
      findUniqueOrThrow: vi.fn().mockResolvedValue(row),
    },
  };
  const cipher = { decrypt: vi.fn().mockReturnValue("secret") };
  return {
    row,
    prisma,
    updateMany,
    service: new TaskWebhookService(prisma as never, cipher as never),
  };
}
describe("task webhook deliveries", () => {
  it("enforces exact origins when an allowlist is configured", () => {
    expect(() =>
      assertWebhookOrigin(
        "https://hooks.example.com/a",
        "https://hooks.example.com",
      ),
    ).not.toThrow();
    for (const value of [
      "https://hooks.example.com.evil.test/a",
      "http://hooks.example.com/a",
      "https://user:pass@hooks.example.com/a",
      "https://hooks.example.com:444/a",
      "https://127.0.0.1/a",
    ])
      expect(() =>
        assertWebhookOrigin(value, "https://hooks.example.com"),
      ).toThrow();
  });
  it("allows arbitrary HTTP(S) hosts and ports by default, including local and private networks", () => {
    for (const url of [
      "https://external.example.com/a",
      "http://localhost:8090/events",
      "http://127.0.0.1:9000/events",
      "http://10.0.0.2:1234/events",
      "https://example.com:8443/a",
    ])
      expect(() => assertWebhookOrigin(url, "  ,  ")).not.toThrow();
    for (const url of [
      "file:///tmp/events",
      "ftp://example.com/events",
      "http://user:pass@example.com/events",
      "https://example.com/events#fragment",
    ])
      expect(() => assertWebhookOrigin(url, "")).toThrow();
  });
  it("sends signed metadata, no raw payload, with a timeout and redirects disabled", async () => {
    const { service, updateMany } = harness();
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, body: { cancel: vi.fn() } });
    vi.stubGlobal("fetch", fetchMock);
    await service.deliver("delivery");
    const options = fetchMock.mock.calls[0]![1];
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.body).not.toContain("must-not-leak");
    expect(JSON.parse(options.body).sequence).toBe("9007199254740993");
    const expected = createHmac("sha256", "secret")
      .update(`${options.headers["X-DevProof-Timestamp"]}.${options.body}`)
      .digest("hex");
    expect(options.headers["X-DevProof-Signature"]).toBe(`sha256=${expected}`);
    expect(updateMany.mock.calls[1]![0]).toMatchObject({
      where: { id: "delivery", leaseToken: expect.any(String) },
      data: { status: "DELIVERED" },
    });
  });
  it("does not send when another worker holds the lease", async () => {
    const { service, updateMany } = harness();
    updateMany.mockResolvedValueOnce({ count: 0 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await service.deliver("delivery");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([1, 8])(
    "retries transient failures and exhausts at eight attempts (%s)",
    async (attempt) => {
      const { service, updateMany } = harness(attempt);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("secret detail")),
      );
      await service.deliver("delivery");
      const update = updateMany.mock.calls[1]![0];
      expect(update.data.status).toBe(attempt === 8 ? "FAILED" : "PENDING");
      expect(update.data.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      expect(update.data.lastError).not.toContain("secret detail");
    },
  );
  it("cancels delivery after a token has been revoked", async () => {
    const { service, row, updateMany } = harness();
    row.webhook.credential.revokedAt = new Date() as never;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await service.deliver("delivery");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMany.mock.calls[1]![0].data.status).toBe("CANCELLED");
  });
  it("signs the exact timestamp and raw body bytes", () => {
    expect(webhookSignature("key", "123", '{"a":1}')).not.toBe(
      webhookSignature("key", "123", '{ "a":1}'),
    );
  });
});
