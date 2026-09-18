import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startDirectControlServer,
  verifyDirectTicket,
  type DirectControlHandler,
} from "./direct-control-server.js";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const runtimeId = randomUUID();
function ticket(overrides = {}) {
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      audience: runtimeId,
      sessionId: randomUUID(),
      userId: randomUUID(),
      teamId: randomUUID(),
      fencingToken: "7",
      controlGeneration: 3,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 20_000,
      nonce: randomUUID(),
      ...overrides,
    }),
  ).toString("base64url");
  return `${body}.${sign(null, Buffer.from(body), keys.privateKey).toString("base64url")}`;
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  let allowed = true;
  const handler: DirectControlHandler = {
    assert: vi.fn(() => {
      if (!allowed) throw new Error("Stale generation");
    }),
    preview: vi.fn(),
    stopPreview: vi.fn(),
    input: vi.fn(async () => undefined),
  };
  const server = await startDirectControlServer({
    runtimeId,
    publicKey,
    origins: ["https://console.example"],
    handler,
    port: 0,
  });
  cleanup.push(server.close);
  const port = (server.address as { port: number }).port;
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/browser-control`, {
      origin: "https://console.example",
    });
    await once(socket, "open");
    return socket;
  };
  return {
    connect,
    handler,
    revoke: () => {
      allowed = false;
    },
  };
}
async function message(socket: WebSocket, value: unknown) {
  const received = once(socket, "message");
  socket.send(JSON.stringify(value));
  return JSON.parse(String((await received)[0]));
}
describe("direct browser control", () => {
  it("rejects tampering, other runtimes, expired and overlong tickets", () => {
    expect(
      verifyDirectTicket(ticket(), publicKey, runtimeId).controlGeneration,
    ).toBe(3);
    expect(() =>
      verifyDirectTicket(ticket() + "x", publicKey, runtimeId),
    ).toThrow();
    expect(() =>
      verifyDirectTicket(ticket(), publicKey, randomUUID()),
    ).toThrow();
    expect(() =>
      verifyDirectTicket(
        ticket({ expiresAt: Date.now() - 1 }),
        publicKey,
        runtimeId,
      ),
    ).toThrow();
    expect(() =>
      verifyDirectTicket(
        ticket({ expiresAt: Date.now() + 60_000 }),
        publicKey,
        runtimeId,
      ),
    ).toThrow();
  });
  it("sends input directly, consumes tickets once and closes revoked controllers", async () => {
    const f = await fixture();
    const ws = await f.connect();
    const token = ticket();
    expect(await message(ws, { type: "authenticate", ticket: token })).toEqual({
      type: "ready",
    });
    const events = [{ type: "text", text: "hello" }];
    expect(await message(ws, { type: "input", id: "1", events })).toEqual({
      type: "ack",
      id: "1",
    });
    expect(f.handler.input).toHaveBeenCalledWith(
      expect.objectContaining({ controlGeneration: 3 }),
      events,
    );
    const replay = await f.connect();
    const rejected = once(replay, "close");
    replay.send(JSON.stringify({ type: "authenticate", ticket: token }));
    expect((await rejected)[0]).toBe(4003);
    const closed = once(ws, "close");
    f.revoke();
    expect((await closed)[0]).toBe(4001);
    await vi.waitFor(() => expect(f.handler.stopPreview).toHaveBeenCalled());
  });
  it("reconnecting the same session invalidates the previous direct socket", async () => {
    const f = await fixture();
    const scope = {
      sessionId: randomUUID(),
      userId: randomUUID(),
      teamId: randomUUID(),
    };
    const first = await f.connect();
    await message(first, { type: "authenticate", ticket: ticket(scope) });
    const closed = once(first, "close");
    const second = await f.connect();
    expect(
      await message(second, { type: "authenticate", ticket: ticket(scope) }),
    ).toEqual({ type: "ready" });
    expect((await closed)[0]).toBe(4001);
    expect(
      await message(second, {
        type: "input",
        id: "1",
        events: [{ type: "text", text: "new connection" }],
      }),
    ).toEqual({ type: "ack", id: "1" });
  });
  it("rejects input before authentication", async () => {
    const f = await fixture();
    const ws = await f.connect();
    const closed = once(ws, "close");
    ws.send(JSON.stringify({ type: "input", id: "1", events: [] }));
    expect((await closed)[0]).toBe(4003);
    expect(f.handler.input).not.toHaveBeenCalled();
  });
  it("renews the same session but cannot switch sessions on a live connection", async () => {
    const f = await fixture();
    const ws = await f.connect();
    const scope = {
      sessionId: randomUUID(),
      userId: randomUUID(),
      teamId: randomUUID(),
    };
    await message(ws, { type: "authenticate", ticket: ticket(scope) });
    expect(
      await message(ws, { type: "authenticate", ticket: ticket(scope) }),
    ).toEqual({ type: "ready" });
    expect(f.handler.preview).toHaveBeenCalledTimes(1);
    const closed = once(ws, "close");
    ws.send(
      JSON.stringify({
        type: "authenticate",
        ticket: ticket({ ...scope, controlGeneration: 4 }),
      }),
    );
    expect((await closed)[0]).toBe(4003);
  });
});
