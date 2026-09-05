import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  browserProcessMarker,
  captureBrowserProcessScope,
  closeBrowserProcessScope,
  closeOrphanBrowser,
  discoverBrowserProcess,
} from "./browser-processes.js";

async function processTree() {
  const id = randomUUID();
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    process.stdout.write(String(child.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `,
      "--",
      browserProcessMarker(id),
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const [output] = await once(leader.stdout!, "data");
  return { id, leader, childPid: Number(String(output)) };
}

async function stop(leader: ChildProcess, childPid: number) {
  for (const pid of [leader.pid, childPid])
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already terminated */
      }
    }
  if (leader.exitCode === null && leader.signalCode === null)
    await once(leader, "exit");
}

describe("browser process scope closure", () => {
  it("terminates captured descendants even after their marked leader exits", async () => {
    const { id, leader, childPid } = await processTree();
    try {
      const scope = await captureBrowserProcessScope(browserProcessMarker(id));
      expect(scope.processes.map((row) => row.pid)).toContain(childPid);
      const exited = once(leader, "exit");
      leader.kill("SIGKILL");
      await exited;
      await closeBrowserProcessScope(scope);
      expect(await discoverBrowserProcess(id)).toBeNull();
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      await stop(leader, childPid);
    }
  }, 15_000);

  it("does not treat an unmarked surviving process group as empty after restart", async () => {
    const { id, leader, childPid } = await processTree();
    try {
      const identity = await discoverBrowserProcess(id);
      expect(identity?.processGroupId).toBe(leader.pid);
      const exited = once(leader, "exit");
      leader.kill("SIGKILL");
      await exited;
      await expect(closeOrphanBrowser(identity!)).rejects.toMatchObject({
        code: "CLOSURE_UNVERIFIED",
      });
      expect(() => process.kill(childPid, 0)).not.toThrow();
    } finally {
      await stop(leader, childPid);
    }
  }, 15_000);
});
