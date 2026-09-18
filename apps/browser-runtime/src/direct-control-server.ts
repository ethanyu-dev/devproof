import { createPublicKey, randomUUID, verify } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  browserHumanInputEventsSchema,
  directControlClaimsSchema,
  type BrowserHumanInputEvent,
  type DirectControlClaims,
} from "@devproof/runtime-protocol";

export function verifyDirectTicket(
  ticket: string,
  publicKey: string,
  runtimeId: string,
  now = Date.now(),
) {
  const parts = ticket.split(".");
  if (parts.length !== 2 || ticket.length > 4096)
    throw new Error("Invalid browser ticket.");
  const [body, signature] = parts as [string, string];
  const key = createPublicKey(publicKey.replaceAll("\\n", "\n"));
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, Buffer.from(body), key, Buffer.from(signature, "base64url"))
  )
    throw new Error("Invalid browser ticket.");
  const claims = directControlClaimsSchema.parse(
    JSON.parse(Buffer.from(body, "base64url").toString()),
  );
  if (
    claims.audience !== runtimeId ||
    claims.expiresAt <= now ||
    claims.issuedAt > now + 5000 ||
    claims.expiresAt - claims.issuedAt > 30_000 ||
    claims.expiresAt <= claims.issuedAt
  )
    throw new Error("Expired or invalid browser ticket.");
  return claims;
}

export interface DirectControlHandler {
  assert(claims: DirectControlClaims): void;
  preview(
    claims: DirectControlClaims,
    streamId: string,
    emit: (frame: unknown) => void,
  ): void;
  stopPreview(streamId: string): void;
  input(
    claims: DirectControlClaims,
    events: BrowserHumanInputEvent[],
  ): Promise<void>;
}

/** TLS terminates at a VM-local reverse proxy. This listener defaults to loopback. */
export async function startDirectControlServer(options: {
  runtimeId: string;
  publicKey: string;
  origins: string[];
  handler: DirectControlHandler;
  port: number;
  host?: string;
}) {
  if (!options.origins.length || options.origins.includes("*"))
    throw new Error("Direct control requires explicit Web origins.");
  const key = createPublicKey(options.publicKey.replaceAll("\\n", "\n"));
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Direct control requires an Ed25519 public key.");
  const usedTickets = new Map<string, number>();
  const controllers = new Map<string, WebSocket>();
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  server.on("upgrade", (request, socket, head) => {
    if (
      request.url !== "/browser-control" ||
      !options.origins.includes(request.headers.origin ?? "") ||
      sockets.clients.size >= 128
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) =>
      sockets.emit("connection", ws),
    );
  });
  sockets.on("connection", (socket) => {
    let claims: DirectControlClaims | undefined;
    let expiry = Date.now() + 5000;
    let streamId: string | undefined;
    let pending = 0;
    let inputs = 0;
    let windowAt = Date.now();
    let chain = Promise.resolve();
    const send = (value: unknown, frame = false) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      // Drop stale preview frames under pressure, never input acknowledgements.
      if (frame && socket.bufferedAmount >= 2 * 1024 * 1024) return;
      socket.send(JSON.stringify(value));
    };
    const assert = () => {
      if (
        !claims ||
        Date.now() >= expiry ||
        socket.readyState !== WebSocket.OPEN ||
        controllers.get(claims.sessionId) !== socket
      )
        throw new Error("Browser control expired.");
      options.handler.assert(claims);
      return claims;
    };
    const watchdog = setInterval(() => {
      try {
        if (claims) assert();
        else if (Date.now() >= expiry) throw new Error();
      } catch {
        socket.close(4001, "Browser control expired.");
      }
      for (const [id, until] of usedTickets)
        if (until <= Date.now()) usedTickets.delete(id);
    }, 250);
    watchdog.unref();
    socket.on("message", (raw, binary) => {
      try {
        if (binary) throw new Error();
        const value = JSON.parse(raw.toString());
        if (value.type === "authenticate") {
          if (typeof value.ticket !== "string") throw new Error();
          const next = verifyDirectTicket(
            value.ticket,
            options.publicKey,
            options.runtimeId,
          );
          for (const [nonce, until] of usedTickets)
            if (until <= Date.now()) usedTickets.delete(nonce);
          if (usedTickets.size >= 4096 || usedTickets.has(next.nonce))
            throw new Error();
          if (
            claims &&
            (claims.sessionId !== next.sessionId ||
              claims.userId !== next.userId ||
              claims.teamId !== next.teamId ||
              claims.controlGeneration !== next.controlGeneration ||
              claims.fencingToken !== next.fencingToken)
          )
            throw new Error();
          options.handler.assert(next);
          usedTickets.set(next.nonce, next.expiresAt);
          const previous = controllers.get(next.sessionId);
          controllers.set(next.sessionId, socket);
          if (previous && previous !== socket)
            previous.close(4001, "Browser control reconnected.");
          claims = next;
          expiry = next.expiresAt;
          if (!streamId) {
            streamId = randomUUID();
            options.handler.preview(next, streamId, (frame) => {
              try {
                assert();
                send(frame, true);
              } catch {
                socket.close(4001, "Browser control expired.");
              }
            });
          }
          send({ type: "ready" });
          return;
        }
        const current = assert();
        if (
          value.type !== "input" ||
          typeof value.id !== "string" ||
          value.id.length > 80 ||
          pending >= 8
        )
          throw new Error();
        const events = browserHumanInputEventsSchema.parse(value.events);
        if (Date.now() - windowAt >= 1000) {
          inputs = 0;
          windowAt = Date.now();
        }
        inputs += events.length;
        if (inputs > 120) throw new Error();
        pending++;
        chain = chain.then(async () => {
          try {
            assert();
            await options.handler.input(current, events);
            send({ type: "ack", id: value.id });
          } catch {
            send({
              type: "input-error",
              id: value.id,
              error: "Browser input failed or control expired.",
            });
          } finally {
            pending--;
          }
        });
      } catch {
        socket.close(4003, "Invalid browser control request.");
      }
    });
    socket.on("error", () => socket.close());
    socket.on("close", () => {
      clearInterval(watchdog);
      if (streamId) options.handler.stopPreview(streamId);
      if (claims && controllers.get(claims.sessionId) === socket)
        controllers.delete(claims.sessionId);
      claims = undefined;
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", resolve);
  });
  return {
    address: server.address(),
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
