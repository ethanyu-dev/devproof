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
    handleMessage(raw: string): Promise<void>;
    outbox: Array<{ sent: boolean }>;
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
});
