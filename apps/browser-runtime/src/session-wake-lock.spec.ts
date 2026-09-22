import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SessionWakeLock } from "./session-wake-lock.js";

function fixture(platform: NodeJS.Platform = "darwin") {
  const children: (EventEmitter & { kill: ReturnType<typeof vi.fn> })[] = [];
  const launch = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    children.push(child);
    return child;
  });
  const warn = vi.fn();
  return {
    children,
    launch,
    warn,
    lock: new SessionWakeLock(warn, platform, launch),
  };
}

describe("session sleep inhibition", () => {
  it("shares one assertion across concurrent sessions and releases only after the last closes", () => {
    const f = fixture();
    f.lock.acquire("a");
    f.lock.acquire("a");
    f.lock.acquire("b");
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.lock.release("a");
    f.lock.release("a");
    expect(f.children[0]!.kill).not.toHaveBeenCalled();
    f.lock.release("b");
    expect(f.children[0]!.kill).toHaveBeenCalledOnce();
    f.children[0]!.emit("exit", null, "SIGTERM");
    expect(f.warn).not.toHaveBeenCalled();
    f.lock.acquire("c");
    expect(f.launch).toHaveBeenCalledTimes(2);
    f.lock.release("c");
  });
  it("reports failure without rejecting browser work and can reacquire", () => {
    const f = fixture();
    f.lock.acquire("a");
    f.children[0]!.emit("error", new Error("spawn failed"));
    expect(f.warn).toHaveBeenCalledOnce();
    f.lock.acquire("b");
    expect(f.launch).toHaveBeenCalledTimes(2);
    f.children[0]!.emit("exit", 1);
    f.lock.release("b");
    expect(f.children[1]!.kill).not.toHaveBeenCalled();
    f.lock.release("a");
    expect(f.children[1]!.kill).toHaveBeenCalledOnce();
  });
  it("does not invoke macOS power commands on other platforms", () => {
    const f = fixture("linux");
    f.lock.acquire("a");
    f.lock.release("a");
    expect(f.launch).not.toHaveBeenCalled();
  });
});
