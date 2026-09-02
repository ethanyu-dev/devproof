import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeEventSchema } from "@devproof/runtime-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  persistRuntimeDiagnosticEvent,
  readPendingRuntimeDiagnosticEvents,
  removePendingRuntimeDiagnosticEvent,
} from "./index.js";

const roots: string[] = [];

function diagnostic(timestamp: string) {
  return runtimeEventSchema.parse({
    eventId: randomUUID(),
    fencingToken: "7",
    kind: "VIDEO_FINALIZATION_FAILED",
    leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
    payload: {
      attempts: [],
      code: "VIDEO_COMPOSITION_FAILED",
      commandId: randomUUID(),
      durationMs: 421,
      frameCount: 21,
      message: "Step video composition failed for every encoding profile.",
      runtimeVersion: "0.2.16",
    },
    sessionId: "11bb7c5c-cd52-4ae7-8759-6e4e1391357d",
    timestamp,
    type: "runtime.event",
  }) as ReturnType<typeof runtimeEventSchema.parse> & {
    kind: "VIDEO_FINALIZATION_FAILED";
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Runtime diagnostic spool", () => {
  it("persists diagnostics until acknowledgement", async () => {
    const root = await mkdtemp(join(tmpdir(), "devproof-diagnostic-"));
    roots.push(root);
    const event = diagnostic(new Date().toISOString());

    await persistRuntimeDiagnosticEvent(root, event);
    expect(await readPendingRuntimeDiagnosticEvents(root)).toEqual([event]);

    await removePendingRuntimeDiagnosticEvent(root, event.eventId);
    expect(await readPendingRuntimeDiagnosticEvents(root)).toEqual([]);
  });

  it("discards diagnostics after the bounded retention period", async () => {
    const root = await mkdtemp(join(tmpdir(), "devproof-diagnostic-"));
    roots.push(root);
    const now = new Date("2026-09-02T08:00:00.000Z");
    const event = diagnostic("2026-08-20T08:00:00.000Z");

    await persistRuntimeDiagnosticEvent(root, event);

    expect(await readPendingRuntimeDiagnosticEvents(root, now)).toEqual([]);
  });

  it("keeps only the newest 64 diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "devproof-diagnostic-"));
    roots.push(root);
    const events = Array.from({ length: 65 }, (_value, index) =>
      diagnostic(new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString()),
    );

    for (const event of events) {
      await persistRuntimeDiagnosticEvent(root, event);
    }

    const pending = await readPendingRuntimeDiagnosticEvents(
      root,
      new Date("2026-09-02T08:00:00.000Z"),
    );
    expect(pending).toHaveLength(64);
    expect(pending[0]?.eventId).toBe(events[1]?.eventId);
    expect(pending.at(-1)?.eventId).toBe(events.at(-1)?.eventId);
  });
});
