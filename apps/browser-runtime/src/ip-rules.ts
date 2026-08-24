import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

const BLOCKED_HOST_NAMES = new Set(["localhost"]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".internal"];

function normalizedHost(host: string): string {
  const stripped =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return stripped.toLowerCase().replace(/\.$/u, "");
}

export function parseHostAllowlist(value: string | undefined): Set<string> {
  const entries = (value ?? "")
    .split(",")
    .map((item) => normalizedHost(item.trim()))
    .filter(Boolean);
  for (const entry of entries) {
    if (isIP(entry)) continue;
    const hostname = entry.startsWith("*.") ? entry.slice(2) : entry;
    if (
      entry.includes("/") ||
      entry.includes(":") ||
      (entry.includes("*") && !entry.startsWith("*.")) ||
      !isValidHostname(hostname)
    ) {
      throw new Error(
        `Runtime network allowlist only accepts exact hostnames, IP addresses, or wildcard subdomains such as *.corp.example: ${entry}`,
      );
    }
  }
  return new Set(entries);
}

export function isHostAllowlisted(
  host: string,
  allowlist: ReadonlySet<string>,
): boolean {
  return allowlistMatch(normalizedHost(host), allowlist) !== null;
}

export function isBlockedIp(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return true;
  const parsed = ipaddr.parse(ip);
  const address =
    parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()
      ? (parsed as ipaddr.IPv6).toIPv4Address()
      : parsed;
  return address.range() !== "unicast";
}

export function isBlockedHostname(host: string): boolean {
  const name = normalizedHost(host);
  return (
    BLOCKED_HOST_NAMES.has(name) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/** Resolve once and connect to exactly the screened address. */
export async function resolveSafeAddress(
  host: string,
  allowlist: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  const name = normalizedHost(host);
  const allowlistEntry = allowlistMatch(name, allowlist);
  const explicitlyAllowed = allowlistEntry?.kind === "EXACT";
  const wildcardAllowed = allowlistEntry?.kind === "WILDCARD";
  if (!explicitlyAllowed && isBlockedHostname(name)) return null;
  if (isIP(name)) {
    return explicitlyAllowed || !isBlockedIp(name) ? name : null;
  }
  try {
    const results = await lookup(name, { all: true, verbatim: true });
    if (results.length === 0) return null;
    if (
      !explicitlyAllowed &&
      results.some((entry) =>
        wildcardAllowed
          ? !isWildcardSafeIp(entry.address)
          : isBlockedIp(entry.address),
      )
    ) {
      return null;
    }
    return results[0]?.address ?? null;
  } catch {
    return null;
  }
}

function isValidHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;
  const labels = hostname.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  );
}

function allowlistMatch(
  hostname: string,
  allowlist: ReadonlySet<string>,
): { entry: string; kind: "EXACT" | "WILDCARD" } | null {
  if (allowlist.has(hostname)) return { entry: hostname, kind: "EXACT" };
  if (isIP(hostname)) return null;
  for (const entry of allowlist) {
    if (!entry.startsWith("*.")) continue;
    const suffix = entry.slice(1);
    if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
      return { entry, kind: "WILDCARD" };
    }
  }
  return null;
}

function isWildcardSafeIp(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  const parsed = ipaddr.parse(ip);
  const address =
    parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()
      ? (parsed as ipaddr.IPv6).toIPv4Address()
      : parsed;
  return ["private", "unicast"].includes(address.range());
}
