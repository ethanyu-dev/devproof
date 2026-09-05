import { describe, expect, it, vi } from "vitest";
import { RuntimeConnectionHub } from "./runtime-connection-hub.service.js";

function fixture() {
  let delivery: (event: unknown) => void = () => {};
  const redis = {
    onRuntimeDelivery: vi.fn((callback) => {
      delivery = callback;
    }),
    removeRuntimePresence: vi.fn().mockResolvedValue(undefined),
    publishRuntimeDelivery: vi.fn(),
  };
  const prisma = {
    browserRuntime: {
      findUnique: vi.fn().mockResolvedValue({ connectionGeneration: 3n }),
    },
  };
  const hub = new RuntimeConnectionHub(
    redis as never,
    undefined,
    undefined,
    prisma as never,
  );
  const socket = () => ({
    readyState: 1,
    close: vi.fn(),
    send: vi.fn((_message, done) => done?.()),
  });
  return {
    hub,
    redis,
    prisma,
    socket,
    deliver: (event: unknown) => delivery(event),
  };
}
const message = {
  type: "command.cancel" as const,
  commandId: "command",
  sessionId: "session",
  reason: "stopped",
};

describe("Runtime connection generation fencing", () => {
  it("does not let an old socket close callback remove its replacement", () => {
    const { hub, redis, socket } = fixture();
    const old = socket(),
      current = socket();
    hub.register("runtime", old as never, 2n);
    old.close.mockImplementation(() => hub.unregister("runtime", old as never));
    hub.register("runtime", current as never, 3n);
    expect(redis.removeRuntimePresence).not.toHaveBeenCalled();
    expect(hub.unregister("runtime", current as never)).toBe(true);
    expect(redis.removeRuntimePresence).toHaveBeenCalledWith("runtime", 3n);
  });
  it("ignores delayed disconnect messages and rejects older registrations", () => {
    const { hub, socket, deliver } = fixture();
    const current = socket(),
      stale = socket();
    hub.register("runtime", current as never, 3n);
    deliver({
      kind: "DISCONNECT_OLDER_GATEWAYS",
      runtimeId: "runtime",
      connectionGeneration: "2",
    });
    deliver({
      kind: "DISCONNECT_OLDER_GATEWAYS",
      runtimeId: "runtime",
      connectionGeneration: "3",
    });
    deliver({ kind: "DISCONNECT_OLDER_GATEWAYS", runtimeId: "runtime" });
    expect(current.close).not.toHaveBeenCalled();
    hub.register("runtime", stale as never, 1n);
    expect(stale.close).toHaveBeenCalledOnce();
    deliver({
      kind: "DISCONNECT_OLDER_GATEWAYS",
      runtimeId: "runtime",
      connectionGeneration: "4",
    });
    expect(current.close).toHaveBeenCalledOnce();
  });
  it("does not deliver stale or unversioned Redis messages to a newer socket", async () => {
    const { hub, socket, deliver } = fixture();
    const current = socket();
    hub.register("runtime", current as never, 3n);
    deliver({
      kind: "DELIVER",
      runtimeId: "runtime",
      connectionGeneration: "2",
      message,
    });
    deliver({ kind: "DELIVER", runtimeId: "runtime", message });
    expect(current.send).not.toHaveBeenCalled();
    await hub.send("runtime", message, 3n);
    expect(current.send).toHaveBeenCalledOnce();
  });
  it("uses the database generation when a newer socket belongs to another API", async () => {
    const { hub, redis, socket, prisma } = fixture();
    const old = socket();
    hub.register("runtime", old as never, 2n);
    await hub.send("runtime", message);
    expect(old.send).not.toHaveBeenCalled();
    expect(redis.publishRuntimeDelivery).toHaveBeenCalledWith({
      kind: "DELIVER",
      runtimeId: "runtime",
      connectionGeneration: "3",
      message,
    });
    prisma.browserRuntime.findUnique.mockResolvedValue(null as never);
    redis.publishRuntimeDelivery.mockClear();
    await hub.send("runtime", message);
    expect(redis.publishRuntimeDelivery).not.toHaveBeenCalled();
  });
});
