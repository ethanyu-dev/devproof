/** Isolated UI regression: a local production Web build, Chromium, and mocked APIs only.
 * Run after `pnpm --filter @devproof/web build` with `node scripts/test-runtime-recovery-ui.mjs`.
 * Uses the workspace's existing Browser Runtime Playwright dependency.
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
const id = (index) =>
  `${Number(index).toString(16).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
const runtimeId = id(1000);
const now = "2026-09-07T00:00:00.000Z";
const row = (index, closureState = "NEEDS_OPERATOR") => ({
  id: id(index),
  sessionId: id(index + 2000),
  runtimeId,
  sourceRunId: null,
  runtimeName: "本地验证节点",
  sourceRunGoal: null,
  reason: "PERIODIC_RECONCILIATION",
  closureState,
  writeOutcomeState: "UNKNOWN",
  attempts: 1,
  nextAttemptAt: null,
  lastErrorCode:
    closureState === "NEEDS_OPERATOR" ? "CLOSURE_UNVERIFIED" : null,
  version: 1,
  scopeSnapshot: [],
  createdAt: now,
  updatedAt: now,
  resolvedAt: null,
  evidence: [],
  guards: [],
});
let rows = [];
let summaryFailure = false;
let rejectResolution = false;
let resolutionRequests = 0;
let tokenRequests = 0;
let tokenFailure = false;
const runtime = {
  id: runtimeId,
  name: "本地验证节点",
  capabilities: [],
  deviceInfo: "测试宿主",
  enabled: true,
  instanceKey: "test-instance",
  lastSeenAt: now,
  maxConcurrency: 2,
  networkAllowlist: [],
  protocolMinor: 14,
  status: "ONLINE",
  tokenHint: "test",
  version: "0.2.19",
  drainState: "NONE",
};
const preview = {
  runtimeId,
  connectionGeneration: "1",
  hostInstanceId: "test-host",
  snapshotDigest: "scope-1",
  sessions: [],
  drainState: "NONE",
  existingDrain: null,
};
let browser;
const errors = [];
const unexpected = [];
const screenshots = process.env.RECOVERY_UI_SCREENSHOTS;
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
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
  });
  await context.addInitScript(() =>
    localStorage.setItem("devproof.admin", "true"),
  );
  await context.route("**/auth/me", (route) =>
    route.fulfill({
      json: {
        team: { id: id(9000), name: "测试团队", slug: "test" },
        user: {
          id: id(9001),
          name: "测试管理员",
          email: null,
          avatarUrl: null,
        },
      },
    }),
  );
  await context.route("**/console/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/console/api", "");
    const method = route.request().method();
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (path === "/browser-runtimes") return reply([runtime]);
    if (path === "/browser-pool-capacity")
      return reply({
        availableCapacity: 2,
        configuredCapacity: 2,
        drainingCapacity: 0,
        flexibleWaiting: 0,
        nodes: [],
        occupiedCapacity: 0,
        schedulableCapacity: 2,
      });
    if (path === "/runtime-settings") return reply({ hitlEnabled: true });
    if (
      [
        "/runtime-routing-rules",
        "/tool-credentials",
        "/github-access",
        "/agent-models",
      ].includes(path)
    )
      return reply([]);
    const pending = rows.filter(
      (item) => !item.resolvedAt && item.closureState !== "OBSERVED",
    );
    if (path === "/runtime-recoveries/summary")
      return summaryFailure
        ? reply({ message: "fixture summary failure" }, 503)
        : reply({
            pending: pending.length,
            needsOperator: pending.filter(
              (item) => item.closureState === "NEEDS_OPERATOR",
            ).length,
            awaitingWrite: pending.filter(
              (item) => item.closureState === "VERIFIED",
            ).length,
          });
    if (path === "/runtime-recoveries") {
      let filtered =
        url.searchParams.get("view") === "pending" ? pending : rows;
      for (const [key, field] of [
        ["runtimeId", "runtimeId"],
        ["state", "closureState"],
        ["writeState", "writeOutcomeState"],
      ]) {
        const value = url.searchParams.get(key);
        if (value) filtered = filtered.filter((item) => item[field] === value);
      }
      const cursor = url.searchParams.get("cursor");
      const start = cursor
        ? filtered.findIndex((item) => item.id === cursor) + 1
        : 0;
      const limit = Number(url.searchParams.get("limit") || 10);
      const items = filtered.slice(start, start + limit);
      return reply({
        items,
        total: filtered.length,
        nextCursor: start + limit < filtered.length ? items.at(-1).id : null,
      });
    }
    const detail = /^\/runtime-recoveries\/([^/]+)$/.exec(path);
    if (detail && method === "GET")
      return reply(
        rows.find((item) => item.id === detail[1]) ?? {},
        rows.some((item) => item.id === detail[1]) ? 200 : 404,
      );
    if (path.endsWith("/resolve-write-outcome")) {
      resolutionRequests++;
      if (rejectResolution)
        return reply(
          {
            message:
              "Recovery changed. Refresh before resolving its write outcome.",
          },
          409,
        );
      const record = rows.find((item) => path.includes(item.id));
      assert.equal(
        route.request().postDataJSON().expectedVersion,
        record.version,
      );
      record.version++;
      record.writeOutcomeState = "RESOLVED";
      record.resolvedAt = now;
      return reply(record);
    }
    if (path === `/runtimes/${runtimeId}/drain-preview`) return reply(preview);
    if (path === `/runtimes/${runtimeId}/drain` && method === "POST") {
      assert.equal(
        route.request().postDataJSON().snapshotDigest,
        preview.snapshotDigest,
      );
      runtime.drainState = "FROZEN";
      preview.drainState = "FROZEN";
      preview.existingDrain = {
        id: id(8000),
        snapshotDigest: preview.snapshotDigest,
        state: "FROZEN",
        resumedAt: null,
        frozenSessions: [],
      };
      return reply(preview.existingDrain);
    }
    if (path.endsWith("/attest") && method === "POST") {
      const body = route.request().postDataJSON();
      assert.equal(body.snapshotDigest, preview.existingDrain.snapshotDigest);
      assert.equal(body.infrastructureTerminated, true);
      assert.equal(body.evidenceRefs.length, 1);
      runtime.drainState = "ATTESTED";
      preview.drainState = "ATTESTED";
      preview.existingDrain.state = "ATTESTED";
      return reply(preview.existingDrain);
    }

    if (path.endsWith("/resume-token")) {
      tokenRequests++;
      if (tokenFailure)
        return reply({ message: "fixture ticket failure" }, 503);
      return reply({
        runtimeId,
        drainId: preview.existingDrain.id,
        instanceKey: "test-instance",
        pairingToken: `fixture-token-${tokenRequests}`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    unexpected.push(`${method} ${path}`);
    return reply({ message: `Unexpected fixture request ${path}` }, 500);
  });
  const page = await context.newPage();
  await page.clock.install();
  page.on("pageerror", (error) => errors.push(error.message));
  async function screenshot(name) {
    if (!screenshots) return;
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: join(screenshots, `${name}.png`),
      fullPage: true,
    });
  }
  await page.goto(`${origin}/console/access`);
  await page.getByText("当前没有待处理的异常会话", { exact: true }).waitFor();
  for (const count of [2, 61]) {
    rows = Array.from({ length: count }, (_, index) => row(index + 1));
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await page
      .getByText(`有 ${count} 个会话需要处理`, { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "查看恢复详情", exact: true })
        .count(),
      0,
    );
    const config = await page
      .getByText("团队执行策略", { exact: true })
      .boundingBox();
    assert.ok(
      config.y < 650,
      "Recovery records must not push configuration out of the initial viewport",
    );
  }
  await screenshot("configuration");
  summaryFailure = true;
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await page.getByText(/恢复摘要更新失败/).waitFor();
  assert.equal(
    await page.getByText("有 61 个会话需要处理", { exact: true }).count(),
    1,
  );
  summaryFailure = false;
  await page.getByRole("link", { name: "查看恢复记录", exact: true }).click();
  await page.getByText("共 61 条 · 每页 10 条", { exact: true }).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 10);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.waitForURL(/cursor=/);
  await page.getByRole("link", { name: "查看详情" }).first().click();
  await page.getByRole("heading", { name: "恢复详情", exact: true }).waitFor();
  await page.getByText(/自动重试已暂停/).waitFor();
  assert.equal(await page.getByLabel("核实说明", { exact: true }).count(), 0);
  await screenshot("closure-detail");
  await page.getByRole("link", { name: "返回恢复记录", exact: true }).click();
  await page.waitForURL(/cursor=/);
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await page.getByRole("link", { name: "查看详情" }).first().waitFor();
  await screenshot("recovery-list");
  rows[0] = row(1, "VERIFIED");
  await page.getByLabel("关闭进度", { exact: true }).selectOption("VERIFIED");
  await page.getByText("共 1 条 · 每页 10 条", { exact: true }).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 1);
  await page.getByLabel("业务结果", { exact: true }).selectOption("CONFIRMED");
  await page.getByText("当前筛选下没有恢复记录", { exact: true }).waitFor();
  await page.goto(`${origin}/console/access#recovery-${id(1)}`);
  await page.waitForURL(`**/console/access/recoveries/${id(1)}`);
  await page
    .getByLabel("核实说明", { exact: true })
    .fill("已检查订单记录与写入审计，确认实际状态。");
  await page
    .getByLabel("证据引用（每行一条）", { exact: true })
    .fill("operations://test/123");
  // Fast-forward polling without waiting fifteen seconds.
  rows[0].version++;
  await page.clock.runFor(15_100);
  await page.getByText(/恢复状态已变化，草稿已保留/).waitFor();
  const submit = page.getByRole("button", {
    name: "保存核实结果并释放相关数据保护",
    exact: true,
  });
  assert.ok(await submit.isDisabled());
  assert.match(
    await page.getByLabel("核实说明", { exact: true }).inputValue(),
    /已检查订单/,
  );
  await page
    .getByRole("button", { name: "已核对最新状态，继续使用草稿", exact: true })
    .click();
  rejectResolution = true;
  await submit.click();
  await page
    .getByRole("alert")
    .filter({ hasText: /Recovery changed|恢复/ })
    .first()
    .waitFor();
  assert.equal(resolutionRequests, 1);
  assert.match(
    await page.getByLabel("核实说明", { exact: true }).inputValue(),
    /已检查订单/,
  );
  rejectResolution = false;
  await submit.click();
  await page.getByText(/核实结果已保存/).waitFor();
  assert.equal(resolutionRequests, 2);
  assert.equal(await page.getByLabel("核实说明", { exact: true }).count(), 0);
  console.log(
    "PASS: compact configuration, 61-record pagination, detail navigation, legacy links, polling drafts and version conflicts",
  );

  await page.goto(`${origin}/console/access/runtimes/${runtimeId}/recovery`);
  await page.getByText("查看冻结影响与操作", { exact: true }).click();
  await page
    .getByRole("button", { name: "按当前范围冻结节点准入", exact: true })
    .click();
  await page
    .getByLabel("排空核验说明", { exact: true })
    .fill("已停止原服务并核验原宿主的浏览器与网络进程范围。");
  await page
    .getByLabel("基础设施证据引用（每行一条）", { exact: true })
    .fill("operations://drain/123");
  await page.getByRole("checkbox").check();
  assert.ok(
    await page
      .getByRole("button", { name: "提交管理员排空证明", exact: true })
      .isDisabled(),
    "An online runtime cannot be attested",
  );
  runtime.status = "OFFLINE";
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await page
    .getByRole("button", { name: "提交管理员排空证明", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "恢复原节点", exact: true })
    .waitFor();

  await page
    .getByLabel("恢复核验说明", { exact: true })
    .fill("原服务已经停止，原宿主及存储目录完整保留。");
  await page
    .getByLabel("原宿主与存储核验证据（每行一条）", { exact: true })
    .fill("operations://storage/123");
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "签发一次性恢复票据", exact: true })
    .click();
  await page
    .getByLabel("一次性恢复票据", { exact: true })
    .filter({ hasNot: page.locator("section") })
    .first()
    .waitFor();
  assert.equal(
    await page.locator("textarea[readonly]").inputValue(),
    "fixture-token-1",
  );
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  assert.equal(
    await page.locator("textarea[readonly]").inputValue(),
    "fixture-token-1",
  );
  await screenshot("node-resume");
  tokenFailure = true;
  await page
    .getByRole("button", { name: "重新签发恢复票据", exact: true })
    .click();
  await page.getByText("fixture ticket failure", { exact: true }).waitFor();
  assert.equal(
    await page.locator("textarea[readonly]").count(),
    0,
    "An uncertain reissue must hide the older credential",
  );
  tokenFailure = false;
  await page
    .getByRole("button", { name: "签发一次性恢复票据", exact: true })
    .click();
  await page.locator("textarea[readonly]").waitFor();
  await page.clock.runFor(601_000);
  await page.getByText(/恢复票据已过期/).waitFor();
  assert.equal(await page.locator("textarea[readonly]").count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/console/access/recoveries`);
  await page.getByRole("heading", { name: "会话恢复", exact: true }).waitFor();
  await screenshot("mobile-list");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile overflow must stay inside the table",
  );
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: independent node recovery, credential refresh/reissue/expiry and mobile layout",
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
}
