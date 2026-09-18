import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSessionManager } from "./index.js";
import type { RuntimeSessionPermit } from "@devproof/runtime-protocol";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { afterEach, expect, it, vi } from "vitest";
import {
  uploadSnapshot,
  encryptSnapshot,
  downloadSnapshot,
  verifyPortableSnapshot,
} from "./distributed-auth-snapshots.js";
afterEach(() => vi.unstubAllEnvs());
it("transfers encrypted login state to a separate browser and keeps execution mutations isolated", async () => {
  vi.stubEnv("DEVPROOF_AUTH_SNAPSHOT_KEY", randomBytes(32).toString("base64"));
  const root = await mkdtemp(join(tmpdir(), "devproof-portable-"));
  let encrypted = "";
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/runtime/")) {
      if (request.headers.authorization !== "Bearer runtime-token") {
        response.writeHead(403).end();
        return;
      }
      if (request.method === "POST") {
        const parts = [];
        for await (const part of request) parts.push(Buffer.from(part));
        encrypted = JSON.parse(Buffer.concat(parts).toString()).envelope;
        response.end("{}");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          envelope: encrypted,
          profileKey: "site-a",
          generation: 1,
        }),
      );
      return;
    }
    if (
      request.url === "/protected" &&
      !request.headers.cookie?.includes("auth=alice")
    ) {
      response.writeHead(302, { location: "/login" }).end();
      return;
    }
    if (request.url === "/login")
      response.setHeader("set-cookie", "auth=alice; Path=/");
    response.setHeader("content-type", "text/html");
    response.end('<div id="account">Alice</div>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const source = await chromium.launch({ channel: "chromium", headless: true });
  const destination = await chromium.launch({
    channel: "chromium",
    headless: true,
  });
  try {
    const original = await source.newContext();
    const login = await original.newPage();
    await login.goto(`${origin}/login`);
    await login.evaluate(() => localStorage.setItem("token", "source-token"));
    const reference = { profileKey: "site-a", generation: 1 };
    const sourceNode = {
      apiUrl: origin,
      runtimeId: randomUUID(),
      runtimeToken: "runtime-token",
    };
    await uploadSnapshot(
      sourceNode,
      randomUUID(),
      reference,
      {
        state: await original.storageState({ indexedDB: true }),
        verification: {
          url: `${origin}/protected`,
          loginUrlPatterns: ["*/login*"],
          authenticatedSelector: "#account",
        },
      },
      root,
    );
    expect(encrypted).not.toContain("alice");
    expect(encrypted).not.toContain("source-token");
    const copied = await downloadSnapshot(
      { ...sourceNode, runtimeId: randomUUID() },
      randomUUID(),
      reference,
    );
    const isolated = await destination.newContext({
      storageState: copied.state,
    });
    const page = await isolated.newPage();
    await verifyPortableSnapshot(page, copied.verification);
    expect(await page.evaluate(() => localStorage.getItem("token"))).toBe(
      "source-token",
    );
    await page.evaluate(() => localStorage.setItem("token", "task-mutation"));
    expect(await login.evaluate(() => localStorage.getItem("token"))).toBe(
      "source-token",
    );
    const next = await destination.newContext({
      storageState: (
        await downloadSnapshot(sourceNode, randomUUID(), reference)
      ).state,
    });
    const nextPage = await next.newPage();
    await nextPage.goto(`${origin}/protected`);
    expect(await nextPage.evaluate(() => localStorage.getItem("token"))).toBe(
      "source-token",
    );
  } finally {
    await Promise.all([source.close(), destination.close()]);
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30_000);

it.each([true, false])(
  "verifies portable login only after STARTUP receives an execution permit (valid=%s)",
  async (valid) => {
    const secret = randomBytes(32).toString("base64");
    vi.stubEnv("DEVPROOF_AUTH_SNAPSHOT_KEY", secret);
    const root = await mkdtemp(join(tmpdir(), "devproof-portable-permit-"));
    const visits: string[] = [];
    let envelope = "";
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/runtime/")) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ envelope, profileKey: "source", generation: 1 }),
        );
        return;
      }
      visits.push(request.url!);
      if (
        request.url === "/protected" &&
        !request.headers.cookie?.includes("auth=alice")
      ) {
        response.writeHead(302, { location: "/login" }).end();
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end('<div id="account">Alice</div>');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    envelope = encryptSnapshot(
      {
        state: {
          cookies: valid
            ? [
                {
                  name: "auth",
                  value: "alice",
                  domain: "127.0.0.1",
                  path: "/",
                  expires: -1,
                  httpOnly: true,
                  secure: false,
                  sameSite: "Lax",
                },
              ]
            : [],
          origins: [],
        },
        verification: {
          url: `${origin}/protected`,
          loginUrlPatterns: ["*/login*"],
          authenticatedSelector: "#account",
        },
      },
      { profileKey: "source", generation: 1 },
      secret,
    );
    const state = {
      apiUrl: origin,
      runtimeId: randomUUID(),
      runtimeToken: "token",
      sessions: [] as any[],
      revokedSessionIds: [] as string[],
    };
    const store = {
      value: () => state,
      replaceSession: async (session: any) => {
        state.sessions = [
          ...state.sessions.filter((s) => s.sessionId !== session.sessionId),
          session,
        ];
      },
      removeSession: async (id: string) => {
        state.sessions = state.sessions.filter((s) => s.sessionId !== id);
      },
      revokeSession: async (id: string) => {
        state.revokedSessionIds.push(id);
      },
    };
    const manager = new BrowserSessionManager(
      store as never,
      "http://127.0.0.1:1",
      () => {},
      () => {},
      () => {},
      undefined,
      {
        profileRoot: root,
        requirePermits: true,
        networkAllowlist: new Set(["127.0.0.1"]),
      },
    );
    const startup: RuntimeSessionPermit = {
      sessionId: randomUUID(),
      fencingToken: "1",
      leaseToken: randomUUID(),
      ownerKind: "STARTUP",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const agent: RuntimeSessionPermit = {
      ...startup,
      ownerKind: "AGENT",
      ownerTaskId: randomUUID(),
      ownerFencingToken: "1",
    };
    const execute = (
      permit: RuntimeSessionPermit,
      commandType: "session.open" | "page.navigate" | "page.get_url",
      payload: Record<string, unknown>,
    ) =>
      manager.execute({
        ...permit,
        permit,
        commandId: randomUUID(),
        commandType,
        payload,
        type: "command.execute",
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      });
    try {
      await execute(startup, "session.open", {
        profileKey: "execution",
        profileMode: "EPHEMERAL",
        authSnapshot: {
          profileKey: "source",
          generation: 1,
          distributed: true,
        },
      });
      expect(visits).toEqual([]);
      await expect(
        execute(startup, "page.navigate", { url: `${origin}/business` }),
      ).rejects.toMatchObject({ code: "SESSION_PERMIT_EXPIRED" });
      expect(visits).toEqual([]);
      const action = () =>
        execute(agent, "page.navigate", { url: `${origin}/business` });
      if (valid) {
        // Concurrent first commands must share one validation navigation.
        await Promise.all([
          execute(agent, "page.get_url", {}),
          execute(agent, "page.get_url", {}),
        ]);
        await action();
        expect(visits.indexOf("/protected")).toBeLessThan(
          visits.indexOf("/business"),
        );
        expect(visits).toContain("/business");
        await action();
        expect(visits.filter((v) => v === "/protected")).toHaveLength(1);
      } else {
        await expect(action()).rejects.toMatchObject({
          code: "AUTH_SNAPSHOT_INCOMPATIBLE",
        });
        await expect(action()).rejects.toMatchObject({
          code: "AUTH_SNAPSHOT_INCOMPATIBLE",
        });
        expect(visits).not.toContain("/business");
        expect(visits.filter((v) => v === "/protected")).toHaveLength(1);
      }
    } finally {
      await Promise.all(
        manager.descriptors().map((s) => manager.close(s.sessionId)),
      );
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
