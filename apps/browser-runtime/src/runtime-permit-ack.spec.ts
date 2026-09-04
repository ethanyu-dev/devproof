import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "./index.js";

describe("Runtime heartbeat permit acknowledgements", () => {
  it("ignores a delayed ACK and unknown IDs after the pending connection inventory is reset", async () => {
    const client = new RuntimeClient(
      { value: () => ({ sessions: [] }) } as never,
      { server: "http://127.0.0.1:1" } as never,
    );
    Reflect.set(client, "negotiatedProtocolMinor", 13);
    const manager = Reflect.get(client, "manager");
    const apply = vi.spyOn(manager, "acceptSessionPermits");
    const pending = Reflect.get(client, "pendingHeartbeats") as Map<
      string,
      number
    >;
    const handle = Reflect.get(client, "handleMessage").bind(client) as (
      raw: string,
    ) => Promise<void>;
    const old = randomUUID();
    const fresh = randomUUID();
    pending.set(old, 1);
    pending.set(fresh, 2);
    const ack = (heartbeatId: string) =>
      JSON.stringify({
        type: "runtime.heartbeat.ack",
        heartbeatId,
        sessionPermits: [],
        closeSessions: [],
        serverTime: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    await handle(ack(fresh));
    await handle(ack(old));
    expect(apply).toHaveBeenCalledTimes(1);
    pending.clear();
    await handle(ack(fresh));
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
