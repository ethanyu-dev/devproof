import { describe, expect, it } from "vitest";

import {
  isBlockedHostname,
  isBlockedIp,
  isHostAllowlisted,
  parseHostAllowlist,
  resolveSafeAddress,
} from "./ip-rules.js";

describe("Browser Runtime SSRF IP policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("blocks non-public address %s", (address) => {
    expect(isBlockedIp(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "allows public unicast address %s",
    (address) => expect(isBlockedIp(address)).toBe(false),
  );

  it("blocks local and internal hostnames", () => {
    expect(isBlockedHostname("LOCALHOST.")).toBe(true);
    expect(isBlockedHostname("metadata.internal")).toBe(true);
  });

  it("accepts exact entries and wildcard subdomains", () => {
    const allowlist = parseHostAllowlist(
      "app.corp.example,10.0.0.7,*.paigod.work",
    );
    expect(allowlist).toEqual(
      new Set(["app.corp.example", "10.0.0.7", "*.paigod.work"]),
    );
    expect(isHostAllowlisted("test-console.paigod.work", allowlist)).toBe(true);
    expect(isHostAllowlisted("paigod.work", allowlist)).toBe(false);
    expect(isHostAllowlisted("notpaigod.work", allowlist)).toBe(false);
  });

  it("rejects malformed or overly broad wildcard entries", () => {
    expect(() => parseHostAllowlist("*paigod.work")).toThrow(
      /wildcard subdomains/u,
    );
    expect(() => parseHostAllowlist("*.com")).toThrow(/wildcard subdomains/u);
    expect(() => parseHostAllowlist("*.bad..example")).toThrow(
      /wildcard subdomains/u,
    );
  });

  it("only permits a private address when it is explicitly allowlisted", async () => {
    await expect(resolveSafeAddress("127.0.0.1")).resolves.toBeNull();
    await expect(
      resolveSafeAddress("127.0.0.1", new Set(["127.0.0.1"])),
    ).resolves.toBe("127.0.0.1");
  });
});
