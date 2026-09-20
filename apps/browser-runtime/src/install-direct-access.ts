import { createPublicKey, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

export interface DirectInstallConfig {
  host: string;
  port: number;
  origins: string[];
  publicKey: string;
  publicUrl: string;
}

export function validateDirectConfig(value: unknown): DirectInstallConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Direct configuration must be a JSON object.");
  const config = value as Record<string, unknown>;
  const fields = ["host", "port", "origins", "publicKey", "publicUrl"];
  if (Object.keys(config).some((key) => !fields.includes(key)))
    throw new Error("Unknown direct configuration field.");
  if (typeof config.host !== "string" || !isIP(config.host))
    throw new Error(
      "host must explicitly specify a local listener IP address.",
    );
  const port = config.port ?? 9444;
  if (!Number.isInteger(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error("port must be an integer between 1024 and 65535.");
  if (
    !Array.isArray(config.origins) ||
    config.origins.length === 0 ||
    config.origins.some((origin) => {
      if (typeof origin !== "string") return true;
      try {
        const url = new URL(origin);
        return (
          url.protocol !== "https:" ||
          url.origin !== origin ||
          origin.includes("*")
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error("origins must contain exact HTTPS Console origins.");
  if (
    typeof config.publicKey !== "string" ||
    !config.publicKey.startsWith("-----BEGIN PUBLIC KEY-----")
  )
    throw new Error(
      "publicKey must be a public SPKI PEM, never a private key.",
    );
  const key = createPublicKey(config.publicKey.replaceAll("\\n", "\n"));
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("publicKey must be an Ed25519 public key.");
  if (typeof config.publicUrl !== "string")
    throw new Error("publicUrl must be a WSS /browser-control endpoint.");
  const url = new URL(config.publicUrl);
  if (
    url.protocol !== "wss:" ||
    url.pathname !== "/browser-control" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("publicUrl must be a WSS /browser-control endpoint.");
  return {
    host: config.host,
    port: Number(port),
    origins: [...new Set(config.origins as string[])],
    publicKey: key.export({ type: "spki", format: "pem" }).toString(),
    publicUrl: url.toString(),
  };
}

/** Keep unrelated systemd settings verbatim; never execute the environment file. */
export function directEnvironment(
  previous: string,
  config: DirectInstallConfig,
) {
  const values: Record<string, string> = {
    DEVPROOF_DIRECT_CONTROL_HOST: config.host,
    DEVPROOF_DIRECT_CONTROL_PORT: String(config.port),
    DEVPROOF_DIRECT_CONTROL_ORIGINS: config.origins.join(","),
    // Runtime understands literal backslash-n sequences in PEM configuration.
    DEVPROOF_DIRECT_CONTROL_PUBLIC_KEY: config.publicKey.replaceAll(
      "\n",
      "\\n",
    ),
  };
  const preserved = previous
    .split(/\r?\n/u)
    .filter((line) => {
      if (
        !/^\s*DEVPROOF_DIRECT_CONTROL_(HOST|PORT|ORIGINS|PUBLIC_KEY)\s*=/u.test(
          line,
        )
      )
        return true;
      const value = line.slice(line.indexOf("=") + 1).trim();
      if (
        (value.startsWith('"') && !/^"(?:[^"\\]|\\.)*"$/u.test(value)) ||
        (value.startsWith("'") && !/^'[^']*'$/u.test(value)) ||
        value.endsWith("\\")
      )
        throw new Error(
          "Existing direct settings must use single-line values; encode PEM newlines as literal \\n.",
        );
      return false;
    })
    .join("\n")
    .replace(/\n*$/u, "");
  const managed = Object.entries(values).map(
    ([name, value]) => `${name}=${JSON.stringify(value)}`,
  );
  return `${preserved ? preserved + "\n" : ""}${managed.join("\n")}\n`;
}

export async function probeDirectListener(config: DirectInstallConfig) {
  const host =
    config.host === "0.0.0.0"
      ? "127.0.0.1"
      : config.host === "::"
        ? "::1"
        : config.host;
  await new Promise<void>((resolve, reject) => {
    const req = request({
      host,
      port: config.port,
      path: "/browser-control",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Origin: config.origins[0],
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });
    const timer = setTimeout(
      () => req.destroy(new Error("Direct listener probe timed out.")),
      5000,
    );
    req.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.once("response", (response) => {
      clearTimeout(timer);
      response.destroy();
      reject(
        new Error(
          `Direct listener rejected WebSocket upgrade (${response.statusCode}).`,
        ),
      );
    });
    req.once("upgrade", (response, socket) => {
      clearTimeout(timer);
      socket.destroy();
      if (
        response.statusCode !== 101 ||
        response.headers.upgrade?.toLowerCase() !== "websocket"
      )
        reject(new Error("Direct listener did not upgrade to WebSocket."));
      else resolve();
    });
    req.end();
  });
}

async function main() {
  const [action, configPath, inputPath, outputPath] = process.argv.slice(2);
  if (!configPath) throw new Error("A direct configuration file is required.");
  const config = validateDirectConfig(
    JSON.parse(readFileSync(configPath, "utf8")),
  );
  if (action === "stage" && inputPath && outputPath) {
    const previous = existsSync(inputPath)
      ? readFileSync(inputPath, "utf8")
      : "";
    writeFileSync(outputPath, directEnvironment(previous, config), {
      mode: 0o600,
      flag: "wx",
    });
  } else if (action === "verify") {
    await probeDirectListener(config);
    console.log(
      "Local direct listener passed WebSocket upgrade. Public TLS, routing and ticket authentication still require Console verification.",
    );
  } else if (action === "describe" && inputPath) {
    const state = JSON.parse(readFileSync(inputPath, "utf8"));
    if (typeof state.runtimeId !== "string" || !state.runtimeId)
      throw new Error("Runtime ID is missing.");
    console.log(
      "Merge this entry into API BROWSER_DIRECT_ENDPOINTS_JSON after public WSS verification:",
    );
    console.log(JSON.stringify({ [state.runtimeId]: config.publicUrl }));
  } else throw new Error("Expected stage, verify or describe.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Direct configuration failed.",
    );
    process.exitCode = 1;
  });
}
