import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeClientMessageSchema } from "@devproof/runtime-protocol";
import { RuntimeClient } from "./index.js";
import { DomObservations } from "./dom-observation.js";

function fixture() {
  const store = { value: () => ({ sessions: [], runtimeId: randomUUID() }) };
  const client: any = new RuntimeClient(
    store as never,
    { server: "http://127.0.0.1:1", setAllowlist() {} } as never,
  );
  const sent: any[] = [];
  client.socket = {
    readyState: 1,
    send: (text: string) => sent.push(JSON.parse(text)),
  };
  client.connectionReady = true;
  client.deliveryAcknowledgements = true;
  client.negotiatedProtocolMinor = 15;
  const command = {
    type: "command.execute",
    commandId: randomUUID(),
    sessionId: randomUUID(),
    leaseToken: randomUUID(),
    fencingToken: "1",
    commandType: "page.click",
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    payload: { target: { ref: "e1" } },
  };
  return { client, sent, command };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Runtime reconnect incident regressions", () => {
  it("delivers long Playwright failures as valid errors and replays them until acknowledged", async () => {
    const { client, sent, command } = fixture();
    const error = new Error(
      "locator.click: Timeout exceeded.\n" + "失败".repeat(3300),
    );
    error.name = "TimeoutError";
    vi.spyOn(client.manager, "execute").mockRejectedValue(error);
    await client.executeCommand(command);
    expect(sent).toHaveLength(1);
    expect(sent[0].error.code).toBe("ACTION_TIMEOUT");
    expect(sent[0].error.message.length).toBeLessThanOrEqual(2000);
    expect(runtimeClientMessageSchema.safeParse(sent[0]).success).toBe(true);
    client.outbox[0].sent = false;
    client.flushOutbox();
    expect(sent[1]).toEqual(sent[0]);
    await client.handleMessage(
      JSON.stringify({
        type: "runtime.delivery.ack",
        messageId: command.commandId,
        messageType: "command.result",
      }),
    );
    expect(client.outbox).toHaveLength(0);
  });

  it("never queues a structurally invalid message", () => {
    const { client, sent } = fixture();
    client.send({ type: "command.result", commandId: "broken" });
    expect(sent).toHaveLength(0);
    expect(client.outbox).toHaveLength(0);
  });

  it("returns a bounded retargeting instruction for an intercepted action", async () => {
    const { client, sent, command } = fixture();
    vi.spyOn(client.manager, "execute").mockRejectedValue(
      new Error(
        "Timeout exceeded: dialog intercepts pointer events\n" +
          "x".repeat(3000),
      ),
    );
    await client.executeCommand(command);
    expect(sent[0].error).toMatchObject({
      code: "ACTION_BLOCKED",
      recoveryAction: "RESNAPSHOT_AND_RETARGET",
    });
    expect(runtimeClientMessageSchema.safeParse(sent[0]).success).toBe(true);
  });

  it("waits for reconciliation but still processes cancellation while a command is running", async () => {
    const { client, command, sent } = fixture();
    client.connectionReady = false;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(client.manager, "applyReconcile").mockReturnValue(barrier);
    vi.spyOn(client.manager, "configureProtocol").mockImplementation(
      () => undefined,
    );
    vi.spyOn(client.manager, "cleanupExpiredProfiles").mockResolvedValue([]);
    vi.spyOn(client, "restoreRuntimeDiagnosticEvents").mockResolvedValue(
      undefined,
    );
    const execute = vi
      .spyOn(client.manager, "execute")
      .mockReturnValue(new Promise(() => {}));
    const cancel = vi
      .spyOn(client.manager, "cancel")
      .mockResolvedValue(undefined);
    const handshake = client.handleMessage(
      JSON.stringify({
        type: "runtime.hello.accepted",
        protocol: { name: "devproof-browser-runtime", major: 1, minor: 15 },
        capabilities: [],
        reconcile: [],
        heartbeatIntervalMs: 15_000,
        networkAllowlist: [],
        serverTime: new Date().toISOString(),
      }),
    );
    const running = client.handleMessage(JSON.stringify(command));
    try {
      await Promise.resolve();
      expect(execute).not.toHaveBeenCalled();
      release();
      await handshake;
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      await client.handleMessage(
        JSON.stringify({
          type: "command.cancel",
          commandId: command.commandId,
          sessionId: command.sessionId,
          reason: "Cancelled by test",
        }),
      );
      await running;
      expect(cancel).toHaveBeenCalledOnce();
      expect(
        sent.find((message) => message.type === "command.result").error.code,
      ).toBe("CANCELLED");
    } finally {
      clearInterval(client.heartbeatTimer);
    }
  });

  it("does not mark a disconnected handshake ready after reconciliation finishes", async () => {
    const { client } = fixture();
    client.connectionReady = false;
    let release!: () => void;
    vi.spyOn(client.manager, "applyReconcile").mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const handshake = client.handleMessage(
      JSON.stringify({
        type: "runtime.hello.accepted",
        protocol: { name: "devproof-browser-runtime", major: 1, minor: 15 },
        capabilities: [],
        reconcile: [],
        heartbeatIntervalMs: 15_000,
        networkAllowlist: [],
        serverTime: new Date().toISOString(),
      }),
    );
    client.socket = undefined;
    release();
    await handshake;
    expect(client.connectionReady).toBe(false);
    expect(client.heartbeatTimer).toBeUndefined();
  });

  it("backs off repeated short-lived connections instead of resetting on every close", async () => {
    vi.useFakeTimers();
    const { client } = fixture();
    vi.spyOn(client, "restoreProfileLifecycleEvents").mockResolvedValue(
      undefined,
    );
    vi.spyOn(client.manager, "startProfileCleanup").mockImplementation(
      () => undefined,
    );
    const connect = vi
      .spyOn(client, "connectOnce")
      .mockResolvedValue(undefined);
    const running = client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(3);
    client.stopped = true;
    await vi.advanceTimersByTimeAsync(2000);
    await running;
  });
});

it("observes the DOM across the page and an open modal without ARIA", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const dom = new DomObservations();
    await page.setContent(
      "<label>Background type<select><option>Legacy</option></select></label><dialog><label>Modal type<select><option>New</option></select></label></dialog>",
    );
    await page
      .locator("dialog")
      .evaluate((dialog: HTMLDialogElement) => dialog.showModal());
    const snapshot = await dom.snapshot(page);
    expect(snapshot.content).toContain("Modal type");
    expect(snapshot.content).toContain("Background type");
    await page
      .locator("dialog")
      .evaluate((dialog: HTMLDialogElement) => dialog.close());
    expect((await dom.snapshot(page)).content).not.toContain("Modal type");
  } finally {
    await browser.close();
  }
});
