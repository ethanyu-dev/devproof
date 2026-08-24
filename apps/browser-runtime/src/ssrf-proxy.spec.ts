import { createServer, request } from "node:http";

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
