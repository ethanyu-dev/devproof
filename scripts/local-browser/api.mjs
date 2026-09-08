import { existsSync, readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";

const envFile = new URL("../../.env", import.meta.url);
if (existsSync(envFile)) loadEnvFile(envFile);

export function localUrl(value) {
  const url = new URL(value);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Local tests require a loopback HTTP(S) URL without credentials.",
    );
  }
  return url;
}

export function localCredentials() {
  return process.env.DEVPROOF_LOCAL_CREDENTIALS
    ? JSON.parse(readFileSync(process.env.DEVPROOF_LOCAL_CREDENTIALS, "utf8"))
    : {};
}

export function localApi() {
  const base = localUrl(
    process.env.DEVPROOF_API_URL ?? "http://localhost:4433",
  );
  const token = process.env.DEVPROOF_TOOL_TOKEN ?? localCredentials().toolToken;
  if (!token)
    throw new Error(
      "DEVPROOF_TOOL_TOKEN or DEVPROOF_LOCAL_CREDENTIALS is required.",
    );
  return async (path, body, expectedStatus) => {
    const url = new URL(path, base);
    if (url.origin !== base.origin)
      throw new Error("API requests must stay on the local origin.");
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json();
    if (expectedStatus ? response.status !== expectedStatus : !response.ok) {
      throw new Error(
        `${path}: HTTP ${response.status}: ${JSON.stringify(result).slice(0, 1000)}`,
      );
    }
    return result;
  };
}

export function directTask(idempotencyKey, goal, criteria, environment = {}) {
  return {
    kind: "DIRECT_RUN",
    idempotencyKey,
    run: {
      idempotencyKey,
      goal,
      criteria,
      environment,
      source: { kind: "LOCAL_COMPARISON" },
      browserPolicy: { profile: { mode: "EPHEMERAL" } },
      deadlineSeconds: 600,
      deadlinePolicy: { mode: "FIXED" },
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      hitlPolicy: { enabled: false, notificationChannels: [] },
    },
  };
}
