import { describe, expect, it } from "vitest";

import { retainedProfilePolicy } from "./profile-policy";

describe("retainedProfilePolicy", () => {
  it("preserves the original unavailable policy and complete scope", () => {
    expect(
      retainedProfilePolicy({
        profilePolicy: {
          onUnavailable: "FAIL",
          scope: {
            authRole: "admin",
            environmentKey: "staging",
            hostname: "console.example.com",
          },
          strategy: "ISSUE_ASSIGNEE",
        },
      }),
    ).toEqual({
      onUnavailable: "FAIL",
      scope: {
        authRole: "admin",
        environmentKey: "staging",
        hostname: "console.example.com",
      },
    });
  });
});
