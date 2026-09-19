import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { ServiceUnavailableException } from "@nestjs/common";
import type { BrowserConnection } from "@devproof/runtime-protocol";
import { directControlClaimsSchema } from "@devproof/runtime-protocol";
import type { AuthContext } from "../auth/auth.types.js";

/** Call only after authorizing control ownership or read-only Run access. */
export function browserConnection(
  current: AuthContext,
  session: {
    id: string;
    runtimeId: string;
    fencingToken: bigint;
    controlGeneration?: number;
    humanControlExpiresAt?: Date | null;
  },
  controlExpiresAt?: Date,
  access: "control" | "preview" = "control",
): BrowserConnection {
  const endpoints = JSON.parse(
    process.env.BROWSER_DIRECT_ENDPOINTS_JSON || "{}",
  ) as Record<string, string>;
  const endpoint = endpoints[session.runtimeId];
  if (!endpoint) return { transport: "relay" };
  const key = process.env.BROWSER_DIRECT_SIGNING_KEY;
  if (!key)
    throw new ServiceUnavailableException(
      "Browser direct access signing is not configured.",
    );
  const url = new URL(endpoint);
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ServiceUnavailableException(
      "Browser direct access requires a WSS endpoint without credentials.",
    );
  const now = Date.now();
  const expiresAt = Math.min(
    now + 30_000,
    controlExpiresAt?.getTime() ?? Infinity,
    access === "control"
      ? (session.humanControlExpiresAt?.getTime() ?? Infinity)
      : Infinity,
  );
  if (expiresAt <= now)
    throw new ServiceUnavailableException("Browser control has expired.");
  const claims = directControlClaimsSchema.parse({
    version: 1,
    audience: session.runtimeId,
    ...(access === "preview" ? { access } : {}),
    sessionId: session.id,
    userId: current.user.id,
    teamId: current.team.id,
    fencingToken: session.fencingToken.toString(),
    controlGeneration: session.controlGeneration ?? 0,
    issuedAt: now,
    expiresAt,
    nonce: randomUUID(),
  });
  const privateKey = createPrivateKey(key.replaceAll("\\n", "\n"));
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new ServiceUnavailableException(
      "Browser direct access requires an Ed25519 key.",
    );
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(null, Buffer.from(body), privateKey).toString(
    "base64url",
  );
  return {
    transport: "direct",
    url: url.toString(),
    ticket: `${body}.${signature}`,
    expiresAt,
  };
}
