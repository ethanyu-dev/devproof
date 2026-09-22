import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserControlConnection } from "./browser-connection";
import { consoleApi } from "./api";
vi.mock("./api", () => ({ consoleApi: vi.fn() }));
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
}
class Source {
  static instances: Source[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(..._args: unknown[]) {
    Source.instances.push(this);
  }
}
const open: BrowserControlConnection[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Socket.instances = [];
  Source.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("EventSource", Source);
});
afterEach(() => {
  open.splice(0).forEach((c) => c.close());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const options = () => ({
  connectionPath: "/connection",
  streamUrl: "/stream",
  relayInput: vi.fn(async () => undefined),
  onTransportChange: vi.fn(),
});
const frame = {
  data: JSON.stringify({
    type: "frame",
    dataBase64: "jpeg",
    width: 1280,
    height: 720,
  }),
};
it("keeps legacy nodes on the explicit relay transport", async () => {
  vi.mocked(consoleApi).mockResolvedValue({ transport: "relay" });
  const opts = options();
  const connection = new BrowserControlConnection(opts);
  open.push(connection);
  expect(opts.onTransportChange).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  await expect(
    connection.input([{ type: "text", text: "hello" }]),
  ).rejects.toThrow("尚未连接");
  Source.instances[0]!.onmessage?.(frame);
  await connection.input([{ type: "text", text: "hello" }]);
  expect(opts.relayInput).toHaveBeenCalledOnce();
  expect(Source.instances).toHaveLength(1);
  expect(opts.onTransportChange).toHaveBeenCalledWith("relay");
});

it.each(["runtime-error", "network-error", "silent-stream"])(
  "reconnects a relay after %s and waits for a fresh frame before accepting input",
  async (failure) => {
    vi.mocked(consoleApi).mockResolvedValue({ transport: "relay" });
    const opts = options();
    const connection = new BrowserControlConnection(opts);
    open.push(connection);
    const onerror = vi.fn();
    connection.onerror = onerror;
    await vi.advanceTimersByTimeAsync(0);
    const oldSource = Source.instances[0]!;
    oldSource.onmessage?.(frame);
    await connection.input([{ type: "text", text: "once" }]);
    if (failure === "runtime-error")
      oldSource.onmessage?.({
        data: '{"type":"error","error":"Runtime disconnected"}',
      });
    else if (failure === "network-error") oldSource.onerror?.();
    else await vi.advanceTimersByTimeAsync(6000);
    expect(oldSource.close).toHaveBeenCalledOnce();
    expect(onerror).toHaveBeenCalledOnce();
    // Late callbacks from the abandoned stream cannot revive it or double-reconnect.
    oldSource.onmessage?.(frame);
    oldSource.onerror?.();
    await expect(
      connection.input([{ type: "text", text: "blocked" }]),
    ).rejects.toThrow("尚未连接");
    await vi.advanceTimersByTimeAsync(2000);
    expect(Source.instances).toHaveLength(2);
    await expect(
      connection.input([{ type: "text", text: "blocked" }]),
    ).rejects.toThrow("尚未连接");
    Source.instances[1]!.onmessage?.(frame);
    await connection.input([{ type: "text", text: "new input" }]);
    expect(opts.relayInput.mock.calls).toEqual([
      [[{ type: "text", text: "once" }]],
      [[{ type: "text", text: "new input" }]],
    ]);
  },
);

it("requires frames, rather than status messages, to keep a relay healthy", async () => {
  vi.mocked(consoleApi).mockResolvedValue({ transport: "relay" });
  const connection = new BrowserControlConnection(options());
  open.push(connection);
  await vi.advanceTimersByTimeAsync(0);
  const source = Source.instances[0]!;
  await vi.advanceTimersByTimeAsync(5000);
  source.onmessage?.(frame);
  await vi.advanceTimersByTimeAsync(5000);
  expect(source.close).not.toHaveBeenCalled();
  source.onmessage?.({ data: '{"type":"status","connected":true}' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(source.close).toHaveBeenCalledOnce();
  connection.close();
  await vi.advanceTimersByTimeAsync(10000);
  expect(Source.instances).toHaveLength(1);
});

it("closes a relay without leaving its frame watchdog running", async () => {
  vi.mocked(consoleApi).mockResolvedValue({ transport: "relay" });
  const connection = new BrowserControlConnection(options());
  open.push(connection);
  await vi.advanceTimersByTimeAsync(0);
  connection.close();
  await vi.advanceTimersByTimeAsync(10000);
  expect(consoleApi).toHaveBeenCalledOnce();
  expect(Source.instances[0]!.close).toHaveBeenCalledOnce();
});
it("sends input and receives acknowledgements directly without invoking relay input", async () => {
  vi.mocked(consoleApi).mockResolvedValue({
    transport: "direct",
    url: "wss://vm.example/browser-control",
    ticket: "ticket",
    expiresAt: Date.now() + 20_000,
  });
  const opts = options();
  const connection = new BrowserControlConnection(opts);
  open.push(connection);
  await vi.advanceTimersByTimeAsync(0);
  const socket = Socket.instances[0]!;
  socket.onopen?.();
  expect(socket.send).toHaveBeenCalledWith(
    JSON.stringify({ type: "authenticate", ticket: "ticket" }),
  );
  socket.onmessage?.({ data: '{"type":"ready"}' });
  const input = connection.input([{ type: "text", text: "secret" }]);
  const event = JSON.parse(socket.send.mock.calls.at(-1)![0]);
  socket.onmessage?.({ data: JSON.stringify({ type: "ack", id: event.id }) });
  await input;
  expect(opts.relayInput).not.toHaveBeenCalled();
  expect(Source.instances).toHaveLength(0);
  expect(opts.onTransportChange).toHaveBeenCalledWith("direct");
  await vi.advanceTimersByTimeAsync(5000);
  expect(consoleApi).toHaveBeenCalledTimes(2);
});
it("does not silently downgrade a failed direct channel", async () => {
  vi.mocked(consoleApi)
    .mockResolvedValueOnce({
      transport: "direct",
      url: "wss://vm.example/browser-control",
      ticket: "ticket",
      expiresAt: Date.now() + 20_000,
    })
    .mockResolvedValue({ transport: "relay" });
  const opts = options();
  const connection = new BrowserControlConnection(opts);
  open.push(connection);
  await vi.advanceTimersByTimeAsync(0);
  Socket.instances[0]!.close();
  await vi.advanceTimersByTimeAsync(2000);
  await expect(
    connection.input([{ type: "text", text: "secret" }]),
  ).rejects.toThrow();
  expect(opts.relayInput).not.toHaveBeenCalled();
  expect(Source.instances).toHaveLength(0);
  expect(opts.onTransportChange).toHaveBeenCalledExactlyOnceWith("direct");
});

it.each(["direct", "relay"])(
  "receives a read-only %s preview but never sends input",
  async (transport) => {
    vi.mocked(consoleApi).mockResolvedValue({
      transport,
      url: "wss://vm.example/browser-control",
      ticket: "preview-ticket",
    });
    const connection = new BrowserControlConnection({
      connectionPath: "/runs/run/browser/connection",
      streamUrl: "/stream",
    });
    const onmessage = vi.fn();
    connection.onmessage = onmessage;
    open.push(connection);
    await vi.advanceTimersByTimeAsync(0);
    if (transport === "direct") {
      const socket = Socket.instances[0]!;
      socket.onmessage?.({ data: '{"type":"ready"}' });
      socket.onmessage?.({ data: '{"type":"frame"}' });
      expect(onmessage).toHaveBeenCalledWith({ data: '{"type":"frame"}' });
    } else {
      expect(Source.instances).toHaveLength(1);
    }
    await expect(
      connection.input([{ type: "text", text: "blocked" }]),
    ).rejects.toThrow("只读预览");
    expect(Socket.instances[0]?.send.mock.calls ?? []).toHaveLength(0);
  },
);
