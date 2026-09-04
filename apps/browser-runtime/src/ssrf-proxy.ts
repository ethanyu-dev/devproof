import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { Transform, type Readable, type Writable } from "node:stream";

import { resolveSafeAddress } from "./ip-rules.js";

const FORBIDDEN_RESPONSE =
  "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n";

export interface SsrfProxy {
  readonly server: string;
  setAllowlist(allowlist: ReadonlySet<string>): void;
  setEnabled(enabled: boolean): void;
  stop(): Promise<void>;
}

function parseAuthority(authority: string, fallbackPort: number) {
  const value = authority.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return null;
    const rawPort = value.slice(end + 1).replace(/^:/u, "");
    const port = rawPort ? Number(rawPort) : fallbackPort;
    return Number.isInteger(port) && port >= 1 && port <= 65_535
      ? { host: value.slice(1, end), port }
      : null;
  }
  const separator = value.lastIndexOf(":");
  const host = separator < 0 ? value : value.slice(0, separator);
  const rawPort = separator < 0 ? "" : value.slice(separator + 1);
  const port = rawPort ? Number(rawPort) : fallbackPort;
  return host && Number.isInteger(port) && port >= 1 && port <= 65_535
    ? { host, port }
    : null;
}

function reject(socket: Socket) {
  socket.end(FORBIDDEN_RESPONSE);
}

/** Recheck permits for every forwarded chunk, including established TLS/WS tunnels. */
function forward(
  source: Readable,
  destination: Writable,
  permitted: () => boolean,
) {
  const gate = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!permitted())
        callback(new Error("Browser execution permit was withdrawn."));
      else callback(null, chunk);
    },
  });
  gate.once("error", () => {
    source.destroy();
    destination.destroy();
  });
  source.pipe(gate).pipe(destination);
}

function handleConnect(
  request: IncomingMessage,
  client: Socket,
  head: Buffer,
  allowlist: ReadonlySet<string>,
  permitted: () => boolean,
  track: (socket: Socket) => void,
) {
  void (async () => {
    const target = parseAuthority(request.url ?? "", 443);
    const address = target
      ? await resolveSafeAddress(target.host, allowlist)
      : null;
    if (!target || !address || !permitted()) {
      reject(client);
      return;
    }
    const upstream = netConnect(target.port, address, () => {
      if (!permitted()) {
        upstream.destroy();
        client.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      forward(client, upstream, permitted);
      forward(upstream, client, permitted);
    });
    track(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  })();
}

function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  allowlist: ReadonlySet<string>,
  permitted: () => boolean,
  track: (socket: Socket) => void,
) {
  void (async () => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (target.protocol !== "http:" || !permitted()) {
      response.writeHead(403).end();
      return;
    }
    const address = await resolveSafeAddress(target.hostname, allowlist);
    if (!address || !permitted()) {
      response.writeHead(403).end();
      return;
    }
    const headers: IncomingHttpHeaders = {
      ...request.headers,
      connection: "close",
      host: target.host,
    };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = httpRequest(
      {
        agent: false,
        headers,
        host: address,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        port: target.port ? Number(target.port) : 80,
      },
      (upstreamResponse) => {
        const responseHeaders = {
          ...upstreamResponse.headers,
          connection: "close",
        };
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        forward(upstreamResponse, response, permitted);
      },
    );
    upstream.on("socket", (socket) => {
      track(socket);
      if (!permitted()) upstream.destroy();
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    forward(request, upstream, permitted);
  })();
}

function handleUpgrade(
  request: IncomingMessage,
  client: Socket,
  head: Buffer,
  allowlist: ReadonlySet<string>,
  permitted: () => boolean,
  track: (socket: Socket) => void,
) {
  void (async () => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      reject(client);
      return;
    }
    const address = await resolveSafeAddress(target.hostname, allowlist);
    if (target.protocol !== "http:" || !address || !permitted()) {
      reject(client);
      return;
    }
    const upstream = netConnect(
      target.port ? Number(target.port) : 80,
      address,
      () => {
        if (!permitted()) {
          upstream.destroy();
          client.destroy();
          return;
        }
        const headers = Object.entries({
          ...request.headers,
          host: target.host,
        })
          .filter(([name]) => !name.toLowerCase().startsWith("proxy-"))
          .map(([name, value]) => `${name}: ${String(value)}`)
          .join("\r\n");
        upstream.write(
          `${request.method ?? "GET"} ${target.pathname}${target.search} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`,
        );
        if (head.length > 0) upstream.write(head);
        forward(client, upstream, permitted);
        forward(upstream, client, permitted);
      },
    );
    track(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  })();
}

export async function startSsrfProxy(
  options: {
    allowlist?: ReadonlySet<string>;
    isAllowed?: () => boolean;
  } = {},
): Promise<SsrfProxy> {
  let allowlist = new Set(options.allowlist ?? []);
  const sockets = new Set<Socket>();
  let enabled = true;
  let stopped = false;
  const permitted = () =>
    enabled && !stopped && (options.isAllowed?.() ?? true);
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const server: Server = createServer((request, response) =>
    handleHttp(request, response, allowlist, permitted, track),
  );
  server.on("connection", (socket) => {
    track(socket);
    if (!permitted()) socket.destroy();
  });
  server.on("connect", (request, socket, head) =>
    handleConnect(request, socket as Socket, head, allowlist, permitted, track),
  );
  server.on("upgrade", (request, socket, head) =>
    handleUpgrade(request, socket as Socket, head, allowlist, permitted, track),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("SSRF proxy failed to bind a local port.");
  }
  return {
    server: `http://127.0.0.1:${address.port}`,
    setAllowlist: (nextAllowlist) => {
      allowlist = new Set(nextAllowlist);
    },
    setEnabled: (value) => {
      enabled = value;
      if (!enabled) for (const socket of sockets) socket.destroy();
    },
    stop: () => {
      if (stopped) return Promise.resolve();
      stopped = true;
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
