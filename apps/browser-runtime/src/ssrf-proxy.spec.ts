import { createServer, request } from "node:http";
import { createConnection } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { SsrfProxy } from "./ssrf-proxy.js";
import { startSsrfProxy } from "./ssrf-proxy.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function localServer() {
  const server = createServer((_request, response) => response.end("safe"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port.");
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return address.port;
}

async function throughProxy(proxy: SsrfProxy, target: string) {
  const proxyUrl = new URL(proxy.server);
  return new Promise<{ body: string; status: number }>((resolve, reject) => {
    const outgoing = request(
      {
        headers: { host: new URL(target).host },
        host: proxyUrl.hostname,
        method: "GET",
        path: target,
        port: Number(proxyUrl.port),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("Browser SSRF forward proxy", () => {
  it("cuts an established CONNECT tunnel without disrupting another session proxy", async () => {
    const port = await localServer();
    const proxy = await startSsrfProxy({ allowlist: new Set(["127.0.0.1"]) });
    const other = await startSsrfProxy({ allowlist: new Set(["127.0.0.1"]) });
    cleanups.push(
      () => proxy.stop(),
      () => other.stop(),
    );
    const proxyUrl = new URL(proxy.server);
    const tunnel = createConnection(Number(proxyUrl.port), proxyUrl.hostname);
    tunnel.on("error", () => undefined);
    cleanups.push(async () => {
      tunnel.destroy();
    });
    await new Promise<void>((resolve) => tunnel.once("connect", resolve));
    const connected = new Promise<Buffer>((resolve) =>
      tunnel.once("data", resolve),
    );
    tunnel.write(
      `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
    );
    expect((await connected).toString()).toContain(
      "200 Connection Established",
    );
    const closed = new Promise<void>((resolve) =>
      tunnel.once("close", resolve),
    );
    proxy.setEnabled(false);
    await closed;
    await expect(
      throughProxy(other, `http://127.0.0.1:${port}/independent`),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      throughProxy(proxy, `http://127.0.0.1:${port}/blocked`),
    ).rejects.toBeDefined();
  });

  it("terminates a streaming HTTP request and its upstream socket when its permit is withdrawn", async () => {
    let received!: () => void;
    let upstreamClosed!: () => void;
    const arrived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const disconnected = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.write("streaming");
      response.once("close", upstreamClosed);
      received();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test port.");
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const proxy = await startSsrfProxy({ allowlist: new Set(["127.0.0.1"]) });
    cleanups.push(() => proxy.stop());
    const url = new URL(proxy.server);
    const outgoing = request({
      host: url.hostname,
      port: Number(url.port),
      path: `http://127.0.0.1:${address.port}/stream`,
    });
    outgoing.on("error", () => undefined);
    outgoing.on("response", (response) => {
      response.on("error", () => undefined);
      response.resume();
    });
    outgoing.end();
    await arrived;
    proxy.setEnabled(false);
    await disconnected;
    outgoing.destroy();
  });

  it("blocks loopback by default", async () => {
    const port = await localServer();
    const proxy = await startSsrfProxy();
    cleanups.push(() => proxy.stop());

    await expect(
      throughProxy(proxy, `http://127.0.0.1:${port}/private`),
    ).resolves.toMatchObject({ status: 403 });
  });

  it("supports an explicit exact private-host allowlist", async () => {
    const port = await localServer();
    const proxy = await startSsrfProxy({
      allowlist: new Set(["127.0.0.1"]),
    });
    cleanups.push(() => proxy.stop());

    await expect(
      throughProxy(proxy, `http://127.0.0.1:${port}/allowed`),
    ).resolves.toEqual({ body: "safe", status: 200 });
  });

  it("applies a control-plane allowlist without restarting the proxy", async () => {
    const port = await localServer();
    const proxy = await startSsrfProxy();
    cleanups.push(() => proxy.stop());
    const target = `http://127.0.0.1:${port}/managed`;

    await expect(throughProxy(proxy, target)).resolves.toMatchObject({
      status: 403,
    });

    proxy.setAllowlist(new Set(["127.0.0.1"]));

    await expect(throughProxy(proxy, target)).resolves.toEqual({
      body: "safe",
      status: 200,
    });
  });
});
