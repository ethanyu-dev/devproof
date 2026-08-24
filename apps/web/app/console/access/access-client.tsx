"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CheckCircle2,
  Clipboard,
  KeyRound,
  Link2,
  MonitorUp,
  Plus,
  RefreshCw,
  Route,
  Save,
  ServerCog,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  Textarea,
  Toggle,
} from "@devproof/ui";

import { PageHeader } from "@/components/page-header";
import {
  ErrorState,
  FormMessage,
  LoadingState,
} from "@/components/settings-layout";
import { consoleApi } from "@/lib/api";
import { displayLabel } from "@/lib/display-text";

type Scope =
  | "verification:read"
  | "verification:write"
  | "verification:cancel"
  | "profile:delete"
  | "run:read"
  | "run:write"
  | "run:cancel"
  | "runtime:lease";

interface BrowserRuntime {
  capabilities: string[];
  deviceInfo: string;
  enabled: boolean;
  id: string;
  instanceKey: string;
  lastSeenAt: string | null;
  maxConcurrency: number;
  name: string;
  networkAllowlist: string[];
  protocolMinor: number | null;
  status: "ONLINE" | "OFFLINE" | "REVOKED";
  tokenHint: string;
  version: string;
}

interface RuntimeSettings {
  hitlEnabled: boolean;
}

type RoutingFallbackPolicy = "WAIT" | "FAIL_FAST";

interface RuntimeRoutingRule {
  createdAt: string;
  enabled: boolean;
  fallbackPolicy: RoutingFallbackPolicy;
  hostnamePattern: string;
  id: string;
  priority: number;
  runtime: { id: string; name: string; revokedAt: string | null };
  runtimeId: string;
  updatedAt: string;
}

interface ToolCredential {
  createdAt: string;
  expiresAt: string | null;
  id: string;
  lastUsedAt: string | null;
  name: string;
  revokedAt: string | null;
  scopes: Scope[];
  tokenHint: string;
}

interface IssuedCredential extends Omit<
  ToolCredential,
  "lastUsedAt" | "revokedAt"
> {
  token: string;
}

interface Feedback {
  text: string;
  tone: "error" | "success";
}

const defaultSettings: RuntimeSettings = {
  hitlEnabled: true,
};

const agentScopes: Scope[] = ["run:read", "run:write", "run:cancel"];

const runtimeScopes: Scope[] = ["runtime:lease"];

const runtimeApiUrl =
  process.env.NEXT_PUBLIC_RUNTIME_API_URL ?? "http://localhost:4433";
const mcpEndpoint = `${runtimeApiUrl.replace(/\/$/, "")}/mcp`;
const runtimeInstallCommand =
  "curl -fsSL https://github.com/ethanyu-dev/devproof/releases/latest/download/install.sh | bash";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runtimeTone(status: BrowserRuntime["status"]) {
  if (status === "ONLINE") return "success" as const;
  if (status === "REVOKED") return "danger" as const;
  return "warning" as const;
}

export function AccessClient() {
  const [runtimes, setRuntimes] = useState<BrowserRuntime[] | null>(null);
  const [settings, setSettings] = useState<RuntimeSettings>(defaultSettings);
  const [routingRules, setRoutingRules] = useState<RuntimeRoutingRule[] | null>(
    null,
  );
  const [credentials, setCredentials] = useState<ToolCredential[] | null>(null);
  const [pairing, setPairing] = useState<{
    command: string;
    expiresAt: string;
  } | null>(null);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [credentialName, setCredentialName] = useState("");
  const [credentialPurpose, setCredentialPurpose] = useState<
    "AGENT" | "AGENT_RUNTIME"
  >("AGENT");
  const [expiresAt, setExpiresAt] = useState("");
  const [routePattern, setRoutePattern] = useState("");
  const [routeRuntimeId, setRouteRuntimeId] = useState("");
  const [routeFallback, setRouteFallback] =
    useState<RoutingFallbackPolicy>("WAIT");
  const [routePriority, setRoutePriority] = useState("100");
  const [policyRuntimeId, setPolicyRuntimeId] = useState("");
  const [runtimeMaxConcurrency, setRuntimeMaxConcurrency] = useState("1");
  const [networkAllowlistText, setNetworkAllowlistText] = useState("");
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [savingRoute, setSavingRoute] = useState(false);
  const [savingRuntimeConfiguration, setSavingRuntimeConfiguration] =
    useState(false);
  const [runtimeConfigurationMessage, setRuntimeConfigurationMessage] =
    useState<Feedback | null>(null);
  const [creatingCredential, setCreatingCredential] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState<Feedback | null>(null);
  const [routingMessage, setRoutingMessage] = useState<Feedback | null>(null);
  const [credentialMessage, setCredentialMessage] = useState<Feedback | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingItem, setPendingItem] = useState<string | null>(null);
  const pairingRef = useRef<HTMLDivElement>(null);
  const issuedRef = useRef<HTMLDivElement>(null);

  const activeCredentials = useMemo(
    () => credentials?.filter((row) => !row.revokedAt) ?? [],
    [credentials],
  );
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [runtimeRows, currentSettings, routeRows, credentialRows] =
        await Promise.all([
          consoleApi<BrowserRuntime[]>("/browser-runtimes"),
          consoleApi<RuntimeSettings>("/runtime-settings"),
          consoleApi<RuntimeRoutingRule[]>("/runtime-routing-rules"),
          consoleApi<ToolCredential[]>("/tool-credentials"),
        ]);
      setRuntimes(runtimeRows);
      setSettings(currentSettings);
      setRoutingRules(routeRows);
      setCredentials(credentialRows);
      setRouteRuntimeId(
        (current) =>
          current ||
          runtimeRows.find((runtime) => runtime.status !== "REVOKED")?.id ||
          "",
      );
      setPolicyRuntimeId(
        (current) =>
          (current && runtimeRows.some((runtime) => runtime.id === current)
            ? current
            : runtimeRows.find((runtime) => runtime.status !== "REVOKED")
                ?.id) || "",
      );
    } catch (error) {
      setLoadError((error as Error).message);
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (!pairing) return;
    pairingRef.current?.focus({ preventScroll: true });
    pairingRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [pairing]);

  useEffect(() => {
    if (!issued) return;
    issuedRef.current?.focus({ preventScroll: true });
    issuedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [issued]);

  useEffect(() => {
    const runtime = runtimes?.find((row) => row.id === policyRuntimeId);
    setRuntimeMaxConcurrency(String(runtime?.maxConcurrency ?? 1));
    setNetworkAllowlistText(runtime?.networkAllowlist.join("\n") ?? "");
  }, [policyRuntimeId, runtimes]);

  function networkAllowlistEntries(value: string) {
    return [
      ...new Set(
        value
          .split(/[\n,]/u)
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    ];
  }

  async function saveRuntime() {
    setSavingRuntime(true);
    setRuntimeMessage(null);
    try {
      const row = await consoleApi<RuntimeSettings>("/runtime-settings", {
        body: JSON.stringify(settings),
        method: "PUT",
      });
      setSettings(row);
      setRuntimeMessage({ text: "团队执行策略已更新。", tone: "success" });
    } catch (error) {
      setRuntimeMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setSavingRuntime(false);
    }
  }

  async function createPairingToken() {
    if (pendingItem) return;
    setPendingItem("pairing");
    setRuntimeMessage(null);
    try {
      const result = await consoleApi<{
        expiresAt: string;
        pairingToken: string;
      }>("/browser-runtimes/pairing-tokens", { method: "POST" });
      const command =
        "$HOME/.local/bin/devproof-browser-runtime pair --api " +
        shellQuote(runtimeApiUrl) +
        " --token " +
        shellQuote(result.pairingToken) +
        " && systemctl --user restart devproof-browser-runtime.service";
      setPairing({ command, expiresAt: result.expiresAt });
      setRuntimeMessage({
        text: "一次性配对命令已生成，请在 10 分钟内使用。",
        tone: "success",
      });
    } catch (error) {
      setRuntimeMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setPendingItem(null);
    }
  }

  async function saveRuntimeConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!policyRuntimeId) return;
    const maxConcurrency = Number(runtimeMaxConcurrency);
    if (
      !Number.isInteger(maxConcurrency) ||
      maxConcurrency < 1 ||
      maxConcurrency > 32
    ) {
      const errorText = "并发容量必须是 1 到 32 之间的整数。";
      setRuntimeConfigurationMessage({ text: errorText, tone: "error" });
      return;
    }
    setSavingRuntimeConfiguration(true);
    setRuntimeConfigurationMessage(null);
    try {
      const runtime = await consoleApi<BrowserRuntime>(
        `/browser-runtimes/${policyRuntimeId}/configuration`,
        {
          body: JSON.stringify({
            maxConcurrency,
            networkAllowlist: networkAllowlistEntries(networkAllowlistText),
          }),
          method: "PUT",
        },
      );
      setRuntimes(
        (rows) =>
          rows?.map((row) => (row.id === runtime.id ? runtime : row)) ?? null,
      );
      setRuntimeMaxConcurrency(String(runtime.maxConcurrency));
      setNetworkAllowlistText(runtime.networkAllowlist.join("\n"));
      const successText =
        runtime.status === "ONLINE" && (runtime.protocolMinor ?? 0) >= 4
          ? "Runtime 配置已保存；并发容量已生效，网络白名单已下发。"
          : (runtime.protocolMinor ?? 0) >= 4
            ? "Runtime 配置已保存；并发容量已生效，网络白名单将在 Runtime 上线后同步。"
            : "Runtime 配置已保存；并发容量已生效，升级并重新连接 Runtime 后网络白名单生效。";
      setRuntimeConfigurationMessage({
        text: successText,
        tone: "success",
      });
    } catch (error) {
      const errorText = (error as Error).message;
      setRuntimeConfigurationMessage({ text: errorText, tone: "error" });
    } finally {
      setSavingRuntimeConfiguration(false);
    }
  }

  async function revokeRuntime(runtime: BrowserRuntime) {
    if (pendingItem) return;
    if (!window.confirm(`撤销 Runtime“${runtime.name}”的连接凭证？`)) {
      return;
    }
    setPendingItem(`runtime:${runtime.id}`);
    setRuntimeMessage(null);
    try {
      await consoleApi(`/browser-runtimes/${runtime.id}`, { method: "DELETE" });
      await load();
      setRuntimeMessage({
        text: "Runtime 连接凭证已撤销。",
        tone: "success",
      });
    } catch (error) {
      setRuntimeMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setPendingItem(null);
    }
  }

  async function createRoutingRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingRoute(true);
    setRoutingMessage(null);
    try {
      await consoleApi<RuntimeRoutingRule>("/runtime-routing-rules", {
        body: JSON.stringify({
          enabled: true,
          fallbackPolicy: routeFallback,
          hostnamePattern: routePattern,
          priority: Number(routePriority),
          runtimeId: routeRuntimeId,
        }),
        method: "POST",
      });
      setRoutePattern("");
      setRoutingRules(
        await consoleApi<RuntimeRoutingRule[]>("/runtime-routing-rules"),
      );
      setRoutingMessage({
        text: "Runtime 域名路由规则已创建。",
        tone: "success",
      });
    } catch (error) {
      setRoutingMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setSavingRoute(false);
    }
  }

  async function setRoutingRuleEnabled(
    rule: RuntimeRoutingRule,
    enabled: boolean,
  ) {
    if (pendingItem) return;
    setPendingItem(`route:${rule.id}`);
    setRoutingMessage(null);
    try {
      await consoleApi<RuntimeRoutingRule>(
        `/runtime-routing-rules/${rule.id}`,
        {
          body: JSON.stringify({
            enabled,
            fallbackPolicy: rule.fallbackPolicy,
            hostnamePattern: rule.hostnamePattern,
            priority: rule.priority,
            runtimeId: rule.runtimeId,
          }),
          method: "PUT",
        },
      );
      setRoutingRules(
        await consoleApi<RuntimeRoutingRule[]>("/runtime-routing-rules"),
      );
      setRoutingMessage({
        text: enabled ? "路由规则已启用。" : "路由规则已停用。",
        tone: "success",
      });
    } catch (error) {
      setRoutingMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setPendingItem(null);
    }
  }

  async function deleteRoutingRule(rule: RuntimeRoutingRule) {
    if (pendingItem) return;
    if (!window.confirm(`删除域名路由规则“${rule.hostnamePattern}”？`)) {
      return;
    }
    setPendingItem(`route:${rule.id}`);
    setRoutingMessage(null);
    try {
      await consoleApi(`/runtime-routing-rules/${rule.id}`, {
        method: "DELETE",
      });
      setRoutingRules(
        await consoleApi<RuntimeRoutingRule[]>("/runtime-routing-rules"),
      );
      setRoutingMessage({
        text: "Runtime 域名路由规则已删除。",
        tone: "success",
      });
    } catch (error) {
      setRoutingMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setPendingItem(null);
    }
  }

  async function createCredential() {
    setCreatingCredential(true);
    setCredentialMessage(null);
    try {
      const credential = await consoleApi<IssuedCredential>(
        "/tool-credentials",
        {
          body: JSON.stringify({
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            name: credentialName,
            scopes:
              credentialPurpose === "AGENT_RUNTIME"
                ? runtimeScopes
                : agentScopes,
          }),
          method: "POST",
        },
      );
      setIssued(credential);
      setCredentialName("");
      setExpiresAt("");
      const rows = await consoleApi<ToolCredential[]>("/tool-credentials");
      setCredentials(rows);
      setCredentialMessage({
        text: "访问 Token 已生成。明文只显示这一次，请立即保存。",
        tone: "success",
      });
    } catch (error) {
      setCredentialMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setCreatingCredential(false);
    }
  }

  async function revokeCredential(row: ToolCredential) {
    if (pendingItem) return;
    if (!window.confirm(`撤销 MCP Token“${row.name}”？`)) {
      return;
    }
    setPendingItem(`credential:${row.id}`);
    setCredentialMessage(null);
    try {
      await consoleApi(`/tool-credentials/${row.id}`, { method: "DELETE" });
      const rows = await consoleApi<ToolCredential[]>("/tool-credentials");
      setCredentials(rows);
      setCredentialMessage({ text: "访问 Token 已撤销。", tone: "success" });
    } catch (error) {
      setCredentialMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setPendingItem(null);
    }
  }

  async function copy(
    value: string,
    successMessage: string,
    target: "credential" | "runtime",
  ) {
    const setFeedback =
      target === "runtime" ? setRuntimeMessage : setCredentialMessage;
    try {
      await navigator.clipboard.writeText(value);
      setFeedback({ text: successMessage, tone: "success" });
    } catch {
      setFeedback({
        text: "无法写入剪贴板，请手动选择并复制。",
        tone: "error",
      });
    }
  }

  const loaded =
    runtimes !== null && routingRules !== null && credentials !== null;

  return (
    <>
      <PageHeader
        actions={
          <Button
            disabled={loading}
            onClick={() => void load().catch(() => undefined)}
            variant="secondary"
          >
            <RefreshCw />
            {loading ? "刷新中…" : "刷新状态"}
          </Button>
        }
        title="接入配置"
      />

      {loadError && loaded ? (
        <div className="dp-runtime-message">
          <FormMessage message={loadError} tone="error" />
        </div>
      ) : null}

      {!loaded ? (
        <Card>
          {loadError ? (
            <ErrorState
              message={loadError}
              onRetry={() => void load().catch(() => undefined)}
            />
          ) : (
            <LoadingState />
          )}
        </Card>
      ) : (
        <>
          <section className="dp-access-module" id="runtime">
            <h2 className="dp-console-section-title">执行 Runtime</h2>

            {runtimeMessage ? (
              <div className="dp-runtime-message">
                <FormMessage
                  message={runtimeMessage.text}
                  tone={runtimeMessage.tone}
                />
              </div>
            ) : null}

            <Card className="dp-pairing-panel">
              <div>
                <p>安装或升级命令</p>
                <code>{runtimeInstallCommand}</code>
                <small>
                  首次注册先在 Linux Runtime
                  主机执行；后续升级重复执行同一命令即可。
                </small>
              </div>
              <Button
                onClick={() =>
                  void copy(
                    runtimeInstallCommand,
                    "Runtime 安装命令已复制。",
                    "runtime",
                  )
                }
                variant="secondary"
              >
                <Clipboard />
                复制
              </Button>
            </Card>

            {pairing ? (
              <Card className="dp-pairing-panel" ref={pairingRef} tabIndex={-1}>
                <div>
                  <p>一次性配对命令</p>
                  <code>{pairing.command}</code>
                  <small>
                    10 分钟内有效，成功配对后立即失效。有效期至{" "}
                    {new Date(pairing.expiresAt).toLocaleTimeString("zh-CN")}。
                  </small>
                </div>
                <Button
                  onClick={() =>
                    void copy(
                      pairing.command,
                      "Runtime 配对命令已复制。",
                      "runtime",
                    )
                  }
                  variant="secondary"
                >
                  <Clipboard />
                  复制
                </Button>
              </Card>
            ) : null}

            <div className="dp-runtime-layout">
              <div className="dp-runtime-primary">
                <Card className="dp-runtime-section">
                  <div className="dp-section-head">
                    <span>
                      <ServerCog />
                      <b>团队执行策略</b>
                    </span>
                    <Badge tone="neutral">团队级</Badge>
                  </div>
                  <div className="dp-section-body dp-form">
                    <p className="dp-section-note">
                      Runtime 只负责浏览器执行、证据采集与人工接管。Runtime
                      选择由域名规则决定，浏览器 Profile 由每次验证显式指定。
                    </p>
                    <div className="dp-form-grid">
                      <Toggle
                        checked={settings.hitlEnabled}
                        label="允许验证过程中人工接管"
                        onChange={(hitlEnabled) =>
                          setSettings({ ...settings, hitlEnabled })
                        }
                      />
                    </div>
                    <div className="dp-config-actions">
                      <span>
                        <ShieldCheck /> 团队级配置会写入审计记录
                      </span>
                      <Button disabled={savingRuntime} onClick={saveRuntime}>
                        <Save />
                        {savingRuntime ? "保存中…" : "保存策略"}
                      </Button>
                    </div>
                  </div>
                </Card>
              </div>

              <aside className="dp-runtime-aside">
                <Card className="dp-runtime-section">
                  <div className="dp-section-head">
                    <span>
                      <MonitorUp />
                      <b>可用 Runtime</b>
                    </span>
                    <Button
                      disabled={pendingItem !== null}
                      onClick={createPairingToken}
                      variant="secondary"
                    >
                      <Link2 />
                      {pendingItem === "pairing" ? "生成中…" : "注册"}
                    </Button>
                  </div>
                  <div className="dp-runtime-list">
                    {runtimes.length ? (
                      runtimes.map((runtime) => (
                        <div className="dp-runtime-item" key={runtime.id}>
                          <div>
                            <i
                              className={`status ${runtime.status.toLowerCase()}`}
                            />
                            <span>
                              <strong>{runtime.name}</strong>
                              <small>
                                {runtime.deviceInfo || runtime.instanceKey}
                              </small>
                            </span>
                            <Badge tone={runtimeTone(runtime.status)}>
                              {displayLabel(runtime.status)}
                            </Badge>
                          </div>
                          <dl>
                            <div>
                              <dt>版本</dt>
                              <dd>{runtime.version || "未知"}</dd>
                            </div>
                            <div>
                              <dt>并发容量</dt>
                              <dd>{runtime.maxConcurrency}</dd>
                            </div>
                            <div>
                              <dt>最后在线</dt>
                              <dd>
                                {runtime.lastSeenAt
                                  ? new Date(
                                      runtime.lastSeenAt,
                                    ).toLocaleTimeString("zh-CN")
                                  : "从未"}
                              </dd>
                            </div>
                          </dl>
                          {runtime.status !== "REVOKED" ? (
                            <Button
                              disabled={pendingItem !== null}
                              onClick={() => revokeRuntime(runtime)}
                              variant="ghost"
                            >
                              <Trash2 />
                              撤销连接凭证
                            </Button>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div className="dp-runtime-empty">
                        <MonitorUp />
                        <strong>尚未注册 Runtime</strong>
                        <span>生成一次性命令并在执行机器运行。</span>
                      </div>
                    )}
                  </div>
                </Card>
              </aside>
            </div>

            <Card className="dp-runtime-section dp-network-policy-card">
              <div className="dp-section-head">
                <span>
                  <ShieldCheck />
                  <b>Runtime 访问与容量</b>
                </span>
                <Badge tone="warning">默认拦截内网</Badge>
              </div>
              <div className="dp-section-body">
                <p className="dp-section-note">
                  每个 Runtime
                  独立维护并发容量与允许访问的内网主机。容量由控制台控制，网络策略实时下发；未配置白名单的
                  Runtime 继续拒绝私网、loopback、link-local 与 metadata 地址。
                </p>
                <form
                  className="dp-network-policy-form"
                  onSubmit={saveRuntimeConfiguration}
                >
                  <Field label="目标 Runtime">
                    <Select
                      onChange={(event) => {
                        setPolicyRuntimeId(event.target.value);
                        setRuntimeConfigurationMessage(null);
                      }}
                      required
                      value={policyRuntimeId}
                    >
                      <option value="">选择 Runtime</option>
                      {runtimes
                        .filter((runtime) => runtime.status !== "REVOKED")
                        .map((runtime) => (
                          <option key={runtime.id} value={runtime.id}>
                            {runtime.name} · {displayLabel(runtime.status)}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <Field
                    description="允许同时占用的浏览器会话数，范围 1–32；降低容量不会中断正在执行的会话。"
                    label="并发容量"
                  >
                    <Input
                      max={32}
                      min={1}
                      onChange={(event) => {
                        setRuntimeMaxConcurrency(event.target.value);
                        setRuntimeConfigurationMessage(null);
                      }}
                      required
                      type="number"
                      value={runtimeMaxConcurrency}
                    />
                  </Field>
                  <Field
                    description="每行一个精确主机名或 *.example.com 通配规则；留空即恢复默认拦截。"
                    label="允许访问的主机"
                  >
                    <Textarea
                      autoCapitalize="none"
                      autoCorrect="off"
                      onChange={(event) => {
                        setNetworkAllowlistText(event.target.value);
                        setRuntimeConfigurationMessage(null);
                      }}
                      placeholder={"test-console.paigod.work\n*.corp.example"}
                      rows={4}
                      spellCheck={false}
                      value={networkAllowlistText}
                    />
                  </Field>
                  <div className="dp-network-policy-actions">
                    <span>
                      {networkAllowlistEntries(networkAllowlistText).length}{" "}
                      条放行规则 · 容量 {runtimeMaxConcurrency || "—"}
                    </span>
                    {policyRuntimeId &&
                    (runtimes.find((row) => row.id === policyRuntimeId)
                      ?.protocolMinor ?? 0) < 4 ? (
                      <Badge tone="warning">Runtime 需升级后生效</Badge>
                    ) : null}
                    <Button
                      disabled={savingRuntimeConfiguration || !policyRuntimeId}
                      type="submit"
                    >
                      <Save />
                      {savingRuntimeConfiguration ? "保存中…" : "保存并下发"}
                    </Button>
                  </div>
                  {runtimeConfigurationMessage ? (
                    <div
                      aria-live="polite"
                      className="dp-network-policy-feedback"
                    >
                      <FormMessage
                        message={runtimeConfigurationMessage.text}
                        tone={runtimeConfigurationMessage.tone}
                      />
                    </div>
                  ) : null}
                </form>
              </div>
            </Card>

            <Card className="dp-runtime-section dp-routing-card">
              <div className="dp-section-head">
                <span>
                  <Route />
                  <b>域名路由策略</b>
                </span>
                <span className="dp-count">{routingRules.length} 条规则</span>
              </div>
              <div className="dp-section-body">
                <p className="dp-section-note">
                  DevProof 完全根据验证目标域名选择 Runtime。精确域名优先于
                  同优先级的通配规则；未命中规则时从可用节点中随机分配。
                </p>
                {routingMessage ? (
                  <FormMessage
                    message={routingMessage.text}
                    tone={routingMessage.tone}
                  />
                ) : null}
                <form className="dp-routing-form" onSubmit={createRoutingRule}>
                  <Field
                    description="支持精确域名或前缀通配符。"
                    label="域名规则"
                  >
                    <Input
                      autoCapitalize="none"
                      autoCorrect="off"
                      onChange={(event) => setRoutePattern(event.target.value)}
                      placeholder="*.staging.example.com"
                      required
                      spellCheck={false}
                      value={routePattern}
                    />
                  </Field>
                  <Field label="目标 Runtime">
                    <Select
                      onChange={(event) =>
                        setRouteRuntimeId(event.target.value)
                      }
                      required
                      value={routeRuntimeId}
                    >
                      <option value="">选择 Runtime</option>
                      {runtimes
                        .filter((runtime) => runtime.status !== "REVOKED")
                        .map((runtime) => (
                          <option key={runtime.id} value={runtime.id}>
                            {runtime.name} · {displayLabel(runtime.status)}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <Field label="节点不可用时">
                    <Select
                      onChange={(event) =>
                        setRouteFallback(
                          event.target.value as RoutingFallbackPolicy,
                        )
                      }
                      value={routeFallback}
                    >
                      <option value="WAIT">等待目标 Runtime</option>
                      <option value="FAIL_FAST">立即失败</option>
                    </Select>
                  </Field>
                  <Field
                    description="数值越大，重叠的域名规则越先匹配。"
                    label="优先级"
                  >
                    <Input
                      max="1000"
                      min="0"
                      onChange={(event) => setRoutePriority(event.target.value)}
                      required
                      type="number"
                      value={routePriority}
                    />
                  </Field>
                  <Button
                    disabled={
                      savingRoute || !routePattern.trim() || !routeRuntimeId
                    }
                    type="submit"
                  >
                    <Plus />
                    {savingRoute ? "添加中…" : "添加规则"}
                  </Button>
                </form>

                {routingRules.length ? (
                  <div className="dp-routing-list">
                    {routingRules.map((rule) => (
                      <div className="dp-routing-rule" key={rule.id}>
                        <div>
                          <code>{rule.hostnamePattern}</code>
                          <Badge tone={rule.enabled ? "success" : "neutral"}>
                            {rule.enabled ? "已启用" : "已停用"}
                          </Badge>
                        </div>
                        <span>
                          <strong>{rule.runtime.name}</strong>
                          <small>
                            优先级 {rule.priority} ·{" "}
                            {displayLabel(rule.fallbackPolicy)}
                          </small>
                        </span>
                        <Toggle
                          checked={rule.enabled}
                          disabled={
                            Boolean(rule.runtime.revokedAt) ||
                            pendingItem !== null
                          }
                          label="启用"
                          onChange={(enabled) =>
                            void setRoutingRuleEnabled(rule, enabled)
                          }
                        />
                        <Button
                          aria-label={`删除 ${rule.hostnamePattern}`}
                          disabled={pendingItem !== null}
                          onClick={() => deleteRoutingRule(rule)}
                          variant="ghost"
                        >
                          <Trash2 />
                          删除
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="dp-routing-empty">
                    尚无域名规则；验证会从在线且能力匹配的 Runtime 中随机分配。
                  </div>
                )}
              </div>
            </Card>
          </section>

          <section className="dp-access-module" id="mcp">
            <h2 className="dp-console-section-title">MCP 接入</h2>

            {credentialMessage ? (
              <div className="dp-runtime-message">
                <FormMessage
                  message={credentialMessage.text}
                  tone={credentialMessage.tone}
                />
              </div>
            ) : null}

            {issued ? (
              <Card className="dp-pairing-panel" ref={issuedRef} tabIndex={-1}>
                <div>
                  <p>一次性访问 Token</p>
                  <code>{issued.token}</code>
                  <small>明文只显示这一次；数据库仅保存 SHA-256 哈希。</small>
                </div>
                <Button
                  onClick={() =>
                    void copy(issued.token, "访问 Token 已复制。", "credential")
                  }
                  variant="secondary"
                >
                  <Clipboard />
                  复制
                </Button>
              </Card>
            ) : null}

            <div className="dp-runtime-layout">
              <div className="dp-runtime-primary">
                <Card className="dp-runtime-section">
                  <div className="dp-section-head">
                    <span>
                      <Plus />
                      <b>生成访问 Token</b>
                    </span>
                    <Badge>团队级</Badge>
                  </div>
                  <div className="dp-section-body dp-form">
                    <div className="dp-mcp-endpoint">
                      <span>
                        <small>Streamable HTTP 端点</small>
                        <code>{mcpEndpoint}</code>
                      </span>
                      <Badge tone="success">Bearer Token</Badge>
                    </div>
                    <div className="dp-form-grid">
                      <Field label="Token 用途">
                        <Select
                          onChange={(event) =>
                            setCredentialPurpose(
                              event.target.value as "AGENT" | "AGENT_RUNTIME",
                            )
                          }
                          value={credentialPurpose}
                        >
                          <option value="AGENT">执行 Agent（管理 Run）</option>
                          <option value="AGENT_RUNTIME">
                            执行 Worker（仅领取租约）
                          </option>
                        </Select>
                      </Field>
                      <Field label="Token 名称">
                        <Input
                          onChange={(event) =>
                            setCredentialName(event.target.value)
                          }
                          placeholder="Codex 生产环境"
                          value={credentialName}
                        />
                      </Field>
                      <Field description="留空表示长期有效。" label="过期时间">
                        <Input
                          onChange={(event) => setExpiresAt(event.target.value)}
                          type="datetime-local"
                          value={expiresAt}
                        />
                      </Field>
                    </div>
                    <div className="dp-scope-summary">
                      <CheckCircle2 />
                      <span>
                        {credentialPurpose === "AGENT_RUNTIME"
                          ? "仅包含 Runtime 租约权限，不能读取、创建或取消 Run。"
                          : "包含 Run 的读取、创建与取消权限；不包含 Runtime 租约。"}
                      </span>
                    </div>
                    <div className="dp-config-actions">
                      <span>用于 MCP 握手及后续 tools/call 请求</span>
                      <Button
                        disabled={creatingCredential || !credentialName}
                        onClick={createCredential}
                      >
                        <KeyRound />
                        {creatingCredential ? "生成中…" : "生成 Token"}
                      </Button>
                    </div>
                  </div>
                </Card>
              </div>

              <aside className="dp-runtime-aside">
                <Card className="dp-runtime-section">
                  <div className="dp-section-head">
                    <span>
                      <KeyRound />
                      <b>访问 Token</b>
                    </span>
                    <span className="dp-count">
                      {activeCredentials.length} 个可用
                    </span>
                  </div>
                  <div className="dp-runtime-list">
                    {credentials.length ? (
                      credentials.map((row) => (
                        <div className="dp-runtime-item" key={row.id}>
                          <div>
                            <span>
                              <strong>{row.name}</strong>
                              <small>
                                {row.tokenHint} · {credentialPurposeLabel(row)}
                              </small>
                            </span>
                            <Badge tone={row.revokedAt ? "danger" : "success"}>
                              {row.revokedAt ? "已撤销" : "可用"}
                            </Badge>
                          </div>
                          <dl>
                            <div>
                              <dt>权限</dt>
                              <dd>{scopeLabel(row.scopes)}</dd>
                            </div>
                            <div>
                              <dt>最后使用</dt>
                              <dd>
                                {row.lastUsedAt
                                  ? new Date(row.lastUsedAt).toLocaleDateString(
                                      "zh-CN",
                                    )
                                  : "从未"}
                              </dd>
                            </div>
                            <div>
                              <dt>过期时间</dt>
                              <dd>
                                {row.expiresAt
                                  ? new Date(row.expiresAt).toLocaleDateString(
                                      "zh-CN",
                                    )
                                  : "永不过期"}
                              </dd>
                            </div>
                          </dl>
                          {!row.revokedAt ? (
                            <Button
                              disabled={pendingItem !== null}
                              onClick={() => revokeCredential(row)}
                              variant="ghost"
                            >
                              <Trash2 />
                              撤销 Token
                            </Button>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div className="dp-runtime-empty">
                        <KeyRound />
                        <strong>尚未生成访问 Token</strong>
                        <span>生成后即可配置到外部 Agent。</span>
                      </div>
                    )}
                  </div>
                </Card>
              </aside>
            </div>
          </section>
        </>
      )}
    </>
  );
}

function credentialPurposeLabel(credential: Pick<ToolCredential, "scopes">) {
  return credential.scopes.includes("runtime:lease")
    ? "执行 Worker"
    : "执行 Agent";
}

function scopeLabel(scopes: Scope[]) {
  const labels: Record<Scope, string> = {
    "profile:delete": "删除 Profile",
    "run:cancel": "取消 Run",
    "run:read": "读取 Run",
    "run:write": "创建/更新 Run",
    "runtime:lease": "领取 Runtime 租约",
    "verification:cancel": "取消验证",
    "verification:read": "读取验证",
    "verification:write": "创建/更新验证",
  };
  return scopes.map((scope) => labels[scope]).join("、") || "无权限";
}
