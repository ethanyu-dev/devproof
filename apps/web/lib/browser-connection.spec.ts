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
  onmessage = null;
  onerror = null;
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
it("keeps legacy nodes on the explicit relay transport", async () => {
  vi.mocked(consoleApi).mockResolvedValue({ transport: "relay" });
  const opts = options();
  const connection = new BrowserControlConnection(opts);
  open.push(connection);
  expect(opts.onTransportChange).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  await connection.input([{ type: "text", text: "hello" }]);
  expect(opts.relayInput).toHaveBeenCalledOnce();
  expect(Source.instances).toHaveLength(1);
  expect(opts.onTransportChange).toHaveBeenCalledWith("relay");
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
