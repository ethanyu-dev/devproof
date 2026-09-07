import { describe, expect, it } from "vitest";
import {
  runtimeRecoveryQuerySchema,
  runtimeDrainAttestSchema,
  runtimeDrainResumeSchema,
  runtimeRecoveryResolveWriteOutcomeSchema,
} from "./runtime-recovery.js";

const evidence = {
  idempotencyKey: "385146a8-5230-4b02-832a-5eef19e8dc8a",
  note: "Inspected the original workload and its audit trail.",
  evidenceRefs: ["operations://incident/123"],
};
describe("recovery requests", () => {
  it("requires current drain evidence and preserved storage for recovery tickets", () => {
    const valid = {
      snapshotDigest: "current-drain",
      note: evidence.note,
      evidenceRefs: evidence.evidenceRefs,
      profileStoragePreserved: true,
    };
    expect(runtimeDrainResumeSchema.safeParse(valid).success).toBe(true);
    for (const change of [
      { profileStoragePreserved: false },
      { evidenceRefs: [] },
      { snapshotDigest: "" },
      { note: "" },
      { runtimeId: "unbound-override" },
    ])
      expect(
        runtimeDrainResumeSchema.safeParse({ ...valid, ...change }).success,
      ).toBe(false);
  });
  it("requires explicit infrastructure termination and evidence for admin attestation", () => {
    expect(
      runtimeDrainAttestSchema.safeParse({
        ...evidence,
        snapshotDigest: "snapshot",
        infrastructureTerminated: true,
      }).success,
    ).toBe(true);
    expect(
      runtimeDrainAttestSchema.safeParse({
        ...evidence,
        snapshotDigest: "snapshot",
        infrastructureTerminated: false,
      }).success,
    ).toBe(false);
    expect(
      runtimeDrainAttestSchema.safeParse({
        ...evidence,
        snapshotDigest: "snapshot",
        infrastructureTerminated: true,
        evidenceRefs: [],
      }).success,
    ).toBe(false);
  });
  it("requires a versioned business outcome independently from closure", () => {
    expect(
      runtimeRecoveryResolveWriteOutcomeSchema.safeParse({
        ...evidence,
        expectedVersion: 1,
        outcome: "VERIFIED",
      }).success,
    ).toBe(true);
    expect(
      runtimeRecoveryResolveWriteOutcomeSchema.safeParse({
        ...evidence,
        outcome: "VERIFIED",
      }).success,
    ).toBe(false);
    expect(
      runtimeRecoveryResolveWriteOutcomeSchema.safeParse({
        ...evidence,
        expectedVersion: 1,
        outcome: "CLOSED",
      }).success,
    ).toBe(false);
  });
});

describe("recovery list queries", () => {
  it("accepts combined closure and business filters with bounded pages", () => {
    expect(
      runtimeRecoveryQuerySchema.parse({
        view: "pending",
        state: "VERIFIED",
        writeState: "UNKNOWN",
        limit: "10",
      }),
    ).toEqual({
      view: "pending",
      state: "VERIFIED",
      writeState: "UNKNOWN",
      limit: 10,
    });
    for (const query of [
      { limit: 101 },
      { limit: 0 },
      { state: "BROKEN" },
      { writeState: "CLOSED" },
      { runtimeId: "not-a-uuid" },
      { cursor: "bad-cursor" },
      { view: "anything" },
    ]) {
      expect(runtimeRecoveryQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});
