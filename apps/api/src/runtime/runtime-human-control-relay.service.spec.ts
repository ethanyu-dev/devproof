import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { RuntimeHumanControlRelay } from "./runtime-human-control-relay.service.js";

function fixture() {
  const send = vi.fn().mockResolvedValue(undefined);
  const relay = new RuntimeHumanControlRelay({ send } as never);
  const session = {
    fencingToken: 7n,
    id: randomUUID(),
    leaseToken: randomUUID(),
    runtimeId: randomUUID(),
  };
  return { relay, send, session };
}

describe("RuntimeHumanControlRelay", () => {
  it("forwards only frames that match the active session fence", async () => {
    const { relay, send, session } = fixture();
    const emit = vi.fn();
    const close = await relay.subscribe(session, emit);
    const subscribe = send.mock.calls[0]?.[1];

    expect(emit).toHaveBeenCalledWith({ connected: false, type: "status" });
    relay.acceptFrame(session.runtimeId, {
      capturedAt: new Date().toISOString(),
      dataBase64: "anBlZw==",
      fencingToken: "8",
      height: 720,
      leaseToken: session.leaseToken,
      sessionId: session.id,
      streamId: subscribe.streamId,
      title: "ignored",
      type: "human.preview.frame",
      url: "https://example.com",
      width: 1280,
    });
    expect(emit).toHaveBeenCalledTimes(1);

    relay.acceptFrame(session.runtimeId, {
      capturedAt: new Date().toISOString(),
      dataBase64: "anBlZw==",
      fencingToken: "7",
      height: 720,
      leaseToken: session.leaseToken,
      sessionId: session.id,
      streamId: subscribe.streamId,
      title: "Example",
      type: "human.preview.frame",
      url: "https://example.com",
      width: 1280,
    });
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Example", type: "frame" }),
    );

    await close();
    expect(send).toHaveBeenLastCalledWith(
      session.runtimeId,
      expect.objectContaining({ type: "human.preview.unsubscribe" }),
    );
  });

  it("requires a matching lease and fence before accepting input ack", async () => {
    const { relay, send, session } = fixture();
    const completion = relay.dispatch(session, [
      { deltaX: 0, deltaY: 20, type: "wheel", x: 0.5, y: 0.5 },
    ]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const dispatch = send.mock.calls[0]?.[1];

    relay.acceptInputResult(session.runtimeId, {
      dispatchId: dispatch.dispatchId,
      fencingToken: "8",
      leaseToken: session.leaseToken,
      ok: true,
      sessionId: session.id,
      type: "human.input.result",
    });
    let settled = false;
    void completion.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    relay.acceptInputResult(session.runtimeId, {
      dispatchId: dispatch.dispatchId,
      fencingToken: "7",
      leaseToken: session.leaseToken,
      ok: true,
      sessionId: session.id,
      type: "human.input.result",
    });
    await expect(completion).resolves.toBeUndefined();
  });
});
