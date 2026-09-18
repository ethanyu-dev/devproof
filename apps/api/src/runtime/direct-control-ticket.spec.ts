import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { AuthContext } from "../auth/auth.types.js";
import { browserConnection } from "./direct-control-ticket.js";
const current = {
  user: { id: randomUUID() },
  team: { id: randomUUID() },
} as AuthContext;
const session = {
  id: randomUUID(),
  runtimeId: randomUUID(),
  fencingToken: 9n,
  controlGeneration: 2,
};
afterEach(() => vi.unstubAllEnvs());
it("retains relay for nodes without a configured direct endpoint", () => {
  vi.stubEnv("BROWSER_DIRECT_ENDPOINTS_JSON", "{}");
  expect(browserConnection(current, session)).toEqual({ transport: "relay" });
});
it("signs a session-scoped ticket capped by the HITL lease without exposing its lease token", () => {
  const keys = generateKeyPairSync("ed25519");
  vi.stubEnv(
    "BROWSER_DIRECT_SIGNING_KEY",
    keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  vi.stubEnv(
    "BROWSER_DIRECT_ENDPOINTS_JSON",
    JSON.stringify({ [session.runtimeId]: "wss://vm.example/browser-control" }),
  );
  const until = new Date(Date.now() + 5000);
  const result = browserConnection(current, session, until);
  expect(result.transport).toBe("direct");
  if (result.transport !== "direct") throw new Error();
  const [body, signature] = result.ticket.split(".") as [string, string];
  expect(
    verify(
      null,
      Buffer.from(body),
      keys.publicKey,
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);
  expect(JSON.parse(Buffer.from(body, "base64url").toString())).toMatchObject({
    audience: session.runtimeId,
    sessionId: session.id,
    userId: current.user.id,
    teamId: current.team.id,
    controlGeneration: 2,
    expiresAt: until.getTime(),
  });
  expect(body).not.toContain("leaseToken");
  expect(() => browserConnection(current, session, new Date(0))).toThrow();
});
it("fails closed for configured direct access with missing signing keys", () => {
  vi.stubEnv(
    "BROWSER_DIRECT_ENDPOINTS_JSON",
    JSON.stringify({ [session.runtimeId]: "wss://vm.example/browser-control" }),
  );
  vi.stubEnv("BROWSER_DIRECT_SIGNING_KEY", "");
  expect(() => browserConnection(current, session)).toThrow();
});
