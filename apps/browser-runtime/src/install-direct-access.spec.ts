import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  directEnvironment,
  probeDirectListener,
  validateDirectConfig,
} from "./install-direct-access.js";
import { startDirectControlServer } from "./direct-control-server.js";

const keys = generateKeyPairSync("ed25519");
const valid = {
  host: "127.0.0.1",
  port: 9444,
  origins: ["https://console.example.com"],
  publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  publicUrl: "wss://runtime.example.com/browser-control",
};
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("release direct-access configuration", () => {
  it("preserves unrelated configuration and produces reusable single-line PEM settings", () => {
    const previous =
      '# operator settings\nDEVPROOF_AUTH_SNAPSHOT_KEY="keep-me"\nDEVPROOF_NETWORK_ALLOWLIST="internal.example"\nDEVPROOF_DIRECT_CONTROL_HOST="0.0.0.0"\nDEVPROOF_DIRECT_CONTROL_HOST="127.0.0.1"\n';
    const config = validateDirectConfig(valid);
    const output = directEnvironment(previous, config);
    expect(output).toContain('DEVPROOF_AUTH_SNAPSHOT_KEY="keep-me"');
    expect(output).toContain('DEVPROOF_NETWORK_ALLOWLIST="internal.example"');
    expect(output.match(/DEVPROOF_DIRECT_CONTROL_HOST=/gu)).toHaveLength(1);
    const pemLine = output
      .split("\n")
      .find((line) => line.startsWith("DEVPROOF_DIRECT_CONTROL_PUBLIC_KEY="))!;
    expect(
      JSON.parse(pemLine.slice(pemLine.indexOf("=") + 1)).replaceAll(
        "\\n",
        "\n",
      ),
    ).toBe(valid.publicKey);
    expect(directEnvironment(output, config)).toBe(output);
  });

  it.each([
    { host: "" },
    { host: "runtime.example.com" },
    { port: 443 },
    { origins: ["*"] },
    { origins: ["https://console.example.com/path"] },
    { origins: ["https://console.example.com\nOTHER=value"] },
    { publicUrl: "ws://runtime.example.com/browser-control" },
    { publicUrl: "wss://runtime.example.com/browser-control?ticket=x" },
    { publicUrl: "wss://runtime.example.com/other" },
    {
      publicKey: keys.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    },
    {
      publicKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        .publicKey.export({ type: "spki", format: "pem" })
        .toString(),
    },
    { typoHost: "0.0.0.0" },
  ])("rejects invalid or unsafe configuration: %j", (patch) => {
    expect(() => validateDirectConfig({ ...valid, ...patch })).toThrow();
  });

  it("refuses to corrupt existing multiline environment values", () => {
    expect(() =>
      directEnvironment(
        'DEVPROOF_DIRECT_CONTROL_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nold\n"\n',
        valid,
      ),
    ).toThrow(/single-line/u);
  });

  it("stages a private file without changing the live environment and fails before output on invalid input", () => {
    const dir = mkdtempSync(join(tmpdir(), "devproof-direct-config-"));
    temporary.push(dir);
    const env = join(dir, "live.env"),
      config = join(dir, "config.json"),
      staged = join(dir, "staged.env");
    writeFileSync(env, 'KEEP="unchanged"\n');
    writeFileSync(config, JSON.stringify(valid));
    const helper = new URL("./install-direct-access.ts", import.meta.url)
      .pathname;
    const result = spawnSync(
      process.execPath,
      [helper, "stage", config, env, staged],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(env, "utf8")).toBe('KEEP="unchanged"\n');
    expect(statSync(staged).mode & 0o777).toBe(0o600);
    writeFileSync(config, JSON.stringify({ ...valid, origins: ["*"] }));
    const rejected = spawnSync(
      process.execPath,
      [helper, "stage", config, env, join(dir, "invalid.env")],
      { encoding: "utf8" },
    );
    expect(rejected.status).not.toBe(0);
    expect(readFileSync(env, "utf8")).toBe('KEEP="unchanged"\n');
  });

  it("probes the actual Runtime WebSocket boundary without granting a session", async () => {
    let assertions = 0;
    const server = await startDirectControlServer({
      runtimeId: "smoke",
      publicKey: valid.publicKey,
      origins: valid.origins,
      host: "127.0.0.1",
      port: 0,
      handler: {
        assert: () => {
          assertions++;
        },
        preview: () => {},
        stopPreview: () => {},
        input: async () => {},
      },
    });
    try {
      const address = server.address;
      if (!address || typeof address === "string")
        throw new Error("Missing server address");
      await probeDirectListener({ ...valid, port: address.port });
      expect(assertions).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("does not mistake an ordinary HTTP response for a healthy direct listener", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing server address");
      await expect(
        probeDirectListener({ ...valid, port: address.port }),
      ).rejects.toThrow(/200/u);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
