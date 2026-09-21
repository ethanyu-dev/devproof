import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startDirectControlServer } from "./direct-control-server.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devproof-release-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".cache"));
  writeFileSync(join(root, "service-active"), "active");
  mkdirSync(join(root, ".devproof-browser-runtime"));
  writeFileSync(
    join(root, ".devproof-browser-runtime/runtime.json"),
    JSON.stringify({ runtimeId: "test-runtime", sessions: [] }),
  );
  const env = join(root, ".config/devproof/browser-runtime.env");
  mkdirSync(dirname(env), { recursive: true });
  const before =
    'DEVPROOF_NETWORK_ALLOWLIST="preserve.example"\nDEVPROOF_DIRECT_CONTROL_HOST="127.0.0.1"\n';
  writeFileSync(env, before, { mode: 0o600 });
  const unit = join(
    root,
    ".config/systemd/user/devproof-browser-runtime.service",
  );
  mkdirSync(dirname(unit), { recursive: true });
  const legacyUnit =
    "[Service]\nExecStart=/custom/runtime-wrapper start\nEnvironment=OPERATOR_SETTING=preserved\n";
  writeFileSync(unit, legacyUnit);
  const dropin = unit + ".d/90-devproof-direct-access.conf";
  mkdirSync(dirname(dropin), { recursive: true });
  const headless = join(dirname(dropin), "99-force-headless.conf");
  writeFileSync(headless, "[Service]\nEnvironment=DEVPROOF_HEADLESS=true\n");
  const installed = join(
    root,
    ".local/lib/node_modules/@devproof/browser-runtime",
  );
  mkdirSync(installed, { recursive: true });
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({ version: "0.2.33", type: "module" }),
  );
  const helper = join(root, "helper.js");
  writeFileSync(
    helper,
    stripTypeScriptTypes(
      readFileSync(
        new URL("./install-direct-access.ts", import.meta.url),
        "utf8",
      ),
    ),
  );
  const stub = (name: string, code: string) =>
    writeFileSync(join(bin, name), `#!${process.execPath}\n${code}\n`, {
      mode: 0o755,
    });
  stub("uname", 'console.log("Linux")');
  stub("sha256sum", `console.log("${"a".repeat(64)}  package.tgz")`);
  stub("loginctl", 'console.log("yes")');
  stub("journalctl", 'console.log(\'{"event":"runtime.gateway.online"}\')');
  stub(
    "systemctl",
    `
    const fs=require('node:fs'),p=require('node:path'),root=process.env.HOME;
    const args=process.argv.slice(2);fs.appendFileSync(p.join(root,'service.log'),args.join(' ')+'\\n');
    const active=p.join(root,'service-active');
    if(args.includes('is-active'))process.exit(fs.existsSync(active)?0:3);
    if(args.includes('stop'))fs.rmSync(active,{force:true});
    if(args.includes('start'))fs.writeFileSync(active,'active');
    if(args.includes('daemon-reload')) {
      const unit=p.join(root,'.config/systemd/user/devproof-browser-runtime.service');
      const dropin=unit+'.d/90-devproof-direct-access.conf';
      const effective=fs.readFileSync(unit,'utf8')+(fs.existsSync(dropin)?fs.readFileSync(dropin,'utf8'):'');
      fs.writeFileSync(p.join(root,'loaded-env-file'),effective.includes('EnvironmentFile=%h/.config/devproof/browser-runtime.env')?'yes':'no');
    }
    if(args.includes('restart')) {
      const loadsEnv=fs.existsSync(p.join(root,'loaded-env-file'))&&fs.readFileSync(p.join(root,'loaded-env-file'),'utf8')==='yes';
      fs.writeFileSync(p.join(root,'env-at-restart'),loadsEnv?fs.readFileSync(p.join(root,'.config/devproof/browser-runtime.env')):'');
      if(process.env.FAIL_RESTART==='yes')process.exit(1);
      fs.writeFileSync(active,'active');
    }
  `,
  );
  stub(
    "npm",
    `
    const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),root=process.env.HOME;
    fs.appendFileSync(p.join(root,'npm.log'),a.join(' ')+'\\n');
    if(a[0]==='pack') { const dest=a[a.indexOf('--pack-destination')+1];fs.writeFileSync(p.join(dest,'old.tgz'),'old');console.log('old.tgz'); }
    if(a[0]==='install'&&!a.includes('--global')) {
      const dest=p.join(a[a.indexOf('--prefix')+1],'node_modules');
      const pkg=p.join(dest,'@devproof/browser-runtime');fs.mkdirSync(p.join(pkg,'dist'),{recursive:true});
      fs.writeFileSync(p.join(pkg,'package.json'),JSON.stringify({version:'0.2.34',type:'module'}));
      fs.copyFileSync(p.join(root,'helper.js'),p.join(pkg,'dist/install-direct-access.js'));
      fs.mkdirSync(p.join(dest,'playwright'),{recursive:true});
      fs.writeFileSync(p.join(dest,'playwright/package.json'),'{}');fs.writeFileSync(p.join(dest,'playwright/cli.js'),'');
    }
  `,
  );
  const pkg = join(root, "package.tgz");
  writeFileSync(pkg, "fixture");
  const run = (config?: unknown, failRestart = false) => {
    const args = [
      new URL("../../../scripts/install-browser-runtime.sh", import.meta.url)
        .pathname,
      "--package",
      pkg,
      "--sha256",
      "a".repeat(64),
    ];
    if (config) {
      const file = join(root, "direct.json");
      writeFileSync(file, JSON.stringify(config));
      args.push("--direct-config", file);
    }
    return new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        const child = spawn("bash", args, {
          env: {
            ...process.env,
            HOME: root,
            DEVPROOF_RUNTIME_HOME: join(root, ".devproof-browser-runtime"),
            PATH: `${bin}:${process.env.PATH}`,
            FAIL_RESTART: failRestart ? "yes" : "no",
          },
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
      },
    );
  };
  return { root, env, before, run, unit, legacyUnit, dropin, headless };
}

const publicKey = generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();
const config = {
  host: "127.0.0.1",
  port: 9444,
  origins: ["https://console.example.com"],
  publicKey,
  publicUrl: "wss://runtime.example.com/browser-control",
};

it("ordinary upgrades preserve existing environment byte-for-byte", async () => {
  const f = fixture();
  const result = await f.run();
  expect(result.code, result.output).toBe(0);
  expect(readFileSync(f.env, "utf8")).toBe(f.before);
  expect(existsSync(f.dropin)).toBe(false);
});

it("invalid direct configuration does not stop the current Runtime or touch its environment", async () => {
  const f = fixture();
  const result = await f.run({ ...config, origins: ["*"] });
  expect(result.code).not.toBe(0);
  expect(readFileSync(f.env, "utf8")).toBe(f.before);
  expect(readFileSync(join(f.root, "service.log"), "utf8")).not.toMatch(
    /stop|restart/u,
  );
});

it("failed service restart restores the previous environment and package", async () => {
  const f = fixture();
  const result = await f.run(config, true);
  expect(result.code).not.toBe(0);
  expect(readFileSync(join(f.root, "env-at-restart"), "utf8")).toContain(
    "DEVPROOF_DIRECT_CONTROL_PUBLIC_KEY=",
  );
  expect(readFileSync(f.env, "utf8")).toBe(f.before);
  expect(readFileSync(join(f.root, "npm.log"), "utf8")).toMatch(
    /install --global .*old\.tgz/u,
  );
  expect(readFileSync(join(f.root, "service-active"), "utf8")).toBe("active");
  expect(existsSync(f.dropin)).toBe(false);
  expect(readFileSync(join(f.root, "loaded-env-file"), "utf8")).toBe("no");
  expect(readFileSync(f.unit, "utf8")).toBe(f.legacyUnit);
  expect(readFileSync(f.headless, "utf8")).toBe(
    "[Service]\nEnvironment=DEVPROOF_HEADLESS=true\n",
  );
});

it("rollback restores an existing managed drop-in and preserves other service overrides", async () => {
  const f = fixture();
  mkdirSync(dirname(f.dropin), { recursive: true });
  const original =
    "[Service]\n# Previous operator configuration\nEnvironmentFile=%h/.config/devproof/browser-runtime.env\n";
  writeFileSync(f.dropin, original);
  const unrelated = join(dirname(f.dropin), "20-operator.conf");
  writeFileSync(unrelated, "[Service]\nMemoryMax=2G\n");
  const result = await f.run(config, true);
  expect(result.code).not.toBe(0);
  expect(readFileSync(f.dropin, "utf8")).toBe(original);
  expect(readFileSync(unrelated, "utf8")).toBe("[Service]\nMemoryMax=2G\n");
  expect(readFileSync(f.env, "utf8")).toBe(f.before);
  expect(readFileSync(join(f.root, "loaded-env-file"), "utf8")).toBe("yes");
});

it("applies direct settings before startup, checks the listener and prints a mapping without changing API state", async () => {
  const server = await startDirectControlServer({
    runtimeId: "test-runtime",
    publicKey,
    origins: config.origins,
    host: "127.0.0.1",
    port: 0,
    handler: {
      assert: () => {},
      preview: () => {},
      stopPreview: () => {},
      input: async () => {},
    },
  });
  try {
    const address = server.address;
    if (!address || typeof address === "string")
      throw new Error("Missing listener address");
    const f = fixture();
    const result = await f.run({ ...config, port: address.port });
    expect(result.code, result.output).toBe(0);
    expect(readFileSync(f.unit, "utf8")).toBe(f.legacyUnit);
    expect(readFileSync(f.headless, "utf8")).toBe(
      "[Service]\nEnvironment=DEVPROOF_HEADLESS=true\n",
    );
    expect(readFileSync(f.dropin, "utf8")).toContain(
      "EnvironmentFile=%h/.config/devproof/browser-runtime.env",
    );
    expect(readFileSync(join(f.root, "env-at-restart"), "utf8")).toContain(
      `DEVPROOF_DIRECT_CONTROL_PORT="${address.port}"`,
    );
    expect(readFileSync(f.env, "utf8")).toContain(
      'DEVPROOF_NETWORK_ALLOWLIST="preserve.example"',
    );
    expect(readFileSync(f.env, "utf8")).toContain(
      `DEVPROOF_DIRECT_CONTROL_PORT="${address.port}"`,
    );
    expect(result.output).toContain(
      '{"test-runtime":"wss://runtime.example.com/browser-control"}',
    );
    expect(result.output).toContain("passed WebSocket upgrade");
  } finally {
    await server.close();
  }
});
