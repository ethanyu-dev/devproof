import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserSessionManager } from "./index.js";
import { startSsrfProxy } from "./ssrf-proxy.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixtureServer() {
  const server = createServer((request, response) => {
    if (request.url === "/frame") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        "<button onclick=\"document.body.dataset.clicked='yes'\">Frame action</button>",
      );
      return;
    }
    if (request.url === "/api") {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.statusCode = 200;
      response.end("real response");
      return;
    }
    if (request.url === "/api-json") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.statusCode = 200;
      response.end(
        JSON.stringify({
          accessToken: "nested-access-token",
          data: [{ id: "product-1", isSale: false }],
          token: "super-secret-response-token",
        }),
      );
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
      <button onclick="document.querySelector('#count').textContent='1'">Increment</button>
      <label>Name <input aria-label="Name"></label>
      <button onclick="fetch('/api').then(r => document.querySelector('#fault').textContent=String(r.status))">Fetch API</button>
      <button onclick="fetch('/api-json').then(r => r.json()).then(() => document.querySelector('#json-status').textContent='JSON loaded')">Fetch JSON</button>
      <div id="count">0</div><div id="fault"></div><div id="json-status"></div>
      <div id="shadow-host"></div>
      <iframe src="/frame"></iframe>
      <script>
        const shadow = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
        shadow.innerHTML = '<main id="shadow-root">Shadow sale status: 已下架</main>';
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port.");
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return `http://127.0.0.1:${address.port}`;
}

describe("BrowserSessionManager E2E", () => {
  it("observes refs and operates forms, frames, tabs and network faults", async () => {
    const origin = await fixtureServer();
    const proxy = await startSsrfProxy({
      allowlist: new Set(["127.0.0.1"]),
    });
    cleanups.push(() => proxy.stop());
    const store = {
      removeSession: vi.fn().mockResolvedValue(undefined),
      replaceSession: vi.fn().mockResolvedValue(undefined),
      value: () => ({ sessions: [] }),
    };
    const manager = new BrowserSessionManager(
      store as never,
      proxy.server,
      vi.fn(),
      vi.fn(),
    );
    const sessionId = randomUUID();
    const leaseToken = randomUUID();
    const execute = async (
      commandType: Parameters<typeof manager.execute>[0]["commandType"],
      payload: Record<string, unknown>,
    ) =>
      manager.execute({
        commandId: randomUUID(),
        commandType,
        deadlineAt: new Date(Date.now() + 15_000).toISOString(),
        fencingToken: "1",
        leaseToken,
        payload,
        sessionId,
        type: "command.execute",
      });
    let closed = false;

    try {
      await execute("session.open", {
        allowedOrigins: [origin],
        profileKey: `e2e-${randomUUID()}`,
        profileMode: "EPHEMERAL",
      });
      const navigation = (await execute("page.navigate", { url: origin })) as {
        artifacts?: Array<{
          dataBase64?: string;
          kind?: string;
          metadata?: Record<string, unknown>;
        }>;
      };
      expect(navigation.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "SCREENSHOT",
            metadata: expect.objectContaining({
              captureKind: "STEP",
              commandType: "page.navigate",
              includedInVideo: true,
              stepIndex: 1,
            }),
          }),
        ]),
      );
      const observed = (await execute("page.snapshot", {
        maxChars: 64_000,
      })) as { result?: { content?: string } };
      const snapshot = observed.result?.content ?? "";
      const incrementLine = snapshot
        .split("\n")
        .find((line) => line.includes('button "Increment"'));
      const nameLine = snapshot
        .split("\n")
        .find((line) => line.includes('textbox "Name"'));
      const incrementRef = incrementLine?.match(
        /\[ref=((?:f\d+)?e\d+)\]/u,
      )?.[1];
      const nameRef = nameLine?.match(/\[ref=((?:f\d+)?e\d+)\]/u)?.[1];
      expect(incrementRef).toBeTruthy();
      expect(nameRef).toBeTruthy();

      await execute("page.click", { target: { ref: incrementRef } });
      const text = (await execute("page.get_text", {
        target: { selector: "#count" },
      })) as { result?: { content?: string } };
      expect(text.result?.content).toBe("1");
      await execute("page.fill", {
        target: { ref: nameRef },
        text: "DevProof",
      });

      const shadowSnapshot = (await execute("page.snapshot", {
        maxChars: 64_000,
        target: { selector: "#shadow-host #shadow-root" },
      })) as { result?: { content?: string } };
      expect(shadowSnapshot.result?.content).toContain("Shadow sale status");
      const dom = (await execute("page.dom", {
        maxChars: 256_000,
      })) as {
        artifacts?: Array<{
          dataBase64?: string;
          metadata?: Record<string, unknown>;
        }>;
      };
      const domBody = Buffer.from(
        dom.artifacts?.[0]?.dataBase64 ?? "",
        "base64",
      ).toString("utf8");
      expect(domBody).toContain("DEVPROOF_OPEN_SHADOW_ROOTS");
      expect(domBody).toContain("Shadow sale status: 已下架");
      expect(dom.artifacts?.[0]?.metadata).toMatchObject({
        shadowRootCount: 1,
      });

      const frame = (await execute("frame.snapshot", {
        frame: { selector: "iframe" },
      })) as { result?: { content?: string } };
      expect(frame.result?.content).toContain("Frame action");
      await execute("frame.click", {
        frame: { selector: "iframe" },
        target: { selector: "button" },
      });

      const createdTab = (await execute("tab.new", {})) as {
        result?: { tabId?: string };
      };
      const listed = (await execute("tab.list", {})) as {
        result?: { tabs?: unknown[] };
      };
      expect(listed.result?.tabs).toHaveLength(2);
      await execute("tab.close", { tabId: createdTab.result?.tabId });

      await execute("network.arm", {
        action: "FULFILL_STATUS",
        policyId: "api-503",
        status: 503,
        urlPattern: `${origin}/api`,
      });
      await execute("page.click", {
        target: { selector: "button:nth-of-type(2)" },
      });
      const hit = (await execute("network.wait_for_hit", {
        policyId: "api-503",
        timeoutMs: 5_000,
      })) as { result?: { status?: string } };
      expect(hit.result?.status).toBe("HIT");
      await execute("network.release", { policyId: "api-503" });

      await execute("page.click", {
        target: { selector: "button:nth-of-type(3)" },
      });
      await execute("page.wait", {
        kind: "text",
        text: "JSON loaded",
        timeoutMs: 5_000,
      });
      const network = (await execute("page.network", {
        includeResponseBodies: true,
        maxChars: 256_000,
        urlIncludes: "/api-json",
      })) as {
        artifacts?: Array<{
          dataBase64?: string;
          metadata?: Record<string, unknown>;
        }>;
      };
      const networkBody = Buffer.from(
        network.artifacts?.[0]?.dataBase64 ?? "",
        "base64",
      ).toString("utf8");
      expect(networkBody).toContain('"isSale":false');
      expect(networkBody).not.toContain("super-secret-response-token");
      expect(networkBody).not.toContain("nested-access-token");
      expect(networkBody).toContain("[REDACTED]");
      expect(network.artifacts?.[0]?.metadata).toMatchObject({
        responseBodyCount: 1,
        urlIncludes: "/api-json",
      });

      await execute("network.arm", {
        action: "FULFILL_STATUS",
        policyId: "api-503",
        status: 503,
        urlPattern: `${origin}/api`,
      });
      await expect(
        execute("network.wait_for_hit", {
          policyId: "api-503",
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
      await execute("network.release", { policyId: "api-503" });

      const closeResult = (await execute("session.close", {})) as {
        artifacts?: Array<{
          dataBase64?: string;
          kind?: string;
          metadata?: Record<string, unknown>;
        }>;
        result?: { stepFrameCount?: number; videoCreated?: boolean };
      };
      closed = true;
      expect(closeResult.result).toMatchObject({
        videoCreated: true,
      });
      expect(closeResult.result?.stepFrameCount).toBeGreaterThan(1);
      const video = closeResult.artifacts?.find(
        (artifact) => artifact.kind === "VIDEO",
      );
      expect(video?.dataBase64?.length).toBeGreaterThan(100);
      expect(video?.metadata).toMatchObject({
        format: "STEP_SCREENSHOT_SLIDESHOW",
      });
    } finally {
      if (!closed) await execute("session.close", {}).catch(() => undefined);
    }
  }, 45_000);

  it("uses the network policy instead of a legacy origin allowlist", async () => {
    const initialOrigin = await fixtureServer();
    const redirectedOrigin = await fixtureServer();
    const proxy = await startSsrfProxy({
      allowlist: new Set(["127.0.0.1"]),
    });
    cleanups.push(() => proxy.stop());
    const manager = new BrowserSessionManager(
      {
        removeSession: vi.fn().mockResolvedValue(undefined),
        replaceSession: vi.fn().mockResolvedValue(undefined),
        value: () => ({ sessions: [] }),
      } as never,
      proxy.server,
      vi.fn(),
      vi.fn(),
    );
    const sessionId = randomUUID();
    const leaseToken = randomUUID();
    const execute = async (
      commandType: Parameters<typeof manager.execute>[0]["commandType"],
      payload: Record<string, unknown>,
    ) =>
      manager.execute({
        commandId: randomUUID(),
        commandType,
        deadlineAt: new Date(Date.now() + 15_000).toISOString(),
        fencingToken: "1",
        leaseToken,
        payload,
        sessionId,
        type: "command.execute",
      });

    try {
      await execute("session.open", {
        allowedOrigins: [initialOrigin],
        profileKey: `cross-origin-${randomUUID()}`,
        profileMode: "EPHEMERAL",
      });
      await execute("page.navigate", { url: redirectedOrigin });

      await expect(execute("page.get_url", {})).resolves.toMatchObject({
        result: { url: `${redirectedOrigin}/` },
      });
    } finally {
      await execute("session.close", {}).catch(() => undefined);
    }
  }, 45_000);
});
