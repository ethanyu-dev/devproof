"use client";

import type {
  ClipboardEvent,
  CompositionEvent,
  FormEvent,
  KeyboardEvent,
  PointerEvent,
  WheelEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CircleAlert,
  Clock3,
  Globe2,
  KeyRound,
  Keyboard,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { BrowserHumanInputEvent } from "@devproof/runtime-protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import { PageHeader } from "@/components/page-header";
import {
  ErrorState,
  FormMessage,
  LoadingState,
} from "@/components/settings-layout";
import { consoleApi } from "@/lib/api";
import { BrowserInputQueue } from "@/lib/browser-input-queue";
import {
  BrowserPointerController,
  normalizedBrowserPoint,
} from "@/lib/browser-pointer-controller";
import { displayLabel } from "@/lib/display-text";

type TriggerSource = "CONSOLE" | "FEISHU" | "ISSUE_ASSIGNEE";

const PROFILE_FRAME_STALE_MS = 6_000;
const PROFILE_OPERATION_TIMEOUT_MS = 120_000;
type ProfileOperation =
  | "approve"
  | "close"
  | "delete"
  | "disable"
  | "prepare"
  | "reauth"
  | "verify"
  | "settings";

interface Profile {
  activeSession: {
    humanControlExpiresAt: string | null;
    id: string;
    status: string;
  } | null;
  assignedRuntime: {
    deviceInfo: string;
    id: string;
    lastSeenAt: string | null;
    name: string;
    status: string;
  } | null;
  authRole: string;
  configurationSource: "MANUAL" | "TASK";
  createdAt: string;
  displayName: string;
  environmentKey: string;
  executionMode?: "SERIAL_PERSISTENT" | "ISOLATED_AUTH";
  executionConcurrency?: number;
  authSnapshotGeneration?: number | null;
  isolatedExecutionAvailable?: boolean;
  grants: Array<{ hostnamePattern: string; triggerSource: TriggerSource }>;
  id: string;
  inactivityExpiresAt: string | null;
  lastUsedAt: string | null;
  lastVerifiedAt: string | null;
  pendingTriggerSources: TriggerSource[];
  siteHostname: string | null;
  status: string;
  verificationUrl: string | null;
  verificationError?: { message?: string } | null;
}

export function ProfilesClient() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [executionMode, setExecutionMode] = useState("SERIAL_PERSISTENT");
  const [executionConcurrency, setExecutionConcurrency] = useState(4);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operation, setOperation] = useState<ProfileOperation | null>(null);
  const operationAbort = useRef<AbortController | null>(null);
  const operationSequence = useRef(0);
  const [message, setMessage] = useState<{
    text: string;
    tone: "error" | "success";
  } | null>(null);
  const selected =
    profiles?.find((profile) => profile.id === selectedId) ?? null;
  const sessionTransitioning = ["OPENING", "CLOSING"].includes(
    selected?.activeSession?.status ?? "",
  );
  const busy =
    operation !== null ||
    selected?.status === "VERIFYING" ||
    sessionTransitioning;
  const loginBlocked = ["DISABLED", "MIGRATION_REQUIRED"].includes(
    selected?.status ?? "",
  );
  const requiresReauth = ["READY", "LOST"].includes(selected?.status ?? "");

  const load = useCallback(
    async (keepId?: string | null) => {
      setLoadError(null);
      try {
        const rows = await consoleApi<Profile[]>("/browser-profiles");
        setProfiles(rows);
        const preferredId = keepId ?? selectedId;
        const nextId =
          (preferredId && rows.some((profile) => profile.id === preferredId)
            ? preferredId
            : rows[0]?.id) ?? null;
        setSelectedId(nextId);
      } catch (error) {
        setLoadError((error as Error).message);
        throw error;
      }
    },
    [selectedId],
  );

  useEffect(() => {
    const requestedId = new URLSearchParams(window.location.search).get(
      "profile",
    );
    void load(requestedId).catch(() => undefined);
    // The initial request intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected || (selected.status !== "VERIFYING" && !sessionTransitioning))
      return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await load(selected.id).catch(() => undefined);
      if (!cancelled) timer = window.setTimeout(poll, 1_500);
    };
    timer = window.setTimeout(poll, 1_500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [load, selected?.id, selected?.status, sessionTransitioning]);

  function select(profile: Profile) {
    setSelectedId(profile.id);
    setMessage(null);
  }

  useEffect(() => {
    setExecutionMode(selected?.executionMode ?? "SERIAL_PERSISTENT");
    setExecutionConcurrency(selected?.executionConcurrency ?? 4);
  }, [selected?.id, selected?.executionMode, selected?.executionConcurrency]);

  async function saveExecutionSettings(event: FormEvent) {
    event.preventDefault();
    if (!selected || busy) return;
    setOperation("settings");
    setMessage(null);
    try {
      await consoleApi(`/browser-profiles/${selected.id}`, {
        method: "PUT",
        body: JSON.stringify({
          executionMode,
          executionConcurrency:
            executionMode === "SERIAL_PERSISTENT" ? 1 : executionConcurrency,
        }),
      });
      await load(selected.id);
      setMessage({ text: "执行方式已保存，将用于后续任务。", tone: "success" });
    } catch (error) {
      setMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setOperation(null);
    }
  }

  async function action(
    name: Exclude<ProfileOperation, "delete">,
    prepareIsolatedAuth = false,
  ) {
    if (!selected) return;
    if (operation && name !== "close") return;
    if (name === "close") operationAbort.current?.abort();
    const controller = new AbortController();
    const sequence = ++operationSequence.current;
    operationAbort.current = controller;
    setOperation(name);
    setMessage(null);
    try {
      const result = await consoleApi<Profile>(
        `/browser-profiles/${selected.id}/${name}`,
        {
          ...(name === "prepare" || name === "reauth"
            ? { body: JSON.stringify({ ttlSeconds: 1800 }) }
            : name === "verify"
              ? { body: JSON.stringify({ prepareIsolatedAuth }) }
              : {}),
          method: "POST",
          signal: controller.signal,
        },
        PROFILE_OPERATION_TIMEOUT_MS,
      );
      await load(selected.id);
      setMessage({
        text:
          name === "verify"
            ? result.verificationError?.message ||
              (prepareIsolatedAuth
                ? "登录状态已保存，并发验证通过后可在执行方式中启用独立会话。"
                : "登录状态验证成功，浏览器身份已可用于任务。")
            : name === "close"
              ? "已关闭本次登录窗口，未保存新的登录状态。"
              : name === "approve"
                ? "已授权本次任务入口使用该浏览器身份。"
                : "操作已提交。",
        tone: "success",
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      await load(selected.id).catch(() => undefined);
      setMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      if (operationSequence.current === sequence) {
        operationAbort.current = null;
        setOperation(null);
      }
    }
  }

  async function purge() {
    if (
      !selected ||
      !window.confirm(`永久清理 ${selected.displayName} 的浏览器登录数据？`)
    )
      return;
    setOperation("delete");
    try {
      await consoleApi(`/browser-profiles/${selected.id}`, {
        method: "DELETE",
      });
      await load(selected.id);
      setMessage({
        text: "浏览器身份及其执行节点登录数据已删除。",
        tone: "success",
      });
    } catch (error) {
      setMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setOperation(null);
    }
  }

  return (
    <>
      <PageHeader
        description="登录状态只保存在执行节点；在任务要求时完成登录、MFA 或授权。"
        title="浏览器身份"
      />
      {message ? (
        <div className="dp-runtime-message">
          <FormMessage message={message.text} tone={message.tone} />
        </div>
      ) : null}
      {loadError && profiles !== null && !message ? (
        <div className="dp-runtime-message">
          <FormMessage message={loadError} tone="error" />
        </div>
      ) : null}
      {profiles === null ? (
        <Card className="dp-profile-settings">
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
        <div className="dp-settings-grid dp-profile-settings">
          <section className="dp-resource-list">
            <div className="dp-list-head">
              <strong>我的浏览器身份</strong>
              <span>{profiles.length} 个</span>
            </div>
            <div className="dp-list-items">
              {profiles.map((profile) => (
                <button
                  className={`dp-list-item ${profile.id === selectedId ? "active" : ""}`}
                  key={profile.id}
                  onClick={() => select(profile)}
                  type="button"
                >
                  <div>
                    <strong>{profile.displayName}</strong>
                    <Badge tone={profileTone(profile.status)}>
                      {displayLabel(profile.status)}
                    </Badge>
                  </div>
                  <small>{profile.siteHostname ?? "等待目标站点"}</small>
                </button>
              ))}
              {!profiles.length ? (
                <div className="dp-profile-empty">
                  暂无登录任务。任务选择“使用我的浏览器身份”或“Issue
                  负责人的浏览器身份”后，系统会按目标站点自动创建。
                </div>
              ) : null}
            </div>
          </section>
          <section className="dp-resource-editor">
            {selected ? (
              <div className="dp-form">
                <header className="dp-form-header">
                  <div>
                    <h2>{selected.displayName}</h2>
                    <p>
                      目标站点和验证规则已由任务自动生成。Cookie、localStorage
                      和登录态只保存在分配的执行节点。
                    </p>
                  </div>
                  <Badge tone={profileTone(selected.status)}>
                    {displayLabel(selected.status)}
                  </Badge>
                </header>
                <div className="dp-profile-summary">
                  <div>
                    <Globe2 />
                    <span>
                      <small>目标站点</small>
                      <strong>{selected.siteHostname ?? "待确定"}</strong>
                    </span>
                  </div>
                  <div>
                    <ShieldCheck />
                    <span>
                      <small>已授权入口</small>
                      <strong>
                        {activeTriggerSources(selected).length
                          ? activeTriggerSources(selected)
                              .map(grantLabel)
                              .join("、")
                          : "尚未授权"}
                      </strong>
                    </span>
                  </div>
                </div>
                <form
                  className="dp-form"
                  onSubmit={(event) => void saveExecutionSettings(event)}
                >
                  <label>
                    执行方式
                    <select
                      value={executionMode}
                      onChange={(event) => setExecutionMode(event.target.value)}
                      disabled={busy}
                    >
                      <option value="SERIAL_PERSISTENT">串行复用浏览器</option>
                      <option
                        value="ISOLATED_AUTH"
                        disabled={
                          !selected.isolatedExecutionAvailable ||
                          !selected.authSnapshotGeneration
                        }
                      >
                        独立会话并发执行
                      </option>
                    </select>
                  </label>
                  {executionMode === "ISOLATED_AUTH" ? (
                    <label>
                      此登录身份的并发上限
                      <input
                        type="number"
                        min={1}
                        max={4}
                        value={executionConcurrency}
                        onChange={(event) =>
                          setExecutionConcurrency(Number(event.target.value))
                        }
                        disabled={busy}
                        required
                      />
                    </label>
                  ) : null}
                  <p className="dp-muted">
                    {selected.authSnapshotGeneration
                      ? "已通过 4 个独立会话的登录验证。读写冲突的 Case 仍会按数据锁排队。"
                      : "启用并发前，请重新登录，在登录窗口勾选“验证并发登录”并保存，再切换执行方式。"}
                    {!selected.isolatedExecutionAvailable
                      ? "当前部署尚未启用并发登录功能。"
                      : ""}
                  </p>
                  <Button type="submit" disabled={busy}>
                    保存执行方式
                  </Button>
                </form>
                {selected.pendingTriggerSources.length ? (
                  <div className="dp-profile-consent">
                    <span>
                      <b>任务正在请求使用该登录状态</b>
                      <small>
                        请求入口：
                        {selected.pendingTriggerSources
                          .map(grantLabel)
                          .join("、")}
                      </small>
                    </span>
                    {selected.status === "READY" ? (
                      <Button
                        disabled={busy}
                        onClick={() => void action("approve")}
                      >
                        <ShieldCheck /> 确认授权
                      </Button>
                    ) : (
                      <small>完成下方登录后将自动确认该请求。</small>
                    )}
                  </div>
                ) : null}
                <div className="dp-form-actions">
                  <div>
                    <Button
                      className={`dp-profile-operation-button${
                        operation === "prepare" || operation === "reauth"
                          ? " is-loading"
                          : ""
                      }`}
                      disabled={busy || loginBlocked}
                      onClick={() =>
                        void action(requiresReauth ? "reauth" : "prepare")
                      }
                      variant="secondary"
                    >
                      {operation === "prepare" || operation === "reauth" ? (
                        <LoaderCircle />
                      ) : (
                        <KeyRound />
                      )}
                      {operation === "prepare" || operation === "reauth"
                        ? "正在打开登录页…"
                        : requiresReauth
                          ? "重新登录"
                          : "准备登录"}
                    </Button>
                    <Button
                      disabled={busy || selected.status === "DISABLED"}
                      onClick={() => void action("disable")}
                      variant="secondary"
                    >
                      停用
                    </Button>
                    <Button
                      aria-label={`永久清理 ${selected.displayName}`}
                      disabled={busy}
                      onClick={() => void purge()}
                      variant="danger"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void load(selected.id).catch(() => undefined)
                    }
                    variant="secondary"
                  >
                    <RefreshCw /> 刷新
                  </Button>
                </div>
              </div>
            ) : (
              <div className="dp-profile-empty">
                浏览器身份会由需要登录态的任务自动创建，无需提前配置。
              </div>
            )}
          </section>
        </div>
      )}
      {selected?.activeSession?.status === "HUMAN_CONTROL" ? (
        <ProfileBrowser
          profile={selected}
          onClose={() => void action("close")}
          onReload={() => void action("prepare")}
          onVerify={(prepareIsolatedAuth) =>
            void action("verify", prepareIsolatedAuth)
          }
          operation={operation}
          operationError={message?.tone === "error" ? message.text : null}
        />
      ) : selected ? (
        <Card className="dp-profile-status-card">
          <ShieldCheck />
          <span>
            <b>身份状态：{displayLabel(selected.status)}</b>
            <small>
              最近验证：{formatDate(selected.lastVerifiedAt)} · 最近使用：
              {formatDate(selected.lastUsedAt)} · 自动清理：
              {formatDate(selected.inactivityExpiresAt)}
            </small>
          </span>
          {["PREPARING", "VERIFYING"].includes(selected.status) ? (
            <Button
              disabled={operation === "close"}
              onClick={() => void action("close")}
              variant="secondary"
            >
              {operation === "close" ? <LoaderCircle /> : <X />}
              {operation === "close" ? "正在关闭…" : "关闭登录"}
            </Button>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}

function ProfileBrowser({
  onClose,
  onReload,
  onVerify,
  operation,
  operationError,
  profile,
}: {
  onClose: () => void;
  onReload: () => void;
  onVerify: (prepareIsolatedAuth: boolean) => void;
  operation: ProfileOperation | null;
  operationError: string | null;
  profile: Profile;
}) {
  const [frame, setFrame] = useState<{
    capturedAt: string;
    dataBase64: string;
    height: number;
    title: string;
    url: string;
    width: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [prepareIsolatedAuth, setPrepareIsolatedAuth] = useState(false);
  useEffect(() => {
    setPrepareIsolatedAuth(false);
  }, [profile.id, profile.activeSession?.id]);
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  const [streamStatus, setStreamStatus] = useState<
    "connecting" | "interrupted" | "live"
  >("connecting");
  const container = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const lastFrameAt = useRef(0);
  const lastPointerMoveAt = useRef(0);
  const inputQueue = useMemo(
    () =>
      new BrowserInputQueue((events) =>
        consoleApi(`/browser-profiles/${profile.id}/browser/input`, {
          body: JSON.stringify({ events }),
          method: "POST",
        }),
      ),
    [profile.id],
  );

  const send = useCallback(
    async (events: BrowserHumanInputEvent[]) => {
      await inputQueue
        .enqueue(events)
        .catch((inputError: unknown) =>
          setError(
            inputError instanceof Error
              ? inputError.message
              : "浏览器输入发送失败，请重试。",
          ),
        );
    },
    [inputQueue],
  );
  const pointerController = useMemo(
    () => new BrowserPointerController(send),
    [send],
  );

  useEffect(() => {
    setOverlayHost(document.getElementById("dp-console-workspace-overlay"));
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    document.body.classList.add("dp-browser-handoff-fullscreen-open");
    const exitOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", exitOnEscape);
    return () => {
      document.body.classList.remove("dp-browser-handoff-fullscreen-open");
      window.removeEventListener("keydown", exitOnEscape);
    };
  }, [fullscreen]);

  useEffect(() => {
    lastFrameAt.current = Date.now();
    setStreamStatus("connecting");
    const source = new EventSource(
      `/console/api/browser-profiles/${profile.id}/browser/stream`,
      { withCredentials: true },
    );
    source.onmessage = (message) => {
      let event: {
        capturedAt?: string;
        dataBase64?: string;
        error?: string;
        type: string;
        height?: number;
        title?: string;
        url?: string;
        width?: number;
      };
      try {
        event = JSON.parse(message.data) as typeof event;
      } catch {
        setError("浏览器执行节点返回了无法识别的实时画面事件。");
        return;
      }
      if (
        event.type === "frame" &&
        event.dataBase64 &&
        event.height &&
        event.width
      )
        setFrame({
          capturedAt: event.capturedAt ?? new Date().toISOString(),
          dataBase64: event.dataBase64,
          height: event.height,
          title: event.title ?? "",
          url: event.url ?? "",
          width: event.width,
        });
      if (event.type === "frame") {
        lastFrameAt.current = Date.now();
        setStreamStatus("live");
        setError(null);
      }
      if (event.type === "error") {
        setStreamStatus("interrupted");
        setError(event.error ?? "实时画面连接中断。");
      }
    };
    source.onerror = () => {
      setStreamStatus("interrupted");
      setError("实时画面连接中断，正在等待执行节点恢复。");
    };
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastFrameAt.current <= PROFILE_FRAME_STALE_MS) return;
      setStreamStatus("interrupted");
      setError("浏览器画面已过期，正在等待执行节点恢复。");
    }, 1_000);
    return () => {
      window.clearInterval(watchdog);
      source.close();
    };
  }, [profile.id]);

  useEffect(() => {
    const release = () => pointerController.cancel();
    const releaseWhenHidden = () => {
      if (document.visibilityState !== "visible") release();
    };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", releaseWhenHidden);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", releaseWhenHidden);
    };
  }, [pointerController]);

  const remaining = profile.activeSession?.humanControlExpiresAt
    ? formatRemaining(profile.activeSession.humanControlExpiresAt)
    : null;
  const verifying =
    operation !== "close" &&
    (operation === "verify" || profile.status === "VERIFYING");
  const busy = operation !== null || profile.status === "VERIFYING";
  const panel = (
    <section
      className={`dp-browser-handoff dp-profile-browser-handoff is-floating${fullscreen ? " is-fullscreen" : ""}`}
    >
      <header>
        <span>
          <Keyboard />
          <b>浏览器身份验证</b>
        </span>
        <div className="dp-browser-handoff-header-actions">
          <span className="dp-browser-handoff-status">
            {remaining ? (
              <>
                <Clock3 /> {remaining}
              </>
            ) : null}
            <Badge tone={streamStatus === "live" ? "success" : "warning"}>
              {verifying
                ? "保存中"
                : streamStatus === "live"
                  ? "由你控制"
                  : "连接中"}
            </Badge>
          </span>
          <Button
            aria-label={fullscreen ? "退出全屏操作" : "全屏操作"}
            className="dp-browser-handoff-fullscreen-toggle"
            onClick={() => setFullscreen((current) => !current)}
            variant="secondary"
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
            {fullscreen ? "退出全屏" : "全屏操作"}
          </Button>
          <Button
            aria-label="关闭浏览器身份验证"
            disabled={operation !== null && operation !== "verify"}
            onClick={onClose}
            variant="secondary"
          >
            {operation === "close" ? <LoaderCircle /> : <X />}
            {operation === "close" ? "正在关闭…" : "关闭"}
          </Button>
        </div>
      </header>

      <div className="dp-browser-handoff-copy">
        <strong>完成登录或 MFA</strong>
        <p>请在原浏览器会话中完成身份验证，然后点击“验证并保存”。</p>
        <small>
          <ShieldCheck />
          输入只会通过临时控制通道发送到浏览器执行节点，不会进入 Agent
          提示词、验证轨迹或制品。
        </small>
      </div>

      {profile.assignedRuntime ? (
        <div
          aria-label={`已分配浏览器执行节点 ${profile.assignedRuntime.name}`}
          className="dp-browser-handoff-runtime"
        >
          <Monitor />
          <span>
            <small>已分配浏览器执行节点</small>
            <b>{profile.assignedRuntime.name}</b>
            <small>
              {profile.assignedRuntime.deviceInfo ||
                `Runtime ${profile.assignedRuntime.id.slice(0, 8)}`}
              {profile.assignedRuntime.lastSeenAt
                ? ` · 最近心跳 ${formatDate(profile.assignedRuntime.lastSeenAt)}`
                : ""}
            </small>
          </span>
          <Badge tone={runtimeTone(profile.assignedRuntime.status)}>
            {displayLabel(profile.assignedRuntime.status)}
          </Badge>
        </div>
      ) : null}

      {operationError || error ? (
        <div className="dp-browser-handoff-error">
          <CircleAlert /> {operationError ?? error}
        </div>
      ) : null}

      <div className="dp-browser-handoff-session">
        <div className="dp-browser-frame">
          <div
            aria-label="远程浏览器身份登录窗口，可使用键盘和指针操作"
            className={`dp-browser-viewport ${streamStatus === "live" ? "is-controllable" : ""}`}
            onContextMenu={(event) => event.preventDefault()}
            onFocus={(event) => {
              if (event.target === event.currentTarget)
                keyboard.current?.focus({ preventScroll: true });
            }}
            onPointerCancel={() => pointerController.cancel()}
            onPointerDown={(event) =>
              handleProfilePointer(
                event,
                "down",
                container.current,
                frame,
                keyboard.current,
                pointerController,
              )
            }
            onPointerMove={(event) => {
              if (!event.buttons || Date.now() - lastPointerMoveAt.current < 32)
                return;
              lastPointerMoveAt.current = Date.now();
              handleProfilePointer(
                event,
                "move",
                container.current,
                frame,
                keyboard.current,
                pointerController,
              );
            }}
            onPointerUp={(event) =>
              handleProfilePointer(
                event,
                "up",
                container.current,
                frame,
                keyboard.current,
                pointerController,
              )
            }
            onWheel={(event) =>
              void handleProfileWheel(event, container.current, frame, send)
            }
            ref={container}
            tabIndex={0}
          >
            <RemoteKeyboard
              inputRef={keyboard}
              release={() => pointerController.cancel()}
              send={send}
            />
            {frame ? (
              <img
                alt="用户浏览器身份登录窗口"
                draggable={false}
                src={`data:image/jpeg;base64,${frame.dataBase64}`}
              />
            ) : (
              <div className="dp-browser-viewport-waiting">
                <LoaderCircle /> 正在连接浏览器执行节点…
              </div>
            )}
            {streamStatus === "interrupted" ? (
              <div className="dp-browser-viewport-blocked">
                <LoaderCircle /> 画面已过期，正在恢复画面与输入…
              </div>
            ) : null}
            {verifying ? (
              <div className="dp-browser-viewport-blocked">
                <LoaderCircle /> 正在验证并保存登录状态，请勿重复操作…
              </div>
            ) : null}
            {operation === "close" ? (
              <div className="dp-browser-viewport-blocked">
                <LoaderCircle /> 正在关闭登录窗口并释放执行节点…
              </div>
            ) : null}
          </div>
          {frame ? (
            <div className="dp-browser-viewport-meta">
              <span>{frame.title || "未命名页面"}</span>
              <small>{frame.url}</small>
            </div>
          ) : null}
        </div>
        <div className="dp-browser-handoff-controls">
          <div className="dp-browser-handoff-guide">
            <Keyboard />
            点击画面定位输入焦点，可使用键盘、粘贴、点击和滚轮完成登录。
          </div>
          {profile.isolatedExecutionAvailable &&
          profile.executionMode !== "ISOLATED_AUTH" ? (
            <label>
              <input
                type="checkbox"
                checked={prepareIsolatedAuth}
                disabled={busy}
                onChange={(event) =>
                  setPrepareIsolatedAuth(event.target.checked)
                }
              />{" "}
              验证并发登录：使用 4
              个独立会话检查兼容性。部分站点可能要求重新登录；未勾选时只保存串行登录状态。
            </label>
          ) : null}
          <div className="dp-browser-handoff-actions">
            <Button disabled={busy} onClick={onReload} variant="secondary">
              {operation === "prepare" ? <LoaderCircle /> : <RefreshCw />}
              {operation === "prepare" ? "正在重新打开…" : "重新打开登录页"}
            </Button>
            <Button
              disabled={busy || !frame || streamStatus !== "live"}
              onClick={() => onVerify(prepareIsolatedAuth)}
            >
              {verifying ? <LoaderCircle /> : <ShieldCheck />}
              {verifying ? "正在验证并保存…" : "验证并保存"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );

  return overlayHost ? createPortal(panel, overlayHost) : null;
}

function RemoteKeyboard({
  inputRef,
  release,
  send,
}: {
  inputRef: React.Ref<HTMLTextAreaElement>;
  release: () => void;
  send: (events: BrowserHumanInputEvent[]) => Promise<void>;
}) {
  function key(
    event: KeyboardEvent<HTMLTextAreaElement>,
    phase: "down" | "up",
  ) {
    if (
      (event.key.length === 1 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey) ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v")
    )
      return;
    event.preventDefault();
    void send([
      { key: event.key === "Meta" ? "Control" : event.key, phase, type: "key" },
    ]);
  }
  function text(event: FormEvent<HTMLTextAreaElement>) {
    if ((event.nativeEvent as InputEvent).isComposing) return;
    const value = event.currentTarget.value;
    event.currentTarget.value = "";
    if (value) void send([{ text: value, type: "text" }]);
  }
  function composition(event: CompositionEvent<HTMLTextAreaElement>) {
    event.currentTarget.value = "";
    if (event.data) void send([{ text: event.data, type: "text" }]);
  }
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const value = event.clipboardData.getData("text/plain");
    event.preventDefault();
    if (value) void send([{ text: value, type: "text" }]);
  }
  return (
    <textarea
      aria-label="远程浏览器键盘输入"
      className="dp-browser-keyboard-target"
      onBlur={release}
      onCompositionEnd={composition}
      onInput={text}
      onKeyDown={(event) => key(event, "down")}
      onKeyUp={(event) => key(event, "up")}
      onPaste={paste}
      ref={inputRef}
      tabIndex={-1}
    />
  );
}

function handleProfilePointer(
  event: PointerEvent<HTMLDivElement>,
  phase: "down" | "move" | "up",
  container: HTMLDivElement | null,
  frame: { height: number; width: number } | null,
  keyboard: HTMLTextAreaElement | null,
  pointerController: BrowserPointerController,
) {
  const point = normalizedBrowserPoint(
    event.clientX,
    event.clientY,
    container?.getBoundingClientRect() ?? null,
    frame,
  );
  if (!point) {
    if (phase === "up") {
      pointerController.cancel();
      releasePointerCapture(event);
    }
    return;
  }
  event.preventDefault();
  const input = {
    button: pointerButton(event),
    phase,
    type: "pointer",
    ...point,
  } as const;
  if (phase === "down") {
    event.currentTarget.setPointerCapture(event.pointerId);
    keyboard?.focus({ preventScroll: true });
    pointerController.down(event.pointerId, input);
  } else if (phase === "move") {
    pointerController.move(event.pointerId, input);
  } else {
    pointerController.up(event.pointerId, input);
    releasePointerCapture(event);
  }
}

function pointerButton(event: PointerEvent<HTMLDivElement>) {
  if (event.button === 2 || (event.button === -1 && event.buttons === 2))
    return "right" as const;
  if (event.button === 1 || (event.button === -1 && event.buttons === 4))
    return "middle" as const;
  return "left" as const;
}

async function handleProfileWheel(
  event: WheelEvent<HTMLDivElement>,
  container: HTMLDivElement | null,
  frame: { height: number; width: number } | null,
  send: (events: BrowserHumanInputEvent[]) => Promise<void>,
) {
  const point = normalizedBrowserPoint(
    event.clientX,
    event.clientY,
    container?.getBoundingClientRect() ?? null,
    frame,
  );
  if (!point) return;
  event.preventDefault();
  await send([
    {
      deltaX: Math.max(-2000, Math.min(2000, event.deltaX)),
      deltaY: Math.max(-2000, Math.min(2000, event.deltaY)),
      type: "wheel",
      ...point,
    },
  ]);
}

function releasePointerCapture(event: PointerEvent<HTMLDivElement>) {
  if (event.currentTarget.hasPointerCapture(event.pointerId))
    event.currentTarget.releasePointerCapture(event.pointerId);
}

function formatRemaining(expiresAt: string) {
  const seconds = Math.max(
    0,
    Math.ceil((Date.parse(expiresAt) - Date.now()) / 1_000),
  );
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function activeTriggerSources(profile: Profile) {
  return [...new Set(profile.grants.map((grant) => grant.triggerSource))];
}

function grantLabel(grant: TriggerSource) {
  return grant === "CONSOLE"
    ? "控制台任务"
    : grant === "FEISHU"
      ? "飞书群 @ 任务"
      : "Issue assignee 任务";
}
function profileTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" {
  return status === "READY"
    ? "success"
    : ["PREPARING", "VERIFYING", "REAUTH_REQUIRED", "UNINITIALIZED"].includes(
          status,
        )
      ? "warning"
      : ["LOST", "DISABLED"].includes(status)
        ? "danger"
        : "neutral";
}
function runtimeTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" {
  return status === "ONLINE"
    ? "success"
    : status === "REVOKED"
      ? "danger"
      : status === "OFFLINE"
        ? "warning"
        : "neutral";
}
function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "尚无";
}
