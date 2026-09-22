import { expect, it, vi } from "vitest";
import { hasObservedInitialNavigation } from "./session-navigation-outcome.js";
import { initialWriteState } from "./session-recovery.state.js";

function fixture() {
  const session = {
    id: "session",
    purpose: "EXECUTION",
    protocolMinor: 21,
    controlGeneration: 0,
    leaseToken: "lease",
    fencingToken: 2n,
    ownerTaskId: "owner",
    ownerFencingToken: 3n,
  };
  const url = "https://fixture.test/page";
  const base = {
    leaseToken: "lease",
    fencingToken: 2n,
    ownerTaskId: "owner",
    ownerFencingToken: 3n,
    source: "AGENT",
    payload: {},
    result: {},
    createdAt: new Date(0),
    deadlineAt: new Date(1000),
    completedAt: new Date(1001),
  };
  const commands = [
    {
      ...base,
      source: "SYSTEM",
      commandType: "session.open",
      status: "SUCCEEDED",
      result: { url: "about:blank" },
    },
    {
      ...base,
      commandType: "page.navigate",
      status: "TIMED_OUT",
      payload: { url },
    },
    {
      ...base,
      commandType: "page.snapshot",
      status: "SUCCEEDED",
      createdAt: new Date(1002),
      result: {
        url,
        structuredObservation: { pageIdentity: url, consistency: "VERIFIED" },
      },
    },
  ];
  const owner = {
    fencingToken: 3n,
    status: "SUCCEEDED",
    completionId: "completed",
    result: { kind: "VERIFICATION_COMPLETED", verdict: "PASSED" },
  };
  const tx = {
    agentRuntimeTask: { findUnique: vi.fn(async () => owner) },
    executionResourceLease: {
      findMany: vi.fn(async () => [{ mode: "WRITE" }]),
    },
    browserRuntimeCommand: {
      findMany: vi.fn(async () => commands),
      count: vi.fn(async () => 1),
    },
  };
  return {
    session,
    commands,
    owner,
    tx,
    check: () => hasObservedInitialNavigation(tx as never, session as never),
    state: () => initialWriteState(tx as never, session as never),
  };
}

it("settles an initial load timeout only together with a conclusive matching owner result", async () => {
  const f = fixture();
  expect(await f.check()).toBe(true);
  expect(await f.state()).toBe("CONFIRMED");
  f.owner.result.verdict = "INCONCLUSIVE";
  expect(await f.state()).toBe("UNKNOWN");
});

it.each([
  "another write",
  "another epoch",
  "another owner",
  "another URL",
  "unverified",
  "early",
  "pending",
  "human",
  "not blank",
  "other navigation",
])("does not settle navigation from %s", async (reason) => {
  const f = fixture();
  if (reason === "another write") f.commands[1]!.commandType = "page.click";
  if (reason === "another epoch") f.commands[2]!.fencingToken = 4n;
  if (reason === "another owner") f.commands[2]!.ownerTaskId = "other";
  if (reason === "another URL")
    f.commands[2]!.result.url = "https://other.test";
  if (reason === "unverified")
    f.commands[2]!.result.structuredObservation!.consistency = "UNVERIFIED";
  if (reason === "early") f.commands[2]!.createdAt = new Date(999);
  if (reason === "pending") f.commands[1]!.status = "DISPATCHED";
  if (reason === "human") f.session.controlGeneration = 1;
  if (reason === "not blank") f.commands[0]!.result.url = "https://other.test";
  if (reason === "other navigation")
    f.commands[2]!.commandType = "page.navigate";
  expect(await f.check()).toBe(false);
  expect(await f.state()).toBe("UNKNOWN");
});

it("keeps the guard if a later mutating command also failed", async () => {
  const f = fixture();
  f.tx.browserRuntimeCommand.count.mockResolvedValue(2);
  expect(await f.state()).toBe("UNKNOWN");
  expect(f.tx.browserRuntimeCommand.findMany).not.toHaveBeenCalled();
});
