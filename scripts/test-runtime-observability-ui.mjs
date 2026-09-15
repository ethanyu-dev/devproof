/** Isolated production Web UI with mocked APIs. Run after building @devproof/web.
 * Optional RUNTIME_UI_SCREENSHOTS=/tmp/runtime-ui keeps desktop/mobile captures.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const requireBrowser = createRequire(
  new URL("../apps/browser-runtime/package.json", import.meta.url),
);
const requireWeb = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { chromium } = requireBrowser("playwright");
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  [
    requireWeb.resolve("next/dist/bin/next"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: join(root, "apps/web"),
    env: { ...process.env, API_BASE_URL: "http://127.0.0.1:1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverLog = "";
server.stdout.on("data", (chunk) => {
  serverLog += chunk;
});
server.stderr.on("data", (chunk) => {
  serverLog += chunk;
});
let browser;
const errors = [];
const unexpected = [];
const counts = new Map();
let failure = false;
const runtime = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "杭州执行节点",
  capabilities: [],
  deviceInfo: "Linux · 8 核 / 16 GiB",
  enabled: true,
  instanceKey: "runtime-observability-fixture",
  lastSeenAt: new Date().toISOString(),
  maxConcurrency: 8,
  networkAllowlist: [],
  protocolMinor: 17,
  status: "ONLINE",
  tokenHint: "test",
  version: "0.2.26",
  drainState: "NONE",
};
const node = {
  id: runtime.id,
  name: runtime.name,
  available: 4,
  configured: 8,
  draining: 0,
  occupied: 4,
  online: true,
  waiting: 3,
  runtimeWaiting: 2,
  quarantined: 1,
};
const capacity = {
  availableCapacity: 4,
  configuredCapacity: 8,
  drainingCapacity: 0,
  flexibleWaiting: 1,
  nodes: [node],
  occupiedCapacity: 4,
  schedulableCapacity: 8,
  runtimeWaiting: 3,
  flexibleRuntimeWaiting: 1,
  upstreamWaiting: 2,
  upstreamWaitingByReason: { IDENTITY_LIMIT: 2 },
};
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(serverLog);
    if (
      await fetch(`${origin}/console/access`).then(
        (response) => response.ok,
        () => false,
      )
    )
      break;
    if (attempt === 99)
      throw new Error(`Web server did not start: ${serverLog}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    locale: "zh-CN",
  });
  await context.route("**/auth/me", (route) =>
    route.fulfill({
      json: {
        team: { id: "team", name: "测试团队", slug: "test" },
        user: { id: "user", name: "测试管理员", email: null, avatarUrl: null },
      },
    }),
  );
  await context.route("**/console/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      "/console/api",
      "",
    );
    counts.set(path, (counts.get(path) ?? 0) + 1);
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (path === "/browser-runtimes")
      return failure
        ? reply({ message: "fixture telemetry unavailable" }, 503)
        : reply([runtime]);
    if (path === "/browser-pool-capacity") return reply(capacity);
    if (path === "/runtime-settings") return reply({ hitlEnabled: true });
    if (path === "/runtime-recoveries/summary")
      return reply({ pending: 0, needsOperator: 0, awaitingWrite: 0 });
    if (
      [
        "/runtime-routing-rules",
        "/tool-credentials",
        "/github-access",
        "/agent-models",
      ].includes(path)
    )
      return reply([]);
    unexpected.push(`${route.request().method()} ${path}`);
    return reply({ message: `Unexpected fixture request ${path}` }, 500);
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto(`${origin}/console/access`);
  await page.getByText(/升级并重启此节点后可查看 CPU/).waitFor();
  const metrics = {
    sampledAt: new Date().toISOString(),
    sampleIntervalMs: 15000,
    scope: "HOST",
    cpu: { logicalCores: 8, usagePercent: 35.2 },
    memory: {
      totalBytes: 16 * 1024 ** 3,
      usedBytes: 10 * 1024 ** 3,
      availableBytes: 6 * 1024 ** 3,
      usagePercent: 62.5,
      availableSource: "MEM_AVAILABLE",
    },
    process: { rssBytes: 120 * 1024 ** 2, uptimeSeconds: 3600 },
  };
  runtime.protocolMinor = 18;
  runtime.telemetry = {
    receivedAt: await page.evaluate(() => new Date().toISOString()),
    metrics,
  };
  await page.clock.runFor(5100);
  const cpu = page.getByRole("meter", { name: "CPU", exact: true });
  await cpu.waitFor();
  assert.equal(await cpu.getAttribute("aria-valuenow"), "35.2");
  assert.equal(
    await page
      .getByRole("meter", { name: "内存", exact: true })
      .getAttribute("aria-valuenow"),
    "62.5",
  );
  await page.getByText("4 / 8 占用", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-state="占用"]').count(), 3);
  assert.equal(await page.locator('[data-state="隔离"]').count(), 1);
  assert.equal(await page.locator('[data-state="空闲"]').count(), 4);
  const concurrency = page.getByLabel("并发容量（1–32）", { exact: true });
  const allowlist = page.getByLabel("允许访问的主机（每行一条）", {
    exact: true,
  });
  await concurrency.fill("6");
  await allowlist.fill("draft.example.com");
  const credentialRequests = counts.get("/tool-credentials");
  metrics.cpu.usagePercent = 68.4;
  await page.clock.runFor(5100);
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="meter"][aria-label="CPU"]')
        ?.getAttribute("aria-valuenow") === "68.4",
  );
  assert.equal(
    await concurrency.inputValue(),
    "6",
    "Polling must preserve the concurrency draft",
  );
  assert.equal(await allowlist.inputValue(), "draft.example.com");
  assert.equal(counts.get("/tool-credentials"), credentialRequests);
  async function screenshot(name) {
    const directory = process.env.RUNTIME_UI_SCREENSHOTS;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: join(directory, `${name}.png`),
      fullPage: true,
    });
  }
  await screenshot("desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("mobile");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile layout must not overflow",
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.clock.runFor(46_000);
  await page
    .getByText("资源采样已过期，等待节点重新上报。", { exact: true })
    .waitFor();
  assert.equal(await cpu.count(), 0);
  failure = true;
  await page.clock.runFor(5100);
  await page.getByText(/自动刷新失败，以下为上次成功快照/).waitFor();
  assert.equal(await concurrency.inputValue(), "6");
  failure = false;
  runtime.status = "OFFLINE";
  node.online = false;
  node.available = 0;
  await page.clock.runFor(5100);
  await page
    .getByText("节点未在线，暂无实时资源数据。", { exact: true })
    .waitFor();
  assert.equal(await cpu.count(), 0);
  await page.getByRole("tab", { name: "GitHub 凭证", exact: true }).click();
  const beforePause = counts.get("/browser-runtimes");
  await page.clock.runFor(15_100);
  assert.equal(
    counts.get("/browser-runtimes"),
    beforePause,
    "Other sections must pause resource polling",
  );
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: live CPU/memory/slot pool, polling, draft preservation, legacy/offline/stale/error states, paused polling and desktop/mobile layout",
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
}
