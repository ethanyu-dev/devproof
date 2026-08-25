import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  isProcessTreeRunning,
  signalProcessTree,
  waitForProcessTrees,
} from "./dev-process-tree.mjs";

test(
  "cleans descendants after the direct child exits",
  { skip: process.platform === "win32" },
  async () => {
    const stubbornChild = [
      'process.on("SIGTERM", () => {});',
      'process.stdout.write("ready\\n");',
      "setInterval(() => {}, 1_000);",
    ].join("");
    const leaderScript = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(stubbornChild)}], { stdio: ["ignore", "pipe", "ignore"] });`,
      "child.stdout.pipe(process.stdout);",
      "setInterval(() => {}, 1_000);",
    ].join("");
    const leader = spawn(process.execPath, ["-e", leaderScript], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });

    try {
      await Promise.race([
        once(leader.stdout, "data"),
        rejectAfter(2_000, "Nested process did not become ready."),
      ]);
      signalProcessTree(leader, "SIGTERM", true);
      await Promise.race([
        once(leader, "exit"),
        rejectAfter(2_000, "Direct child did not exit after SIGTERM."),
      ]);

      assert.equal(leader.signalCode, "SIGTERM");
      assert.equal(isProcessTreeRunning(leader, true), true);

      signalProcessTree(leader, "SIGKILL", true);
      await waitForProcessTrees([leader], 2_000, true);
      assert.equal(isProcessTreeRunning(leader, true), false);
    } finally {
      signalProcessTree(leader, "SIGKILL", true);
    }
  },
);

function rejectAfter(milliseconds, message) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(message)), milliseconds),
  );
}
