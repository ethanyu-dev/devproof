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
  ArrowDown,
  ArrowUp,
  Bot,
  Cable,
  Clipboard,
  GitPullRequest,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/native-select";
import { Toggle } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

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
  | "run:cancel";

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

interface BrowserPoolCapacity {
  availableCapacity: number;
  configuredCapacity: number;
  drainingCapacity: number;
  flexibleWaiting: number;
  nodes: Array<{
    available: number;
    configured: number;
    draining: number;
    id: string;
    name: string;
    occupied: number;
    online: boolean;
    waiting: number;
  }>;
  occupiedCapacity: number;
  schedulableCapacity: number;
}

interface GithubAccessCredential {
  createdAt: string;
  enabled: boolean;
  id: string;
  name: string;
  organizations: string[];
  priority: number;
  repositories: string[];
  tokenHint: string;
  updatedAt: string;
}

interface AgentModelConfiguration {
  apiKeyHint: string;
  baseUrl: string;
  createdAt: string;
  displayName: string;
  id: string;
  modelId: string;
  position: number;
  updatedAt: string;
}

type AccessSection = "browser" | "github" | "agent-runtime" | "mcp";

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

const runtimeApiUrl =
  process.env.NEXT_PUBLIC_RUNTIME_API_URL ?? "http://localhost:4433";
const mcpEndpoint = `${runtimeApiUrl.replace(/\/$/, "")}/mcp`;
const runtimeInstallCommand =
  "curl -4 -fsSL https://github.com/ethanyu-dev/devproof/releases/latest/download/install.sh | bash";

const accessSections: Array<{
  icon: typeof MonitorUp;
  id: AccessSection;
  label: string;
}> = [
  {
    icon: MonitorUp,
    id: "browser",
    label: "浏览器执行节点配置",
  },
  {
    icon: GitPullRequest,
    id: "github",
    label: "GitHub 访问权限配置",
  },
  {
    icon: Bot,
    id: "agent-runtime",
    label: "Agent 模型配置",
  },
  {
    icon: Cable,
    id: "mcp",
    label: "MCP 配置",
  },
];

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runtimeTone(status: BrowserRuntime["status"]) {
  if (status === "ONLINE") return "success" as const;
  if (status === "REVOKED") return "danger" as const;
  return "warning" as const;
}

export function AccessClient() {
  const [activeSection, setActiveSection] = useState<AccessSection>("browser");
  const [runtimes, setRuntimes] = useState<BrowserRuntime[] | null>(null);
  const [browserPool, setBrowserPool] = useState<BrowserPoolCapacity | null>(
    null,
  );
  const [settings, setSettings] = useState<RuntimeSettings>(defaultSettings);
  const [githubCredentials, setGithubCredentials] = useState<
    GithubAccessCredential[] | null
  >(null);
  const [githubCredentialId, setGithubCredentialId] = useState<string | null>(
    null,
  );
  const [githubCredentialName, setGithubCredentialName] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [githubOrganizations, setGithubOrganizations] = useState("");
  const [githubRepositories, setGithubRepositories] = useState("");
  const [githubPriority, setGithubPriority] = useState("100");
  const [githubEnabled, setGithubEnabled] = useState(true);
  const [githubMessage, setGithubMessage] = useState<Feedback | null>(null);
  const [savingGithub, setSavingGithub] = useState(false);
  const [agentModels, setAgentModels] = useState<
    AgentModelConfiguration[] | null
  >(null);
  const [agentModelId, setAgentModelId] = useState<string | null>(null);
  const [agentModelBaseUrl, setAgentModelBaseUrl] = useState("");
  const [agentModelApiKey, setAgentModelApiKey] = useState("");
  const [agentModelModelId, setAgentModelModelId] = useState("");
  const [agentModelDisplayName, setAgentModelDisplayName] = useState("");
  const [savingAgentModel, setSavingAgentModel] = useState(false);
  const [agentRuntimeMessage, setAgentRuntimeMessage] =
    useState<Feedback | null>(null);
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

  const mcpCredentials = useMemo(
    () =>
      credentials?.filter(
        (row) => !(row.scopes as readonly string[]).includes("runtime:lease"),
      ) ?? [],
    [credentials],
  );
  const editedAgentModel = agentModels?.find(
    (model) => model.id === agentModelId,
  );
  const agentModelEndpointChanged = Boolean(
    editedAgentModel &&
    agentModelBaseUrl.trim().replace(/\/+$/u, "") !== editedAgentModel.baseUrl,
  );
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [
        runtimeRows,
        browserPoolCapacity,
        currentSettings,
        routeRows,
        credentialRows,
        githubRows,
        agentModelRows,
      ] = await Promise.all([
        consoleApi<BrowserRuntime[]>("/browser-runtimes"),
        consoleApi<BrowserPoolCapacity>("/browser-pool-capacity"),
        consoleApi<RuntimeSettings>("/runtime-settings"),
        consoleApi<RuntimeRoutingRule[]>("/runtime-routing-rules"),
        consoleApi<ToolCredential[]>("/tool-credentials"),
        consoleApi<GithubAccessCredential[]>("/github-access"),
        consoleApi<AgentModelConfiguration[]>("/agent-models"),
      ]);
      setRuntimes(runtimeRows);
      setBrowserPool(browserPoolCapacity);
      setSettings(currentSettings);
      setRoutingRules(routeRows);
      setCredentials(credentialRows);
      setGithubCredentials(githubRows);
      setAgentModels(agentModelRows);
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
      setBrowserPool(
        await consoleApi<BrowserPoolCapacity>("/browser-pool-capacity"),
      );
      const successText =
        runtime.status === "ONLINE" && (runtime.protocolMinor ?? 0) >= 4
          ? "执行节点配置已保存；并发容量已生效，网络白名单已下发。"
          : (runtime.protocolMinor ?? 0) >= 4
            ? "执行节点配置已保存；并发容量已生效，网络白名单将在节点上线后同步。"
            : "执行节点配置已保存；并发容量已生效，升级并重新连接节点后网络白名单生效。";
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
    if (!window.confirm(`撤销执行节点“${runtime.name}”的连接凭证？`)) {
      return;
    }
    setPendingItem(`runtime:${runtime.id}`);
    setRuntimeMessage(null);
    try {
      await consoleApi(`/browser-runtimes/${runtime.id}`, { method: "DELETE" });
      await load();
      setRuntimeMessage({
        text: "执行节点连接凭证已撤销。",
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
        text: "执行节点域名路由规则已创建。",
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
        text: "执行节点域名路由规则已删除。",
        tone: "success",
      });
    } catch (error) {
      setRoutingMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setPendingItem(null);
    }
  }

  function githubScopeEntries(value: string) {
    return [
      ...new Set(
        value
          .split(/[\n,]/u)
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
  }

  function githubRepositoryEntries(value: string, organizations: string[]) {
    const entries = githubScopeEntries(value);
    const defaultOwner = organizations.length === 1 ? organizations[0] : null;
    return entries.map((entry) => {
      if (entry.includes("/")) return entry;
      if (defaultOwner) return `${defaultOwner}/${entry}`;
      throw new Error(
        "精确仓库请填写 owner/repository；仅填写一个适用组织时可只写仓库名。",
      );
    });
  }

  function resetGithubCredentialForm() {
    setGithubCredentialId(null);
    setGithubCredentialName("");
    setGithubToken("");
    setGithubOrganizations("");
    setGithubRepositories("");
    setGithubPriority("100");
    setGithubEnabled(true);
    setGithubMessage(null);
  }

  function editGithubCredential(credential: GithubAccessCredential) {
    setGithubCredentialId(credential.id);
    setGithubCredentialName(credential.name);
    setGithubToken("");
    setGithubOrganizations(credential.organizations.join("\n"));
    setGithubRepositories(credential.repositories.join("\n"));
    setGithubPriority(String(credential.priority));
    setGithubEnabled(credential.enabled);
    setGithubMessage(null);
  }

  async function saveGithubCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !githubCredentialName.trim() ||
      (!githubCredentialId && !githubToken.trim())
    )
      return;
    setSavingGithub(true);
    setGithubMessage(null);
    try {
      const organizations = githubScopeEntries(githubOrganizations);
      const repositories = githubRepositoryEntries(
        githubRepositories,
        organizations,
      );
      const credential = await consoleApi<GithubAccessCredential>(
        githubCredentialId
          ? `/github-access/${githubCredentialId}`
          : "/github-access",
        {
          body: JSON.stringify({
            enabled: githubEnabled,
            name: githubCredentialName.trim(),
            organizations,
            priority: Number(githubPriority),
            repositories,
            ...(githubToken.trim()
              ? { personalAccessToken: githubToken.trim() }
              : {}),
          }),
          method: githubCredentialId ? "PUT" : "POST",
        },
      );
      setGithubCredentials(
        await consoleApi<GithubAccessCredential[]>("/github-access"),
      );
      editGithubCredential(credential);
      setGithubToken("");
      setGithubMessage({
        text: githubCredentialId
          ? "GitHub 凭证已更新；PAT 明文不会回显。"
          : "GitHub 凭证已加密保存；PAT 明文不会回显。",
        tone: "success",
      });
    } catch (error) {
      setGithubMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setSavingGithub(false);
    }
  }

  async function deleteGithubCredential(credential: GithubAccessCredential) {
    if (pendingItem) return;
    if (!window.confirm(`删除 GitHub 凭证“${credential.name}”？`)) return;
    setPendingItem(`github:${credential.id}`);
    setGithubMessage(null);
    try {
      await consoleApi(`/github-access/${credential.id}`, { method: "DELETE" });
      setGithubCredentials(
        await consoleApi<GithubAccessCredential[]>("/github-access"),
      );
      if (githubCredentialId === credential.id) resetGithubCredentialForm();
      setGithubMessage({ text: "GitHub 凭证已删除。", tone: "success" });
    } catch (error) {
      setGithubMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setPendingItem(null);
    }
  }

  function resetAgentModelForm() {
    setAgentModelId(null);
    setAgentModelBaseUrl("");
    setAgentModelApiKey("");
    setAgentModelModelId("");
    setAgentModelDisplayName("");
  }

  function editAgentModel(model: AgentModelConfiguration) {
    setAgentModelId(model.id);
    setAgentModelBaseUrl(model.baseUrl);
    setAgentModelApiKey("");
    setAgentModelModelId(model.modelId);
    setAgentModelDisplayName(model.displayName);
    setAgentRuntimeMessage(null);
  }

  async function saveAgentModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !agentModelBaseUrl.trim() ||
      !agentModelModelId.trim() ||
      !agentModelDisplayName.trim() ||
      (!agentModelId && !agentModelApiKey.trim()) ||
      (agentModelEndpointChanged && !agentModelApiKey.trim())
    )
      return;
    const editing = Boolean(agentModelId);
    setSavingAgentModel(true);
    setAgentRuntimeMessage(null);
    try {
      const model = await consoleApi<AgentModelConfiguration>(
        agentModelId ? `/agent-models/${agentModelId}` : "/agent-models",
        {
          body: JSON.stringify({
            baseUrl: agentModelBaseUrl.trim(),
            displayName: agentModelDisplayName.trim(),
            modelId: agentModelModelId.trim(),
            ...(agentModelApiKey.trim()
              ? { apiKey: agentModelApiKey.trim() }
              : {}),
          }),
          method: agentModelId ? "PUT" : "POST",
        },
      );
      setAgentModels(
        await consoleApi<AgentModelConfiguration[]>("/agent-models"),
      );
      if (editing) editAgentModel(model);
      else resetAgentModelForm();
      setAgentRuntimeMessage({
        text: editing
          ? "模型已更新；API Key 不会回显。"
          : "模型已添加，可继续添加下一个。",
        tone: "success",
      });
    } catch (error) {
      setAgentRuntimeMessage({
        text: (error as Error).message,
        tone: "error",
      });
    } finally {
      setSavingAgentModel(false);
    }
  }

  async function moveAgentModel(index: number, direction: -1 | 1) {
    if (!agentModels || pendingItem) return;
    const target = index + direction;
    if (target < 0 || target >= agentModels.length) return;
    const reordered = [...agentModels];
    const current = reordered[index];
    const adjacent = reordered[target];
    if (!current || !adjacent) return;
    reordered[index] = adjacent;
    reordered[target] = current;
    setPendingItem("agent-model-order");
    setAgentRuntimeMessage(null);
    try {
      const rows = await consoleApi<AgentModelConfiguration[]>(
        "/agent-models/order",
        {
          body: JSON.stringify({ ids: reordered.map((row) => row.id) }),
          method: "PUT",
        },
      );
      setAgentModels(rows);
      setAgentRuntimeMessage({
        text: "优先级已更新。",
        tone: "success",
      });
    } catch (error) {
      setAgentRuntimeMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setPendingItem(null);
    }
  }

  async function deleteAgentModel(model: AgentModelConfiguration) {
    if (pendingItem) return;
    if (!window.confirm(`删除模型“${model.displayName}”？`)) return;
    setPendingItem(`agent-model:${model.id}`);
    setAgentRuntimeMessage(null);
    try {
      await consoleApi(`/agent-models/${model.id}`, { method: "DELETE" });
      setAgentModels(
        await consoleApi<AgentModelConfiguration[]>("/agent-models"),
      );
      if (agentModelId === model.id) resetAgentModelForm();
      setAgentRuntimeMessage({ text: "模型已删除。", tone: "success" });
    } catch (error) {
      setAgentRuntimeMessage({ text: (error as Error).message, tone: "error" });
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
            scopes: agentScopes,
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
    runtimes !== null &&
    routingRules !== null &&
    credentials !== null &&
    githubCredentials !== null &&
    agentModels !== null;

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
        description="管理执行节点、代码平台凭证、模型与 Agent 接入 Token。"
        title="接入配置"
      />

      <nav aria-label="接入配置分类" className="dp-access-navigation">
        {accessSections.map((section) => {
          const Icon = section.icon;
          const active = activeSection === section.id;
          return (
            <button
              aria-pressed={active}
              className={active ? "active" : undefined}
              key={section.id}
              onClick={() => {
                setActiveSection(section.id);
                setIssued(null);
                setCredentialMessage(null);
              }}
              type="button"
            >
              <Icon />
              <strong>{section.label}</strong>
            </button>
          );
        })}
      </nav>

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
          {activeSection === "browser" ? (
            <section className="dp-access-module">
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
                </div>
                <Button
                  onClick={() =>
                    void copy(
                      runtimeInstallCommand,
                      "执行节点安装命令已复制。",
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
                <Card
                  className="dp-pairing-panel"
                  ref={pairingRef}
                  tabIndex={-1}
                >
                  <div>
                    <p>一次性配对命令</p>
                    <code>{pairing.command}</code>
                    <small>
                      10 分钟内有效，成功配对后立即失效。有效期至{" "}
                      {new Date(pairing.expiresAt).toLocaleTimeString("zh-CN")}
                      。
                    </small>
                  </div>
                  <Button
                    onClick={() =>
                      void copy(
                        pairing.command,
                        "执行节点配对命令已复制。",
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
                    </div>
                    <div className="dp-section-body dp-form">
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
                        <Button disabled={savingRuntime} onClick={saveRuntime}>
                          <Save />
                          {savingRuntime ? "保存中…" : "保存策略"}
                        </Button>
                      </div>
                      {browserPool ? (
                        <div className="dp-browser-pool-summary">
                          <span>
                            <b>{browserPool.configuredCapacity}</b>
                            <small>配置总容量</small>
                          </span>
                          <span>
                            <b>{browserPool.schedulableCapacity}</b>
                            <small>在线可调度</small>
                          </span>
                          <span>
                            <b>{browserPool.occupiedCapacity}</b>
                            <small>占用中</small>
                          </span>
                          <span>
                            <b>{browserPool.availableCapacity}</b>
                            <small>当前空闲</small>
                          </span>
                          <span>
                            <b>{browserPool.flexibleWaiting}</b>
                            <small>灵活队列等待</small>
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </Card>
                </div>

                <aside className="dp-runtime-aside">
                  <Card className="dp-runtime-section">
                    <div className="dp-section-head">
                      <span>
                        <MonitorUp />
                        <b>可用执行节点</b>
                      </span>
                      <span>
                        <span className="dp-count">
                          {
                            runtimes.filter(
                              (runtime) => runtime.status !== "REVOKED",
                            ).length
                          }{" "}
                          个可用
                        </span>
                        <Button
                          disabled={pendingItem !== null}
                          onClick={createPairingToken}
                          variant="secondary"
                        >
                          <Link2 />
                          {pendingItem === "pairing" ? "生成中…" : "注册"}
                        </Button>
                      </span>
                    </div>
                    <div
                      aria-label="浏览器执行节点列表"
                      className="dp-runtime-list"
                      role="region"
                      tabIndex={0}
                    >
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
                                <dd>
                                  {runtime.maxConcurrency}
                                  {browserPool?.nodes.find(
                                    (node) => node.id === runtime.id,
                                  ) ? (
                                    <small>
                                      {` · 占用 ${browserPool.nodes.find((node) => node.id === runtime.id)!.occupied} · 空闲 ${browserPool.nodes.find((node) => node.id === runtime.id)!.available} · 固定队列等待 ${browserPool.nodes.find((node) => node.id === runtime.id)!.waiting}`}
                                    </small>
                                  ) : null}
                                </dd>
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
                          <strong>尚未注册执行节点</strong>
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
                    <b>执行节点访问与容量</b>
                  </span>
                  <Badge tone="warning">默认拦截内网</Badge>
                </div>
                <div className="dp-section-body">
                  <form
                    className="dp-network-policy-form"
                    onSubmit={saveRuntimeConfiguration}
                  >
                    <Field label="目标执行节点">
                      <Select
                        onChange={(event) => {
                          setPolicyRuntimeId(event.target.value);
                          setRuntimeConfigurationMessage(null);
                        }}
                        required
                        value={policyRuntimeId}
                      >
                        <option value="">选择执行节点</option>
                        {runtimes
                          .filter((runtime) => runtime.status !== "REVOKED")
                          .map((runtime) => (
                            <option key={runtime.id} value={runtime.id}>
                              {runtime.name} · {displayLabel(runtime.status)}
                            </option>
                          ))}
                      </Select>
                    </Field>
                    <Field label="并发容量（1–32）">
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
                    <Field label="允许访问的主机（每行一条）">
                      <Textarea
                        autoCapitalize="none"
                        autoCorrect="off"
                        onChange={(event) => {
                          setNetworkAllowlistText(event.target.value);
                          setRuntimeConfigurationMessage(null);
                        }}
                        placeholder={"test-console.paigod.work\n*.corp.example"}
                        rows={3}
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
                        <Badge tone="warning">执行节点需升级后生效</Badge>
                      ) : null}
                      <Button
                        disabled={
                          savingRuntimeConfiguration || !policyRuntimeId
                        }
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
                  {routingMessage ? (
                    <FormMessage
                      message={routingMessage.text}
                      tone={routingMessage.tone}
                    />
                  ) : null}
                  <form
                    className="dp-routing-form"
                    onSubmit={createRoutingRule}
                  >
                    <Field label="域名规则">
                      <Input
                        autoCapitalize="none"
                        autoCorrect="off"
                        onChange={(event) =>
                          setRoutePattern(event.target.value)
                        }
                        placeholder="*.staging.example.com"
                        required
                        spellCheck={false}
                        value={routePattern}
                      />
                    </Field>
                    <Field label="目标执行节点">
                      <Select
                        onChange={(event) =>
                          setRouteRuntimeId(event.target.value)
                        }
                        required
                        value={routeRuntimeId}
                      >
                        <option value="">选择执行节点</option>
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
                        <option value="WAIT">等待目标执行节点</option>
                        <option value="FAIL_FAST">立即失败</option>
                      </Select>
                    </Field>
                    <Field label="优先级">
                      <Input
                        max="1000"
                        min="0"
                        onChange={(event) =>
                          setRoutePriority(event.target.value)
                        }
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
                      尚无域名规则；验证会从在线且能力匹配的执行节点中随机分配。
                    </div>
                  )}
                </div>
              </Card>
            </section>
          ) : null}

          {activeSection === "github" ? (
            <section className="dp-access-module">
              {githubMessage ? (
                <div className="dp-runtime-message">
                  <FormMessage
                    message={githubMessage.text}
                    tone={githubMessage.tone}
                  />
                </div>
              ) : null}
              <div className="dp-runtime-layout">
                <div className="dp-runtime-primary">
                  <Card className="dp-runtime-section">
                    <div className="dp-section-head">
                      <span>
                        <GitPullRequest />
                        <b>
                          {githubCredentialId ? "编辑" : "新增"} GitHub 凭证
                        </b>
                      </span>
                    </div>
                    <form
                      className="dp-section-body dp-form"
                      onSubmit={saveGithubCredential}
                    >
                      <div className="dp-form-grid">
                        <Field label="凭证名称">
                          <Input
                            onChange={(event) => {
                              setGithubCredentialName(event.target.value);
                              setGithubMessage(null);
                            }}
                            placeholder="组织 A · 生产主凭证"
                            required
                            value={githubCredentialName}
                          />
                        </Field>
                        <Field label="优先级">
                          <Input
                            max={1000}
                            min={0}
                            onChange={(event) =>
                              setGithubPriority(event.target.value)
                            }
                            required
                            type="number"
                            value={githubPriority}
                          />
                        </Field>
                      </div>
                      <div className="dp-form-grid">
                        <Field label="适用组织（每行一个）">
                          <Textarea
                            autoCapitalize="none"
                            autoCorrect="off"
                            onChange={(event) =>
                              setGithubOrganizations(event.target.value)
                            }
                            placeholder={"organization-a\norganization-b"}
                            rows={2}
                            spellCheck={false}
                            value={githubOrganizations}
                          />
                        </Field>
                        <Field label="精确仓库（每行一个）">
                          <Textarea
                            autoCapitalize="none"
                            autoCorrect="off"
                            onChange={(event) =>
                              setGithubRepositories(event.target.value)
                            }
                            placeholder={"core-api\norganization-b/web"}
                            rows={2}
                            spellCheck={false}
                            value={githubRepositories}
                          />
                        </Field>
                      </div>
                      <Field
                        label={
                          githubCredentialId
                            ? "替换 PAT（留空则保留）"
                            : "GitHub PAT"
                        }
                      >
                        <Input
                          autoCapitalize="none"
                          autoComplete="new-password"
                          autoCorrect="off"
                          onChange={(event) => {
                            setGithubToken(event.target.value);
                            setGithubMessage(null);
                          }}
                          placeholder="github_pat_••••••••"
                          required={!githubCredentialId}
                          spellCheck={false}
                          type="password"
                          value={githubToken}
                        />
                      </Field>
                      <Toggle
                        checked={githubEnabled}
                        label="启用该 GitHub 凭证"
                        onChange={setGithubEnabled}
                      />
                      <div className="dp-config-actions">
                        <span className="dp-inline-actions">
                          {githubCredentialId ? (
                            <Button
                              onClick={resetGithubCredentialForm}
                              type="button"
                              variant="secondary"
                            >
                              <Plus />
                              新增凭证
                            </Button>
                          ) : null}
                          <Button
                            disabled={
                              savingGithub ||
                              !githubCredentialName.trim() ||
                              (!githubCredentialId &&
                                githubToken.trim().length < 20)
                            }
                            type="submit"
                          >
                            <Save />
                            {savingGithub
                              ? "保存中…"
                              : githubCredentialId
                                ? "保存修改"
                                : "加密保存"}
                          </Button>
                        </span>
                      </div>
                    </form>
                  </Card>
                </div>
                <aside className="dp-runtime-aside">
                  <Card className="dp-runtime-section">
                    <div className="dp-section-head">
                      <span>
                        <GitPullRequest />
                        <b>GitHub 凭证列表</b>
                      </span>
                      <span className="dp-count">
                        {githubCredentials.filter((row) => row.enabled).length}{" "}
                        个启用
                      </span>
                    </div>
                    <div className="dp-runtime-list">
                      {githubCredentials.length ? (
                        githubCredentials.map((credential) => (
                          <div
                            className={`dp-runtime-item ${githubCredentialId === credential.id ? "selected" : ""}`}
                            key={credential.id}
                          >
                            <div>
                              <i
                                className={`status ${credential.enabled ? "online" : "revoked"}`}
                              />
                              <span>
                                <strong>{credential.name}</strong>
                                <small>
                                  {credential.tokenHint} ·{" "}
                                  {credential.enabled ? "启用" : "停用"}
                                </small>
                              </span>
                            </div>
                            <dl>
                              <div>
                                <dt>范围</dt>
                                <dd>
                                  {githubCredentialScopeLabel(
                                    credential.organizations,
                                    credential.repositories,
                                  )}
                                </dd>
                              </div>
                              <div>
                                <dt>优先级</dt>
                                <dd>{credential.priority}</dd>
                              </div>
                            </dl>
                            <Button
                              onClick={() => editGithubCredential(credential)}
                              variant="secondary"
                            >
                              编辑
                            </Button>
                            <Button
                              disabled={pendingItem !== null}
                              onClick={() => deleteGithubCredential(credential)}
                              variant="ghost"
                            >
                              <Trash2 />
                              删除
                            </Button>
                          </div>
                        ))
                      ) : (
                        <div className="dp-runtime-empty">
                          <strong>尚未配置 GitHub 凭证</strong>
                        </div>
                      )}
                    </div>
                  </Card>
                </aside>
              </div>
            </section>
          ) : null}

          {activeSection === "agent-runtime" ? (
            <section className="dp-access-module">
              <div className="dp-runtime-layout">
                <div className="dp-runtime-primary">
                  <Card className="dp-runtime-section">
                    <div className="dp-section-head">
                      <span>
                        <Plus />
                        <b>{agentModelId ? "编辑模型" : "新增模型"}</b>
                      </span>
                    </div>
                    <form
                      className="dp-section-body dp-form"
                      onSubmit={saveAgentModel}
                    >
                      <div className="dp-form-grid">
                        <Field label="Display Name">
                          <Input
                            onChange={(event) =>
                              setAgentModelDisplayName(event.target.value)
                            }
                            placeholder="GPT-5.4"
                            value={agentModelDisplayName}
                          />
                        </Field>
                        <Field label="Model ID">
                          <Input
                            onChange={(event) =>
                              setAgentModelModelId(event.target.value)
                            }
                            placeholder="gpt-5.4"
                            value={agentModelModelId}
                          />
                        </Field>
                        <Field label="Base URL">
                          <Input
                            onChange={(event) =>
                              setAgentModelBaseUrl(event.target.value)
                            }
                            placeholder="https://api.openai.com/v1"
                            type="url"
                            value={agentModelBaseUrl}
                          />
                        </Field>
                        <Field
                          label={agentModelId ? "替换 API Key" : "API Key"}
                        >
                          <Input
                            autoComplete="new-password"
                            onChange={(event) =>
                              setAgentModelApiKey(event.target.value)
                            }
                            placeholder={
                              agentModelId ? "Base URL 未变时可留空" : "sk-..."
                            }
                            type="password"
                            value={agentModelApiKey}
                          />
                        </Field>
                      </div>
                      {agentRuntimeMessage ? (
                        <FormMessage
                          message={agentRuntimeMessage.text}
                          tone={agentRuntimeMessage.tone}
                        />
                      ) : null}
                      <div className="dp-config-actions">
                        {agentModelId ? (
                          <Button
                            onClick={() => {
                              resetAgentModelForm();
                              setAgentRuntimeMessage(null);
                            }}
                            type="button"
                            variant="secondary"
                          >
                            取消编辑
                          </Button>
                        ) : null}
                        <Button
                          disabled={
                            savingAgentModel ||
                            !agentModelBaseUrl.trim() ||
                            !agentModelModelId.trim() ||
                            !agentModelDisplayName.trim() ||
                            (!agentModelId && !agentModelApiKey.trim()) ||
                            (agentModelEndpointChanged &&
                              !agentModelApiKey.trim()) ||
                            (!agentModelId && (agentModels?.length ?? 0) >= 10)
                          }
                          type="submit"
                        >
                          <Save />
                          {savingAgentModel ? "保存中…" : "保存模型"}
                        </Button>
                      </div>
                    </form>
                  </Card>
                </div>

                <aside className="dp-runtime-aside">
                  <Card className="dp-runtime-section">
                    <div className="dp-section-head">
                      <span>
                        <Bot />
                        <b>模型优先级</b>
                      </span>
                      <span className="dp-count">
                        {agentModels?.length ?? 0}/10
                      </span>
                    </div>
                    <div className="dp-agent-model-list">
                      {agentModels?.length ? (
                        agentModels.map((model, index) => (
                          <div
                            className={`dp-agent-model-item ${agentModelId === model.id ? "selected" : ""}`}
                            key={model.id}
                          >
                            <div className="dp-agent-model-summary">
                              <span>P{index + 1}</span>
                              <button
                                onClick={() => editAgentModel(model)}
                                type="button"
                              >
                                <strong>{model.displayName}</strong>
                                <code>{model.modelId}</code>
                              </button>
                              <div className="dp-agent-model-actions">
                                <Button
                                  aria-label={`上移 ${model.displayName}`}
                                  disabled={index === 0 || pendingItem !== null}
                                  onClick={() => void moveAgentModel(index, -1)}
                                  type="button"
                                  variant="ghost"
                                >
                                  <ArrowUp />
                                </Button>
                                <Button
                                  aria-label={`下移 ${model.displayName}`}
                                  disabled={
                                    index === agentModels.length - 1 ||
                                    pendingItem !== null
                                  }
                                  onClick={() => void moveAgentModel(index, 1)}
                                  type="button"
                                  variant="ghost"
                                >
                                  <ArrowDown />
                                </Button>
                                <Button
                                  aria-label={`删除 ${model.displayName}`}
                                  disabled={pendingItem !== null}
                                  onClick={() => void deleteAgentModel(model)}
                                  type="button"
                                  variant="ghost"
                                >
                                  <Trash2 />
                                </Button>
                              </div>
                            </div>
                            <div className="dp-agent-model-meta">
                              <code>{model.baseUrl}</code>
                              <span>{model.apiKeyHint}</span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="dp-runtime-empty">
                          <strong>尚未配置模型</strong>
                        </div>
                      )}
                    </div>
                  </Card>
                </aside>
              </div>
            </section>
          ) : null}

          {activeSection === "mcp" ? (
            <section className="dp-access-module">
              {credentialMessage ? (
                <div className="dp-runtime-message">
                  <FormMessage
                    message={credentialMessage.text}
                    tone={credentialMessage.tone}
                  />
                </div>
              ) : null}

              {issued ? (
                <Card
                  className="dp-pairing-panel"
                  ref={issuedRef}
                  tabIndex={-1}
                >
                  <div>
                    <p>一次性访问 Token</p>
                    <code>{issued.token}</code>
                    <small>明文只显示这一次；数据库仅保存 SHA-256 哈希。</small>
                  </div>
                  <Button
                    onClick={() =>
                      void copy(
                        issued.token,
                        "访问 Token 已复制。",
                        "credential",
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
                        <Plus />
                        <b>生成访问 Token</b>
                      </span>
                    </div>
                    <div className="dp-section-body dp-form">
                      <div className="dp-mcp-endpoint">
                        <span>
                          <code>{mcpEndpoint}</code>
                        </span>
                      </div>
                      <div className="dp-form-grid">
                        <Field label="Token 名称">
                          <Input
                            onChange={(event) =>
                              setCredentialName(event.target.value)
                            }
                            placeholder="Codex 生产环境"
                            value={credentialName}
                          />
                        </Field>
                        <Field label="过期时间（可选）">
                          <Input
                            onChange={(event) =>
                              setExpiresAt(event.target.value)
                            }
                            type="datetime-local"
                            value={expiresAt}
                          />
                        </Field>
                      </div>
                      <div className="dp-config-actions">
                        <Button
                          disabled={creatingCredential || !credentialName}
                          onClick={() => createCredential()}
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
                        {
                          mcpCredentials.filter(
                            (credential) => !credential.revokedAt,
                          ).length
                        }{" "}
                        个可用
                      </span>
                    </div>
                    <div
                      aria-label="访问 Token 列表"
                      className="dp-runtime-list"
                      role="region"
                      tabIndex={0}
                    >
                      {mcpCredentials.length ? (
                        mcpCredentials.map((row) => (
                          <div className="dp-runtime-item" key={row.id}>
                            <div>
                              <i
                                className={`status ${row.revokedAt ? "revoked" : "online"}`}
                              />
                              <span>
                                <strong>{row.name}</strong>
                                <small>
                                  {row.tokenHint} ·{" "}
                                  {row.revokedAt ? "已撤销" : "可用"}
                                </small>
                              </span>
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
                                    ? new Date(
                                        row.lastUsedAt,
                                      ).toLocaleDateString("zh-CN")
                                    : "从未"}
                                </dd>
                              </div>
                              <div>
                                <dt>过期时间</dt>
                                <dd>
                                  {row.expiresAt
                                    ? new Date(
                                        row.expiresAt,
                                      ).toLocaleDateString("zh-CN")
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
                          <strong>尚未生成访问 Token</strong>
                        </div>
                      )}
                    </div>
                  </Card>
                </aside>
              </div>
            </section>
          ) : null}
        </>
      )}
    </>
  );
}

function githubCredentialScopeLabel(
  organizations: string[],
  repositories: string[],
) {
  if (repositories.length && organizations.length) {
    return `${repositories.length} 个精确仓库 + ${organizations.length} 个组织`;
  }
  if (repositories.length) return `${repositories.length} 个精确仓库`;
  if (organizations.length) return `${organizations.length} 个组织`;
  return "默认凭证（匹配所有未命中范围）";
}

function scopeLabel(scopes: Scope[]) {
  const labels: Record<Scope, string> = {
    "profile:delete": "删除浏览器身份",
    "run:cancel": "取消 Run",
    "run:read": "读取 Run",
    "run:write": "创建/更新 Run",
    "verification:cancel": "取消验证",
    "verification:read": "读取验证",
    "verification:write": "创建/更新验证",
  };
  return scopes.map((scope) => labels[scope]).join("、") || "无权限";
}
