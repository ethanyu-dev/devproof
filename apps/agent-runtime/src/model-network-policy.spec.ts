import { createServer, type Server } from "node:http";

import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createModelFetch,
  isBlockedModelIp,
  parseModelHostAllowlist,
  resolveModelAddress,
} from "./model-network-policy.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("Agent model network policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("blocks non-public address %s", (address) => {
    expect(isBlockedModelIp(address)).toBe(true);
  });

  it("rejects every DNS answer when any resolved address is private", async () => {
    const addressLookup = vi.fn().mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);

    await expect(
      resolveModelAddress("gateway.example.com", new Set(), addressLookup),
    ).rejects.toThrow(/blocked by Runtime network policy/u);
  });

  it("blocks loopback before an API key reaches it", async () => {
    const received = vi.fn();
    const port = await localServer((authorization) => received(authorization));
    const client = new OpenAI({
      apiKey: "sk-secret",
      baseURL: `http://127.0.0.1:${port}/v1`,
      fetch: createModelFetch(),
      maxRetries: 0,
    });

    await expect(
      client.responses.create({ input: "test", model: "gpt-test" }),
    ).rejects.toThrow();
    expect(received).not.toHaveBeenCalled();
  });

  it("supports an explicitly approved internal model gateway", async () => {
    const received = vi.fn();
    const port = await localServer((authorization) => received(authorization));
    const allowlist = parseModelHostAllowlist("127.0.0.1");

    const response = await createModelFetch(allowlist)(
      `http://127.0.0.1:${port}/v1/responses`,
      {
        body: "{}",
        headers: { authorization: "Bearer sk-approved" },
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect(received).toHaveBeenCalledWith("Bearer sk-approved");
  });

  it("never follows redirects with an Authorization header", async () => {
    const redirected = vi.fn();
    const destinationPort = await localServer((authorization) =>
      redirected(authorization),
    );
    const source = createServer((_request, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${destinationPort}/stolen`,
      });
      response.end();
    });
    servers.push(source);
    const sourcePort = await listen(source);

    await expect(
      createModelFetch(new Set(["127.0.0.1"]))(
        `http://127.0.0.1:${sourcePort}/v1/responses`,
        {
          headers: { authorization: "Bearer sk-secret" },
          method: "POST",
        },
      ),
    ).rejects.toThrow(/redirects are not allowed/u);
    expect(redirected).not.toHaveBeenCalled();
  });
});

async function localServer(
  onRequest: (authorization: string | undefined) => void,
): Promise<number> {
  const server = createServer((request, response) => {
    onRequest(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  servers.push(server);
  return listen(server);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port.");
  return address.port;
}
