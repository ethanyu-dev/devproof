import { describe, expect, it } from "vitest";
import {
  runtimeDrainAttestSchema,
  runtimeRecoveryResolveWriteOutcomeSchema,
} from "./runtime-recovery.js";

const evidence = {
  idempotencyKey: "385146a8-5230-4b02-832a-5eef19e8dc8a",
  note: "Inspected the original workload and its audit trail.",
  evidenceRefs: ["operations://incident/123"],
};
describe("recovery requests", () => {
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
