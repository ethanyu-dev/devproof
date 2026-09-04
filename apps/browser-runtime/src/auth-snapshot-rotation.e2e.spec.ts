import { createServer, request as httpRequest, type Server } from "node:http";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { probeAuthSnapshot } from "./auth-snapshot-probe.js";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("authentication snapshot credential rotation", () => {
  it("detects incompatible cloned authentication and demonstrates why the source must be revalidated", async () => {
    let validSession = "1";
    let authorizedRequests = 0;
    const application = createServer((request, response) => {
      if (request.url !== "/account") {
        response.writeHead(204).end();
        return;
      }
      const session =
        request.headers.cookie?.match(/(?:^|;\s*)sid=(\d+)/u)?.[1];
      if (session !== validSession) {
        response
          .writeHead(401, { "content-type": "text/html" })
          .end("Login required");
        return;
      }
      validSession = String(Number(validSession) + 1);
      authorizedRequests += 1;
      response
        .writeHead(200, {
          "set-cookie": `sid=${validSession}; Path=/; HttpOnly`,
          "content-type": "text/html",
        })
        .end('<h1 id="account">Account</h1>');
    });
    const origin = await listen(application);
    const proxy = createServer((request, response) => {
      const target = new URL(request.url!);
      // This disposable proxy must never reach anything except the local fixture.
      if (target.origin !== origin) {
        response.writeHead(403).end();
        return;
      }
      const forwarded = httpRequest(
        target,
        {
          method: request.method,
          headers: request.headers,
        },
        (remote) => {
          response.writeHead(remote.statusCode ?? 502, remote.headers);
          remote.pipe(response);
        },
      );
      forwarded.on("error", () => response.writeHead(502).end());
      request.pipe(forwarded);
    });
    const proxyServer = await listen(proxy);
    const browser = await chromium.launch({
      channel: "chromium",
      headless: true,
    });
    try {
      const source = await browser.newContext();
      const url = `${origin}/account`;
      await source.addCookies([{ name: "sid", value: validSession, url }]);
      const page = await source.newPage();
      expect((await page.goto(url))?.status()).toBe(200);
      await expect(
        probeAuthSnapshot({
          state: await source.storageState(),
          sessionId: "rotating-auth-test",
          verification: { url, authenticatedSelector: "#account" },
          concurrency: 4,
          proxyServer,
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: "AUTH_SNAPSHOT_PROBE_FAILED" });
      // Checking only the page loaded before probing would falsely report READY.
      expect(await page.locator("#account").count()).toBe(1);
      expect((await page.goto(url))?.status()).toBe(401);
      expect(await page.locator("#account").count()).toBe(0);
      expect(authorizedRequests).toBe(2);
    } finally {
      await browser.close();
      await Promise.all([close(proxy), close(application)]);
    }
  }, 30_000);
});
