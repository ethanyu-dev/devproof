import { describe, expect, it, vi } from "vitest";

import { RuntimeClient } from "./index.js";

function clientWithSocket(send: (value: string) => void) {
  const client = new RuntimeClient(
    {
      value: () => ({
        apiUrl: "http://api",
        gatewayUrl: "ws://gateway",
        runtimeId: "11111111-1111-4111-8111-111111111111",
        runtimeToken: "x".repeat(32),
        sessions: [],
      }),
    } as never,
    "http://proxy",
  );
  const internal = client as unknown as {
    deliveryAcknowledgements: boolean;
    enqueueOutbox(
      message: unknown,
      serialized: string,
      messageId: string,
      messageType: "command.result" | "runtime.event",
    ): void;
    handleMessage(raw: string): Promise<void>;
    manager: {
      emitEvent(
        session: Record<string, unknown>,
        kind: "VIDEO_FINALIZATION_FAILED",
        payload: Record<string, unknown>,
      ): void;
    };
    negotiatedProtocolMinor: number;
    outbox: Array<{
      bytes: number;
      message: { type?: string };
      messageId: string;
      messageType: string;
      priority: number;
      sent: boolean;
    }>;
    outboxBytes: number;
    send(message: unknown): void;
    socket: { readyState: number; send(value: string): void };
  };
  internal.deliveryAcknowledgements = true;
  internal.socket = { readyState: 1, send };
  return internal;
}

describe("RuntimeClient delivery outbox", () => {
  it("retains reliable messages until the gateway acknowledges persistence", async () => {
    const send = vi.fn();
    const client = clientWithSocket(send);
    const commandId = "11111111-1111-4111-8111-111111111111";

    client.send({ commandId, type: "command.result" });

    expect(send).toHaveBeenCalledOnce();
    expect(client.outbox).toEqual([expect.objectContaining({ sent: true })]);
    await client.handleMessage(
      JSON.stringify({
        messageId: commandId,
        messageType: "command.result",
        type: "runtime.delivery.ack",
      }),
    );
    expect(client.outbox).toHaveLength(0);
  });

  it("keeps the message queued when WebSocket.send throws", () => {
    const client = clientWithSocket(() => {
      throw new Error("socket closed");
    });

    client.send({
      eventId: "22222222-2222-4222-8222-222222222222",
      type: "runtime.event",
    });

    expect(client.outbox).toEqual([expect.objectContaining({ sent: false })]);
  });

  it("evicts ordinary events before command results", () => {
    const client = clientWithSocket(() => undefined);
    const commandId = "11111111-1111-4111-8111-111111111111";
    client.outbox = Array.from({ length: 500 }, (_value, index) => ({
      bytes: 1,
      message: { kind: "PAGE_CHANGED", type: "runtime.event" },
      messageId: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
      messageType: "runtime.event",
      priority: 1,
      sent: true,
    }));
    client.outboxBytes = 500;
    client.enqueueOutbox(
      { commandId, type: "command.result" },
      JSON.stringify({ commandId, type: "command.result" }),
      commandId,
      "command.result",
    );

    expect(client.outbox).toHaveLength(500);
    expect(
      client.outbox.some(
        (queued) =>
          queued.messageType === "command.result" && queued.priority === 3,
      ),
    ).toBe(true);
  });

  it("prioritizes video finalization diagnostics over ordinary events", () => {
    const client = clientWithSocket(() => undefined);
    client.send({
      eventId: "22222222-2222-4222-8222-222222222222",
      kind: "VIDEO_FINALIZATION_FAILED",
      type: "runtime.event",
    });

    expect(client.outbox).toEqual([
      expect.objectContaining({ messageType: "runtime.event", priority: 2 }),
    ]);
  });

  it("emits video diagnostics only after negotiating protocol v1.12", () => {
    const client = clientWithSocket(() => undefined);
    const session = {
      fencingToken: "7",
      leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
      sessionId: "11bb7c5c-cd52-4ae7-8759-6e4e1391357d",
    };

    client.negotiatedProtocolMinor = 11;
    client.manager.emitEvent(session, "VIDEO_FINALIZATION_FAILED", {});
    expect(client.outbox).toHaveLength(0);

    client.negotiatedProtocolMinor = 12;
    client.manager.emitEvent(session, "VIDEO_FINALIZATION_FAILED", {});
    expect(client.outbox).toEqual([
      expect.objectContaining({ messageType: "runtime.event", priority: 2 }),
    ]);
  });
});
