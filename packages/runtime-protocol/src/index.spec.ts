import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  RUNTIME_PROTOCOL,
  USER_PROFILE_INACTIVITY_TTL_SECONDS,
  runtimeActionCommandInputSchema,
  runtimeCommandInputSchema,
  runtimeCommandMinimumMinor,
  runtimeCommandPayloadSchema,
  runtimeClientMessageSchema,
  runtimeServerMessageSchema,
} from "./index.js";

describe("Runtime protocol", () => {
  it("publishes semantic command guidance in the JSON schema", () => {
    const publicSchema = JSON.stringify(
      z.toJSONSchema(runtimeActionCommandInputSchema),
    );

    expect(publicSchema).toContain("不存在 element.click");
    expect(publicSchema).toContain("不存在 page.content");
    expect(publicSchema).toContain("仅用于观察，不会创建持久化 DOM 证据");
    expect(publicSchema).toContain("创建持久化的 NETWORK 证据");
  });

  it("parses a valid authenticated hello", () => {
    const result = runtimeClientMessageSchema.parse({
      activeSessions: [],
      instanceNonce: "instance-nonce-123456",
      protocol: RUNTIME_PROTOCOL,
      runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
      runtimeToken: "a".repeat(32),
      sentAt: new Date().toISOString(),
      type: "runtime.hello",
    });
    expect(result.type).toBe("runtime.hello");
  });

  it("accepts generated step videos as Runtime artifacts", () => {
    const result = runtimeClientMessageSchema.parse({
      artifacts: [
        {
          contentType: "video/webm",
          dataBase64: "AQID",
          kind: "VIDEO",
          metadata: { format: "STEP_SCREENSHOT_SLIDESHOW", frameCount: 3 },
        },
      ],
      commandId: "4a73bdf6-a1ad-4f78-af39-78e686539314",
      fencingToken: "7",
      leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
      ok: true,
      result: { closed: true },
      sessionId: "11bb7c5c-cd52-4ae7-8759-6e4e1391357d",
      type: "command.result",
    });

    expect(RUNTIME_PROTOCOL.minor).toBe(10);
    expect(result.type).toBe("command.result");
    if (result.type !== "command.result") {
      throw new Error("Expected a command result.");
    }
    expect(result.artifacts[0]?.kind).toBe("VIDEO");
  });

  it("accepts structured locator recovery diagnostics", () => {
    const result = runtimeClientMessageSchema.parse({
      artifacts: [],
      commandId: "4a73bdf6-a1ad-4f78-af39-78e686539314",
      error: {
        code: "LOCATOR_AMBIGUOUS",
        details: {
          candidates: [
            {
              href: "https://example.com/solution/ai",
              index: 0,
              name: "人工智能解决方案",
              ref: "e42",
              visible: true,
            },
          ],
          count: 2,
        },
        message: "Locator matched 2 elements.",
        recoveryAction: "RESNAPSHOT_AND_RETARGET",
        retryable: false,
      },
      fencingToken: "7",
      leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
      ok: false,
      sessionId: "11bb7c5c-cd52-4ae7-8759-6e4e1391357d",
      type: "command.result",
    });

    expect(result).toMatchObject({
      error: {
        code: "LOCATOR_AMBIGUOUS",
        recoveryAction: "RESNAPSHOT_AND_RETARGET",
      },
      ok: false,
    });
  });

  it("accepts a Runtime package version without requiring it from legacy clients", () => {
    const result = runtimeClientMessageSchema.parse({
      activeSessions: [],
      instanceNonce: "instance-nonce-123456",
      protocol: RUNTIME_PROTOCOL,
      runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
      runtimeToken: "a".repeat(32),
      sentAt: new Date().toISOString(),
      type: "runtime.hello",
      version: "0.2.2",
    });
    expect(result).toMatchObject({
      type: "runtime.hello",
      version: "0.2.2",
    });
  });

  it("defaults a legacy handshake to the deny-by-default network policy", () => {
    const result = runtimeServerMessageSchema.parse({
      heartbeatIntervalMs: 15_000,
      protocol: RUNTIME_PROTOCOL,
      reconcile: [],
      serverTime: new Date().toISOString(),
      type: "runtime.hello.accepted",
    });

    expect(result).toMatchObject({
      networkAllowlist: [],
      type: "runtime.hello.accepted",
    });
  });

  it("normalizes and deduplicates managed Runtime network policy updates", () => {
    const result = runtimeServerMessageSchema.parse({
      networkAllowlist: [
        " Test-Console.Paigod.Work ",
        "test-console.paigod.work",
        "*.corp.example",
      ],
      type: "runtime.network_policy.updated",
    });

    expect(result).toEqual({
      networkAllowlist: ["test-console.paigod.work", "*.corp.example"],
      type: "runtime.network_policy.updated",
    });
  });

  it("rejects a command without a fencing token", () => {
    const result = runtimeServerMessageSchema.safeParse({
      commandId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
      commandType: "page.screenshot",
      deadlineAt: new Date().toISOString(),
      payload: {},
      sessionId: "285146a8-5230-4b02-832a-5eef19e8dc8a",
      type: "command.execute",
    });
    expect(result.success).toBe(false);
  });

  it("enforces command-specific strict payloads", () => {
    expect(
      runtimeCommandInputSchema.parse({
        commandType: "page.snapshot",
        payload: {
          depth: 8,
          maxChars: 64_000,
          target: { selector: "wujie-app #root" },
        },
      }).commandType,
    ).toBe("page.snapshot");
    expect(
      runtimeCommandInputSchema.safeParse({
        commandType: "page.snapshot",
        payload: { password: "must-not-pass" },
      }).success,
    ).toBe(false);
    expect(
      runtimeCommandInputSchema.safeParse({
        commandType: "page.click",
        payload: { selector: "button" },
      }).success,
    ).toBe(false);
    expect(
      runtimeCommandInputSchema.safeParse({
        commandType: "page.click",
        payload: { target: { ref: "e17" } },
      }).success,
    ).toBe(true);
    for (const ref of ["f1e17", "f12e533"]) {
      expect(
        runtimeCommandInputSchema.safeParse({
          commandType: "page.click",
          payload: { target: { ref } },
        }).success,
      ).toBe(true);
    }
    for (const ref of ["f1", "fe17", "f1e", "1e17"]) {
      expect(
        runtimeCommandInputSchema.safeParse({
          commandType: "page.click",
          payload: { target: { ref } },
        }).success,
      ).toBe(false);
    }
    expect(
      runtimeCommandInputSchema.safeParse({
        commandType: "page.network",
        payload: {
          includeResponseBodies: true,
          urlIncludes: "/api/product/list",
        },
      }).success,
    ).toBe(true);
    expect(runtimeCommandMinimumMinor("page.snapshot")).toBe(7);
    expect(runtimeCommandMinimumMinor("page.dom")).toBe(7);
    expect(runtimeCommandMinimumMinor("page.network")).toBe(7);
    expect(runtimeCommandMinimumMinor("page.click")).toBe(5);
  });

  it("validates lifecycle payloads on the wire", () => {
    const base = {
      commandId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
      commandType: "session.open",
      deadlineAt: new Date().toISOString(),
      fencingToken: "7",
      leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
      sessionId: "285146a8-5230-4b02-832a-5eef19e8dc8a",
      type: "command.execute",
    };
    expect(
      runtimeServerMessageSchema.safeParse({
        ...base,
        payload: {
          profileKey: "profile",
          profileMode: "EPHEMERAL",
          unexpected: true,
        },
      }).success,
    ).toBe(false);
    expect(
      runtimeServerMessageSchema.safeParse({
        ...base,
        payload: {
          allowedOrigins: ["https://example.com"],
          profileKey: "profile",
          profileMode: "EPHEMERAL",
        },
      }).success,
    ).toBe(true);
    expect(
      runtimeServerMessageSchema.safeParse({
        ...base,
        payload: {
          allowedOrigins: ["https://example.com"],
          profileKey: "user-profile",
          profileMode: "EPHEMERAL",
          profileRetention: {
            inactivityTtlSeconds: USER_PROFILE_INACTIVITY_TTL_SECONDS,
            kind: "USER",
          },
        },
      }).success,
    ).toBe(false);
    const compatiblePersistentMessage = {
      ...base,
      payload: {
        allowedOrigins: ["https://example.com"],
        profileKey: "user-profile",
        profileMode: "PERSISTENT",
        profileRetention: {
          allowedHostnamePatterns: ["example.com", "*.example.com"],
          inactivityTtlSeconds: USER_PROFILE_INACTIVITY_TTL_SECONDS,
          kind: "USER",
        },
      },
    };
    expect(
      runtimeServerMessageSchema.safeParse(compatiblePersistentMessage).success,
    ).toBe(true);
    const compatiblePayload = runtimeCommandPayloadSchema.parse({
      commandType: "session.open",
      payload: compatiblePersistentMessage.payload,
    });
    if (compatiblePayload.commandType !== "session.open") {
      throw new Error("Expected a session.open payload.");
    }
    expect(compatiblePayload.payload.profileRetention).toEqual(
      compatiblePersistentMessage.payload.profileRetention,
    );
    expect(
      runtimeServerMessageSchema.safeParse({
        ...base,
        payload: {
          profileKey: "user-profile",
          profileMode: "PERSISTENT",
          profileRetention: {
            inactivityTtlSeconds: USER_PROFILE_INACTIVITY_TTL_SECONDS - 1,
            kind: "USER",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts user profile expiry lifecycle events", () => {
    expect(
      runtimeClientMessageSchema.parse({
        eventId: "4a73bdf6-a1ad-4f78-af39-78e686539314",
        kind: "PROFILE_EXPIRED",
        lastUsedAt: "2026-07-01T00:00:00.000Z",
        profileKey: "user-profile",
        purgedAt: "2026-08-01T00:00:00.000Z",
        type: "profile.lifecycle",
      }).type,
    ).toBe("profile.lifecycle");
  });

  it("strictly validates deterministic network fault policies", () => {
    expect(
      runtimeCommandInputSchema.safeParse({
        commandType: "network.arm",
        payload: {
          action: "FULFILL_STATUS",
          policyId: "api-outage",
          status: 503,
          urlPattern: "https://example.com/api/*",
        },
      }).success,
    ).toBe(true);
    expect(
      runtimeCommandInputSchema.safeParse({
        commandType: "network.arm",
        payload: {
          action: "FULFILL_STATUS",
          policyId: "api-outage",
          urlPattern: "https://example.com/api/*",
        },
      }).success,
    ).toBe(false);
  });

  it("gates enhanced browser evidence commands on protocol minor 7", () => {
    expect(runtimeCommandMinimumMinor("page.snapshot")).toBe(7);
    expect(runtimeCommandMinimumMinor("network.arm")).toBe(2);
    expect(runtimeCommandMinimumMinor("human.takeover")).toBe(1);
  });

  it("gates control-plane profile purge on protocol minor 6", () => {
    expect(
      runtimeCommandInputSchema.safeParse({
        commandType: "profile.purge",
        payload: { profileKey: "fp-issue-cycle" },
      }).success,
    ).toBe(true);
    expect(
      runtimeCommandInputSchema.safeParse({
        commandType: "profile.purge",
        payload: { profileKey: "../escape" },
      }).success,
    ).toBe(false);
    expect(
      runtimeActionCommandInputSchema.safeParse({
        commandType: "profile.purge",
        payload: { profileKey: "fp-issue-cycle" },
      }).success,
    ).toBe(false);
    expect(runtimeCommandMinimumMinor("profile.purge")).toBe(6);
  });

  it("requires a monotonic fencing token on command results", () => {
    const parsed = runtimeClientMessageSchema.safeParse({
      artifacts: [],
      commandId: "4a73bdf6-a1ad-4f78-af39-78e686539314",
      leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
      ok: true,
      result: {},
      sessionId: "11bb7c5c-cd52-4ae7-8759-6e4e1391357d",
      type: "command.result",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts bounded transient human input without a persisted command", () => {
    const parsed = runtimeServerMessageSchema.parse({
      dispatchId: "3cb7064e-02f7-4c5a-b4e7-c6009d175ca8",
      events: [
        { button: "left", phase: "down", type: "pointer", x: 0.5, y: 0.5 },
        { button: "left", phase: "up", type: "pointer", x: 0.5, y: 0.5 },
        { text: "temporary input", type: "text" },
      ],
      fencingToken: "7",
      leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
      sessionId: "11bb7c5c-cd52-4ae7-8759-6e4e1391357d",
      type: "human.input.dispatch",
    });

    expect(parsed.type).toBe("human.input.dispatch");
  });

  it("rejects out-of-bounds human input coordinates", () => {
    const parsed = runtimeServerMessageSchema.safeParse({
      dispatchId: "3cb7064e-02f7-4c5a-b4e7-c6009d175ca8",
      events: [
        { button: "left", phase: "down", type: "pointer", x: 1.1, y: 0.5 },
      ],
      fencingToken: "7",
      leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
      sessionId: "11bb7c5c-cd52-4ae7-8759-6e4e1391357d",
      type: "human.input.dispatch",
    });

    expect(parsed.success).toBe(false);
  });
});
