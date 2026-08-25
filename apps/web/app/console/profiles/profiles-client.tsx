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
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { BrowserHumanInputEvent } from "@devproof/runtime-protocol";
import { Badge, Button, Card } from "@devproof/ui";

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

interface Profile {
  activeSession: {
    humanControlExpiresAt: string | null;
    id: string;
    status: string;
  } | null;
  assignedRuntime: { id: string; name: string; status: string } | null;
  authRole: string;
  configurationSource: "MANUAL" | "TASK";
  createdAt: string;
  displayName: string;
  environmentKey: string;
  grants: Array<{ hostnamePattern: string; triggerSource: TriggerSource }>;
  id: string;
  inactivityExpiresAt: string | null;
  lastUsedAt: string | null;
  lastVerifiedAt: string | null;
  pendingTriggerSources: TriggerSource[];
  siteHostname: string | null;
  status: string;
  verificationUrl: string | null;
}

export function ProfilesClient() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    tone: "error" | "success";
  } | null>(null);
  const selected =
    profiles?.find((profile) => profile.id === selectedId) ?? null;

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

  function select(profile: Profile) {
    setSelectedId(profile.id);
    setMessage(null);
  }

  async function action(
    name: "approve" | "prepare" | "verify" | "reauth" | "disable",
  ) {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    try {
      await consoleApi(`/browser-profiles/${selected.id}/${name}`, {
        ...(name === "prepare" || name === "reauth"
          ? { body: JSON.stringify({ ttlSeconds: 1800 }) }
          : {}),
        method: "POST",
      });
      await load(selected.id);
      setMessage({
        text:
          name === "verify"
            ? "登录状态验证成功，浏览器身份已可用于任务。"
            : name === "approve"
              ? "已授权本次任务入口使用该浏览器身份。"
              : "操作已提交。",
        tone: "success",
      });
    } catch (error) {
      await load(selected.id).catch(() => undefined);
      setMessage({ text: (error as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function purge() {
    if (
      !selected ||
      !window.confirm(`永久清理 ${selected.displayName} 的浏览器登录数据？`)
    )
      return;
    setBusy(true);
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
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="浏览器身份" />
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
                      disabled={busy || selected.status === "DISABLED"}
                      onClick={() =>
                        void action(
                          selected.status === "READY" ? "reauth" : "prepare",
                        )
                      }
                      variant="secondary"
                    >
                      <KeyRound />
                      {selected.status === "READY" ? "重新登录" : "准备登录"}
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
          busy={busy}
          onReload={() => void action("prepare")}
          onVerify={() => void action("verify")}
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
        </Card>
      ) : null}
    </>
  );
}

function ProfileBrowser({
  busy,
  onReload,
  onVerify,
  operationError,
  profile,
}: {
  busy: boolean;
  onReload: () => void;
  onVerify: () => void;
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
              {streamStatus === "live" ? "由你控制" : "连接中"}
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
          <div className="dp-browser-handoff-actions">
            <Button disabled={busy} onClick={onReload} variant="secondary">
              <RefreshCw />
              重新打开登录页
            </Button>
            <Button
              disabled={busy || !frame || streamStatus !== "live"}
              onClick={onVerify}
            >
              <ShieldCheck />
              验证并保存
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
    : ["PREPARING", "REAUTH_REQUIRED", "UNINITIALIZED"].includes(status)
      ? "warning"
      : ["LOST", "DISABLED"].includes(status)
        ? "danger"
        : "neutral";
}
function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "尚无";
}
