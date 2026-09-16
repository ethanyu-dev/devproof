import { describe, expect, it } from "vitest";
import { userBrowserProfileCreateInputSchema } from "@devproof/contracts";
import { existingProfileForDraft, profileCreateInput } from "./profile-create";
import type { Profile } from "./profile-types";

const draft = {
  websiteUrl: " https://APP.example.com/account?tab=profile#settings ",
  displayName: "",
  environmentKey: "",
  authRole: "",
};

describe("proactive website login", () => {
  it("creates a valid Console-only identity with the default task scope", () => {
    const input = profileCreateInput(draft);
    expect(userBrowserProfileCreateInputSchema.parse(input)).toEqual({
      displayName: "app.example.com",
      verificationUrl: "https://app.example.com/account?tab=profile#settings",
      environmentKey: "default",
      authRole: "default",
      grants: ["CONSOLE"],
    });
  });

  it.each([
    "app.example.com",
    "javascript:alert(1)",
    "file:///tmp/profile",
    "https://user:password@app.example.com/account",
  ])("rejects invalid or credential-bearing website URLs: %s", (websiteUrl) => {
    expect(() => profileCreateInput({ ...draft, websiteUrl })).toThrow();
  });

  const profile = {
    id: "profile-1",
    siteHostname: "app.example.com",
    environmentKey: "default",
    authRole: "default",
  } as Profile;

  it("finds an existing identity by hostname and scope, regardless of path or port", () => {
    expect(
      existingProfileForDraft([profile], {
        ...draft,
        websiteUrl: "https://APP.example.com.:8443/dashboard",
        displayName: "Another label",
        environmentKey: " default ",
      }),
    ).toBe(profile);
  });

  it.each([
    { websiteUrl: "https://other.example.com/account" },
    { environmentKey: "staging" },
    { authRole: "admin" },
  ])(
    "keeps distinct website, environment and role scopes separate: %o",
    (change) => {
      expect(
        existingProfileForDraft([profile], { ...draft, ...change }),
      ).toBeUndefined();
    },
  );
});
