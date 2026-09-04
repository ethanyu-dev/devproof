import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RuntimeCommand,
  RuntimeSessionPermit,
} from "@devproof/runtime-protocol";
import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { BrowserSessionManager } from "./index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "devproof-control-"));
  const state = {
    sessions: [] as Array<Record<string, unknown>>,
    revokedSessionIds: [] as string[],
  };
  const store = {
    value: () => state,
    replaceSession: async (row: Record<string, unknown>) => {
      state.sessions = [
        ...state.sessions.filter((item) => item.sessionId !== row.sessionId),
        row,
      ];
    },
    removeSession: async (id: string) => {
      state.sessions = state.sessions.filter((item) => item.sessionId !== id);
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
    { profileRoot: root, requirePermits: true },
  );
  const agent: RuntimeSessionPermit = {
    sessionId: randomUUID(),
    leaseToken: randomUUID(),
    fencingToken: "1",
    ownerKind: "AGENT",
    ownerTaskId: randomUUID(),
    ownerFencingToken: "1",
    controlGeneration: 0,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const execute = (
    commandType: RuntimeCommand["commandType"],
    permit = agent,
    payload: Record<string, unknown> = {},
  ) =>
    manager.execute({
      type: "command.execute",
      commandId: randomUUID(),
      commandType,
      sessionId: agent.sessionId,
      leaseToken: agent.leaseToken,
      fencingToken: agent.fencingToken,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      permit,
      payload,
    } as RuntimeCommand);
  const close = async () => {
    await manager.close(agent.sessionId);
    await rm(root, { force: true, recursive: true });
  };
  try {
    await execute("session.open", agent, {
      profileKey: `control-${agent.sessionId}`,
      profileMode: "EPHEMERAL",
    });
  } catch (error) {
    await close();
    throw error;
  }
  return { manager, agent, execute, close, state };
}

describe("Chromium control and permit renewal", () => {
  it("resumes the same Agent after human release and rejects delayed commands from previous controls", async () => {
    const { manager, agent, execute, close, state } = await fixture();
    try {
      const human = {
        ...agent,
        ownerKind: "HUMAN" as const,
        controlGeneration: 1,
      };
      await execute("human.takeover", human, {
        controllerUserId: randomUUID(),
        expiresAt: human.expiresAt,
      });
      await expect(execute("page.get_url", agent)).rejects.toMatchObject({
        code: "SESSION_PERMIT_EXPIRED",
      });
      await execute("human.release", human);
      const resumed = { ...agent, controlGeneration: 2 };
      await expect(execute("page.get_url", resumed)).resolves.toMatchObject({
        result: { url: "about:blank" },
      });
      await expect(
        execute("human.takeover", human, {
          controllerUserId: randomUUID(),
          expiresAt: human.expiresAt,
        }),
      ).rejects.toMatchObject({ code: "SESSION_PERMIT_EXPIRED" });
      await expect(execute("page.get_url", agent)).rejects.toMatchObject({
        code: "SESSION_PERMIT_EXPIRED",
      });
      await expect(execute("page.get_url", resumed)).resolves.toMatchObject({
        result: { url: "about:blank" },
      });
      expect(manager.descriptors()).toHaveLength(1);
      expect(state.revokedSessionIds).toEqual([]);
    } finally {
      await close();
    }
  }, 30_000);

  it("rejects delayed input from an earlier human cycle while accepting the current controller", async () => {
    const { manager, agent, execute, close } = await fixture();
    try {
      const human = {
        ...agent,
        ownerKind: "HUMAN" as const,
        controlGeneration: 1,
      };
      await execute("human.takeover", human, {
        controllerUserId: randomUUID(),
        expiresAt: human.expiresAt,
      });
      await execute("human.release", human);
      await execute("page.get_url", { ...agent, controlGeneration: 2 });
      const current = { ...human, controlGeneration: 3 };
      await execute("human.takeover", current, {
        controllerUserId: randomUUID(),
        expiresAt: current.expiresAt,
      });
      const page = (
        manager as unknown as { sessions: Map<string, { page: Page }> }
      ).sessions.get(agent.sessionId)!.page;
      await page.setContent("<textarea></textarea>");
      await page.locator("textarea").focus();
      const input = {
        type: "human.input.dispatch" as const,
        dispatchId: randomUUID(),
        sessionId: agent.sessionId,
        fencingToken: agent.fencingToken,
        leaseToken: agent.leaseToken,
        events: [{ type: "text" as const, text: "current controller" }],
      };
      await expect(
        manager.humanInput({ ...input, controlGeneration: 1 }),
      ).rejects.toMatchObject({ code: "SESSION_PERMIT_EXPIRED" });
      // Missing generations represent the original cycle, never the current one.
      await expect(manager.humanInput(input)).rejects.toMatchObject({
        code: "SESSION_PERMIT_EXPIRED",
      });
      expect(await page.locator("textarea").inputValue()).toBe("");
      await expect(
        manager.humanInput({ ...input, controlGeneration: 3 }),
      ).resolves.toBeUndefined();
      expect(await page.locator("textarea").inputValue()).toBe(
        "current controller",
      );
    } finally {
      await close();
    }
  }, 30_000);

  it("keeps Chromium alive when an expired command permit arrives after its renewal", async () => {
    const { manager, agent, execute, close, state } = await fixture();
    try {
      // Both snapshots were issued for this live owner; the shorter one was delayed in transport.
      const stale = {
        ...agent,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      };
      const renewed = {
        ...agent,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      };
      manager.acceptSessionPermits([renewed], new Date().toISOString());
      await expect(execute("page.get_url", stale)).resolves.toMatchObject({
        result: { url: "about:blank" },
      });
      // Allow the real watchdog to run, then prove the browser still executes commands.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await expect(execute("page.get_url", renewed)).resolves.toMatchObject({
        result: { url: "about:blank" },
      });
      expect(manager.descriptors()).toHaveLength(1);
      expect(state.revokedSessionIds).toEqual([]);
    } finally {
      await close();
    }
  }, 30_000);
});
