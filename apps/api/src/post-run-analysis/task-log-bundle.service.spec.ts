import { describe, expect, it } from "vitest";

import { sanitizeLogBundleValue } from "./task-log-bundle.service.js";

describe("sanitizeLogBundleValue", () => {
  it("preserves runtime session logs while removing credentials and identifiers", () => {
    expect(
      sanitizeLogBundleValue({
        runtimeSession: {
          id: "runtime-session-secret",
          commands: [
            {
              payload: {
                headers: [{ name: "Cookie", value: "session=secret" }],
                profileKey: "profile-secret",
                url: "/home",
              },
            },
          ],
          events: [{ kind: "page.loaded" }],
          status: "RELEASED",
        },
        executionPolicy: {
          browser: {
            profile: { key: "persistent-profile-secret", mode: "PERSISTENT" },
          },
        },
        sessionId: "session-secret",
        token: "token-secret",
      }),
    ).toEqual({
      runtimeSession: {
        id: "[REDACTED]",
        commands: [
          {
            payload: {
              headers: [{ name: "Cookie", value: "[REDACTED]" }],
              profileKey: "[REDACTED]",
              url: "/home",
            },
          },
        ],
        events: [{ kind: "page.loaded" }],
        status: "RELEASED",
      },
      executionPolicy: {
        browser: {
          profile: { key: "[REDACTED]", mode: "PERSISTENT" },
        },
      },
      sessionId: "[REDACTED]",
      token: "[REDACTED]",
    });
  });

  it("redacts bearer tokens and sensitive URL parameters in free text", () => {
    const value = sanitizeLogBundleValue(
      "request Bearer abc.def and Cookie: session=secret; role=admin\nhttps://example.com/path?token=secret&view=full",
    );

    expect(value).not.toContain("abc.def");
    expect(value).not.toContain("session=secret");
    expect(value).not.toContain("token=secret");
    expect(value).toContain("view=full");
  });

  it("redacts cloud credentials and private keys from structured and free text", () => {
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const value = sanitizeLogBundleValue({
      accessKeyId: "AKIAEXAMPLE",
      environment: {
        privateKey,
        secretAccessKey: "secret-access-key-value",
      },
      output: `privateKey=${privateKey}`,
    });

    expect(value).toEqual({
      accessKeyId: "[REDACTED]",
      environment: {
        privateKey: "[REDACTED]",
        secretAccessKey: "[REDACTED]",
      },
      output: "privateKey=[REDACTED]",
    });
    expect(JSON.stringify(value)).not.toContain("AKIAEXAMPLE");
    expect(JSON.stringify(value)).not.toContain("secret-access-key-value");
    expect(JSON.stringify(value)).not.toContain("cHJpdmF0ZS1rZXktbWF0ZXJpYWw");
  });
});
