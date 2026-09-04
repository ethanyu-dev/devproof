import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeSessionPermit } from "@devproof/runtime-protocol";
import type { BrowserContext } from "playwright";
import { describe, expect, it } from "vitest";
import { BrowserSessionManager } from "./index.js";
import { readAuthSnapshot } from "./auth-snapshots.js";

describe("authenticated isolated browser sessions", () => {
  it("reuses one login across four independent contexts and protects the source snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "devproof-auth-context-"));
    const server = createServer((request, response) => {
      if (
        request.url === "/protected" &&
        !request.headers.cookie?.includes("identity=alice")
      ) {
        response.writeHead(302, { location: "/login" }).end();
        return;
      }
      if (request.url === "/login")
        response.setHeader("set-cookie", "identity=alice; Path=/");
      response.setHeader("content-type", "text/html");
      response.end(`<div id="ready">authenticated</div><script>
        ${request.url === "/login" ? "localStorage.setItem('identity','alice');" : ""}
        const open = indexedDB.open('auth',1);
        open.onupgradeneeded=()=>open.result.createObjectStore('tokens');
        open.onsuccess=()=>{const tx=open.result.transaction('tokens','readwrite');
          ${request.url === "/login" ? "tx.objectStore('tokens').put('alice','identity');" : ""}
          tx.oncomplete=()=>{document.body.dataset.loaded='yes';open.result.close();};};
      </script>`);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test server port.");
    const origin = `http://127.0.0.1:${address.port}`;
    const state: {
      sessions: Array<Record<string, unknown>>;
      revokedSessionIds: string[];
    } = { sessions: [], revokedSessionIds: [] };
    const store = {
      value: () => state,
      replaceSession: async (session: Record<string, unknown>) => {
        state.sessions = [
          ...state.sessions.filter(
            (row) => row.sessionId !== session.sessionId,
          ),
          session,
        ];
      },
      removeSession: async (id: string) => {
        state.sessions = state.sessions.filter((row) => row.sessionId !== id);
      },
      revokeSession: async (id: string) => {
        state.revokedSessionIds.push(id);
      },
    };
    const manager = new BrowserSessionManager(
      store as never,
      "http://127.0.0.1:1",
      () => undefined,
      () => undefined,
      () => undefined,
      undefined,
      {
        profileRoot: root,
        requirePermits: true,
        networkAllowlist: new Set(["127.0.0.1"]),
      },
    );
    const leases: RuntimeSessionPermit[] = [];
    const lease = (ownerKind: "SYSTEM" | "AGENT"): RuntimeSessionPermit => {
      const permit: RuntimeSessionPermit = {
        sessionId: randomUUID(),
        fencingToken: String(leases.length + 1),
        leaseToken: randomUUID(),
        ownerKind,
        expiresAt: new Date(Date.now() + 180_000).toISOString(),
        ...(ownerKind === "AGENT"
          ? { ownerTaskId: randomUUID(), ownerFencingToken: "1" }
          : {}),
      };
      leases.push(permit);
      return permit;
    };
    const execute = (
      permit: RuntimeSessionPermit,
      commandType: Parameters<typeof manager.execute>[0]["commandType"],
      payload: Record<string, unknown>,
    ) =>
      manager.execute({
        commandId: randomUUID(),
        commandType,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        fencingToken: permit.fencingToken,
        leaseToken: permit.leaseToken,
        sessionId: permit.sessionId,
        ownerTaskId: permit.ownerTaskId,
        ownerFencingToken: permit.ownerFencingToken,
        permit,
        payload,
        type: "command.execute",
      });
    try {
      const preparation = lease("SYSTEM");
      await execute(preparation, "session.open", {
        profileKey: "source",
        profileMode: "PERSISTENT",
        profileRetention: { kind: "USER", inactivityTtlSeconds: 2_592_000 },
      });
      await execute(preparation, "page.navigate", { url: `${origin}/login` });
      const live = Reflect.get(manager, "sessions") as Map<
        string,
        { context: BrowserContext }
      >;
      await live
        .get(preparation.sessionId)!
        .context.pages()[0]!
        .waitForSelector('body[data-loaded="yes"]');
      const published = await execute(preparation, "profile.snapshot", {
        profileKey: "source",
        generation: 1,
        probeConcurrency: 4,
        verification: {
          url: `${origin}/protected`,
          authenticatedSelector: "#ready",
          loginUrlPatterns: [`${origin}/login*`],
        },
      });
      expect(published).toMatchObject({
        result: { generation: 1, verifiedConcurrency: 4 },
      });
      expect(JSON.stringify(published)).not.toContain("alice");
      await manager.close(preparation.sessionId);
      const workers = Array.from({ length: 4 }, () => lease("AGENT"));
      await Promise.all(
        workers.map(async (permit) => {
          await execute(permit, "session.open", {
            profileKey: `execution-${permit.sessionId}`,
            profileMode: "EPHEMERAL",
            authSnapshot: { profileKey: "source", generation: 1 },
          });
          await execute(permit, "page.navigate", {
            url: `${origin}/protected`,
          });
        }),
      );
      expect(manager.descriptors()).toHaveLength(4);
      const contexts = workers.map(
        (permit) => live.get(permit.sessionId)!.context,
      );
      expect(
        await contexts[0]!
          .pages()[0]!
          .evaluate(() => localStorage.getItem("identity")),
      ).toBe("alice");
      await contexts[0]!.pages()[0]!.evaluate(() => {
        localStorage.setItem("identity", "changed");
        document.cookie = "identity=changed; Path=/";
      });
      for (const context of contexts.slice(1)) {
        expect(
          await context
            .pages()[0]!
            .evaluate(() => localStorage.getItem("identity")),
        ).toBe("alice");
        expect(
          (await context.cookies()).find((cookie) => cookie.name === "identity")
            ?.value,
        ).toBe("alice");
      }
      const stored = await readAuthSnapshot(root, {
        profileKey: "source",
        generation: 1,
      });
      expect(
        stored.state.cookies.find((cookie) => cookie.name === "identity")
          ?.value,
      ).toBe("alice");
      expect(stored.state.origins[0]?.indexedDB?.[0]?.name).toBe("auth");
      await expect(
        execute(workers[1]!, "profile.purge", { profileKey: "source" }),
      ).rejects.toMatchObject({ code: "PROFILE_IN_USE" });
      manager.disconnect();
      await expect(
        execute(workers[1]!, "page.navigate", { url: `${origin}/protected` }),
      ).rejects.toMatchObject({ code: "SESSION_PERMIT_EXPIRED" });
    } finally {
      await Promise.all(
        manager
          .descriptors()
          .map((session) => manager.close(session.sessionId)),
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
