import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { startTypeScriptDev } from "./dev-typescript.mjs";

test("starts the runtime only after a successful watcher build, including split output", () => {
  const calls = [];
  const exits = [];
  const launch = (...args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    calls.push({ args, child });
    return child;
  };
  const stop = startTypeScriptDev({
    launch,
    compilerFile: "tsc.js",
    output: { write() {} },
    finish: (code) => exits.push(code),
  });
  const compiler = calls[0].child;
  compiler.stdout.emit("data", "Found 2 errors. Watching for file changes.\n");
  assert.equal(calls.length, 1);
  compiler.stdout.emit("data", "Found 0 errors. Watching for file");
  assert.equal(calls.length, 1);
  compiler.stdout.emit("data", " changes.\n");
  assert.equal(calls.length, 2);
  compiler.stdout.emit("data", "Found 0 errors. Watching for file changes.\n");
  assert.equal(calls.length, 2);
  calls[1].child.emit("exit", 1);
  stop();
  assert.deepEqual(exits, [1]);
  assert.ok(calls.every(({ child }) => child.killed));
});
