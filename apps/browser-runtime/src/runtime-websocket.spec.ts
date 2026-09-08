import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";

import { RUNTIME_PROTOCOL } from "@devproof/runtime-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserSessionManager, RuntimeClient } from "./index.js";

interface Peer {
  send: (message: string) => void;
  close: (code: number) => void;
}

function frame(opcode: number, payload: Buffer) {
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  header[1] = payload.length < 126 ? payload.length : 126;
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

/** A local wire peer keeps these tests on Node's actual WebSocket.close API. */
async function gateway(
  onHello: (peer: Peer, connection: number) => void,
  replyToClientClose = true,
) {
  const sockets = new Set<Duplex>();
  const clientCloseCodes: number[] = [];
  let connections = 0;
  let hellos = 0;
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const connection = ++connections;
    const accept = createHash("sha1")
      .update(
        request.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );
    const peer: Peer = {
      send: (message) => socket.write(frame(1, Buffer.from(message))),
      close: (code) => {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code);
        socket.write(frame(8, payload));
      },
    };
    let pending = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const opcode = pending[0]! & 0x0f;
        const masked = (pending[1]! & 0x80) !== 0;
        let length = pending[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          socket.destroy(new Error("Unexpected large test frame."));
          return;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (pending.length < offset + length) return;
        const payload = Buffer.from(pending.subarray(offset, offset + length));
        if (masked) {
          for (let index = 0; index < payload.length; index++) {
            payload[index] =
              payload[index]! ^ pending[maskOffset + (index % 4)]!;
          }
        }
        pending = pending.subarray(offset + length);
        if (opcode === 8) {
          clientCloseCodes.push(
            payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
          );
          if (replyToClientClose) socket.end(frame(8, payload));
          else socket.destroy(); // Native WebSocket reports abnormal closure (1006).
          return;
        }
        if (
          opcode === 1 &&
          JSON.parse(payload.toString()).type === "runtime.hello"
        ) {
          hellos++;
          onHello(peer, connection);
        }
      }
    };
    socket.on("data", receive);
    if (head.length) receive(head);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test gateway address.");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    clientCloseCodes,
    get connections() {
      return connections;
    },
    get hellos() {
      return hellos;
    },
    async dispose() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

type ClientInternals = {
  manager: BrowserSessionManager;
  socket?: WebSocket;
  restoreProfileLifecycleEvents: () => Promise<void>;
};

describe("RuntimeClient native WebSocket lifecycle", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
  });

  async function fixture(
    onHello: (peer: Peer, connection: number) => void,
    replyToClientClose = true,
  ) {
    let internals: ClientInternals | undefined;
    const observedCloseCodes: number[] = [];
    const server = await gateway((peer, connection) => {
      internals?.socket?.addEventListener("close", (event) => {
        observedCloseCodes.push(event.code);
      });
      onHello(peer, connection);
    }, replyToClientClose);
    const state = {
      gatewayUrl: server.url,
      runtimeId: randomUUID(),
      runtimeToken: "test-only-runtime-token".repeat(2),
      sessions: [],
      revokedSessionIds: [],
    };
    const client = new RuntimeClient(
      { value: () => state } as never,
      { server: "http://127.0.0.1:1" } as never,
    );
    internals = client as unknown as ClientInternals;
    // The network lifecycle is real; unrelated profile cleanup must never read HOME.
    vi.spyOn(internals, "restoreProfileLifecycleEvents").mockResolvedValue();
    vi.spyOn(internals.manager, "startProfileCleanup").mockImplementation(
      () => undefined,
    );
    let finished = false;
    const running = client.start().finally(() => {
      finished = true;
    });
    cleanups.push(async () => {
      client.stop();
      await server.dispose();
      await running;
    });
    return {
      client,
      server,
      observedCloseCodes,
      async finished() {
        await vi.waitFor(() => expect(finished).toBe(true), { timeout: 3_000 });
        await running;
      },
    };
  }

  it.each([
    "AUTH_FAILED",
    "PROTOCOL_MISMATCH",
    "RUNTIME_DISABLED",
    "INVALID_HELLO",
  ])("stops after a %s hello rejection without reconnecting", async (code) => {
    const { server, finished } = await fixture((peer) =>
      peer.send(
        JSON.stringify({
          type: "runtime.hello.rejected",
          code,
          message: "Test handshake rejection.",
          supportedProtocol: RUNTIME_PROTOCOL,
        }),
      ),
    );

    await finished();

    expect(server.connections).toBe(1);
    expect(server.hellos).toBe(1);
    expect(server.clientCloseCodes).toEqual([4003]);
  });

  it("keeps a hello rejection terminal even if the peer disconnects without a close reply", async () => {
    const { server, observedCloseCodes, finished } = await fixture(
      (peer) =>
        peer.send(
          JSON.stringify({
            type: "runtime.hello.rejected",
            code: "RUNTIME_DISABLED",
            message: "Test frozen Runtime.",
            supportedProtocol: RUNTIME_PROTOCOL,
          }),
        ),
      false,
    );

    await finished();

    expect(server.connections).toBe(1);
    expect(server.clientCloseCodes).toEqual([4003]);
    expect(observedCloseCodes).toEqual([1006]);
  });

  it("closes a malformed message with a valid application code and reconnects", async () => {
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", recordUnhandled);
    cleanups.push(async () => {
      process.off("unhandledRejection", recordUnhandled);
    });
    const { server, finished } = await fixture((peer, connection) => {
      if (connection === 1) peer.send("{invalid JSON");
      else peer.close(4003);
    });

    await finished();

    expect(server.connections).toBe(2);
    expect(server.hellos).toBe(2);
    expect(server.clientCloseCodes[0]).toBe(4000);
    expect(unhandled).toEqual([]);
  });

  it("stops when the server closes with 4003 without a rejection message", async () => {
    const { server, finished } = await fixture((peer) => peer.close(4003));

    await finished();

    expect(server.connections).toBe(1);
    expect(server.hellos).toBe(1);
  });

  it("keeps normal shutdown on close code 1000 and does not reconnect", async () => {
    const { client, server, finished } = await fixture(() => undefined);
    await vi.waitFor(() => expect(server.hellos).toBe(1));

    client.stop();
    await finished();

    expect(server.connections).toBe(1);
    expect(server.clientCloseCodes).toEqual([1000]);
  });
});
