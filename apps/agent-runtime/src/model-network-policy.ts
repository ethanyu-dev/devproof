import { lookup } from "node:dns/promises";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

const BLOCKED_HOST_NAMES = new Set(["localhost"]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".internal"];

type AddressLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export function parseModelHostAllowlist(
  value: string | undefined,
): Set<string> {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => normalizeHost(entry.trim()))
    .filter(Boolean);
  for (const entry of entries) {
    if (isIP(entry)) continue;
    if (!isValidHostname(entry)) {
      throw new Error(
        `Agent model host allowlist only accepts exact hostnames or IP addresses: ${entry}`,
      );
    }
  }
  return new Set(entries);
}

export function isBlockedModelIp(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  const parsed = ipaddr.parse(address);
  const normalized =
    parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()
      ? (parsed as ipaddr.IPv6).toIPv4Address()
      : parsed;
  return normalized.range() !== "unicast";
}

export async function resolveModelAddress(
  hostname: string,
  allowlist: ReadonlySet<string>,
  addressLookup: AddressLookup = (name) =>
    lookup(name, { all: true, verbatim: true }),
): Promise<string> {
  const host = normalizeHost(hostname);
  const explicitlyAllowed = allowlist.has(host);
  if (!explicitlyAllowed && isBlockedHostname(host)) {
    throw blockedEndpoint(host);
  }
  if (isIP(host)) {
    if (!explicitlyAllowed && isBlockedModelIp(host)) {
      throw blockedEndpoint(host);
    }
    return host;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await addressLookup(host);
  } catch {
    throw new Error(`Agent model hostname could not be resolved: ${host}`);
  }
  if (
    addresses.length === 0 ||
    (!explicitlyAllowed &&
      addresses.some((entry) => isBlockedModelIp(entry.address)))
  ) {
    throw blockedEndpoint(host);
  }
  return addresses[0]!.address;
}

export function createModelFetch(
  allowlist: ReadonlySet<string> = new Set(),
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (!["http:", "https:"].includes(target.protocol)) {
      throw new Error("Agent model endpoints must use HTTP or HTTPS.");
    }
    const host = normalizeHost(target.hostname);
    if (target.protocol !== "https:" && !allowlist.has(host)) {
      throw new Error(
        `Plain HTTP Agent model endpoints require an exact operator allowlist entry: ${host}`,
      );
    }
    const address = await resolveModelAddress(host, allowlist);
    const body = request.body
      ? Buffer.from(await request.arrayBuffer())
      : undefined;
    return requestPinnedAddress(request, target, address, body);
  };
}

function requestPinnedAddress(
  request: Request,
  target: URL,
  address: string,
  body: Buffer | undefined,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(request.headers.entries());
    headers.host = target.host;
    headers["accept-encoding"] = "identity";
    const options: RequestOptions = {
      headers,
      hostname: address,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      signal: request.signal,
      ...(target.protocol === "https:" && !isIP(target.hostname)
        ? { servername: target.hostname }
        : {}),
    };
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(options, (incoming) => {
      if (
        incoming.statusCode &&
        incoming.statusCode >= 300 &&
        incoming.statusCode < 400 &&
        incoming.headers.location
      ) {
        incoming.resume();
        reject(new Error("Agent model endpoint redirects are not allowed."));
        return;
      }
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const status = incoming.statusCode ?? 502;
        const responseBody = [101, 204, 205, 304].includes(status)
          ? null
          : Buffer.concat(chunks);
        resolve(
          new Response(responseBody, {
            headers: responseHeaders(incoming.headers),
            status,
            ...(incoming.statusMessage
              ? { statusText: incoming.statusMessage }
              : {}),
          }),
        );
      });
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

function responseHeaders(values: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function normalizeHost(host: string): string {
  const stripped =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return stripped.toLowerCase().replace(/\.$/u, "");
}

function isBlockedHostname(host: string): boolean {
  return (
    BLOCKED_HOST_NAMES.has(host) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

function isValidHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  return host
    .split(".")
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    );
}

function blockedEndpoint(host: string): Error {
  return new Error(
    `Agent model endpoint is blocked by Runtime network policy: ${host}`,
  );
}
