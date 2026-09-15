import { describe, expect, it } from "vitest";
import { telemetryState } from "./runtime-observability";
import type { RuntimeTelemetrySnapshot } from "@devproof/runtime-protocol";

const now = Date.parse("2026-09-15T12:00:00.000Z");
const snapshot = (age: number) =>
  ({
    receivedAt: new Date(now - age).toISOString(),
  }) as RuntimeTelemetrySnapshot;

describe("resource telemetry freshness", () => {
  it("never presents offline, unsupported, missing or expired data as current", () => {
    expect(telemetryState("OFFLINE", 18, snapshot(0), now)).toBe("OFFLINE");
    expect(telemetryState("REVOKED", 18, snapshot(0), now)).toBe("OFFLINE");
    expect(telemetryState("ONLINE", 17, snapshot(0), now)).toBe("UNSUPPORTED");
    expect(telemetryState("ONLINE", null, null, now)).toBe("UNSUPPORTED");
    expect(telemetryState("ONLINE", 18, null, now)).toBe("MISSING");
    expect(telemetryState("ONLINE", 18, snapshot(44999), now)).toBe("LIVE");
    expect(telemetryState("ONLINE", 18, snapshot(45000), now)).toBe("STALE");
  });
});
