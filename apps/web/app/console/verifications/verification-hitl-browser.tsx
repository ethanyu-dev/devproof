"use client";

import type {
  ClipboardEvent,
  CompositionEvent,
  FormEvent,
  KeyboardEvent,
  PointerEvent,
  WheelEvent,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CircleAlert,
  Clock3,
  Hand,
  Keyboard,
  LoaderCircle,
  Maximize2,
  Minimize2,
  MonitorPlay,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import type { BrowserHumanInputEvent } from "@devproof/runtime-protocol";
import { Badge, Button, Field, Input } from "@devproof/ui";

import { consoleApi } from "@/lib/api";
import { displayLabel } from "@/lib/display-text";

interface BrowserHandoffStatus {
  control: { controlledByMe: boolean; expiresAt: string; id?: string } | null;
  expiresAt: string;
  prompt: string;
  ready: boolean;
  runtimeSession: {
    id: string;
    profileId: string | null;
    profileMode: string;
    status: string;
  } | null;
  unavailableReason:
    "NO_SESSION" | "PROTOCOL_UNSUPPORTED" | "SESSION_UNAVAILABLE" | null;
}

interface PreviewFrame {
  capturedAt: string;
  dataBase64: string;
  height: number;
  title: string;
  type: "frame";
  url: string;
  width: number;
}

interface BrowserHitlProps {
  checkpoint: { expiresAt: string; id: string; prompt: string };
  onComplete: () => Promise<void>;
  runId: string;
}

interface RunBrowserHitlProps {
  intervention: { expiresAt: string; id: string; prompt: string };
  onComplete: () => Promise<void>;
  runId: string;
}

interface SharedBrowserHitlProps {
  base: string;
  checkpoint: { expiresAt: string; id: string; prompt: string };
  floating?: boolean;
  onComplete: () => Promise<void>;
}

const HEARTBEAT_MS = 8_000;
const STALE_FRAME_MS = 6_000;
const STREAM_RECONNECT_MS = 1_200;

export function VerificationHitlBrowser({
  checkpoint,
  onComplete,
  runId,
}: BrowserHitlProps) {
  return (
    <BrowserHitl
      base={`/verifications/${runId}/checkpoints/${checkpoint.id}/browser`}
      checkpoint={checkpoint}
      onComplete={onComplete}
    />
  );
}

export function RunHitlBrowser({
  intervention,
  onComplete,
  runId,
}: RunBrowserHitlProps) {
  return (
    <BrowserHitl
      base={`/runs/${runId}/interventions/${intervention.id}/browser`}
      checkpoint={intervention}
      floating
      onComplete={onComplete}
    />
  );
}

function BrowserHitl({
  base,
  checkpoint,
  floating = false,
  onComplete,
}: SharedBrowserHitlProps) {
  const [handoff, setHandoff] = useState<BrowserHandoffStatus | null>(null);
  const [controlId, setControlId] = useState<string | null>(null);
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const [streamStatus, setStreamStatus] = useState<
    "idle" | "connecting" | "live" | "interrupted"
  >("idle");
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [note, setNote] = useState("已在浏览器中完成所需操作。");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const lastFrameAt = useRef(0);
  const lastPointerMoveAt = useRef(0);

  const load = useCallback(async () => {
    const status = await consoleApi<BrowserHandoffStatus>(base);
    setHandoff(status);
    setControlId(
      (current) =>
        current ??
        (status.control?.controlledByMe ? (status.control.id ?? null) : null),
    );
  }, [base]);

  useEffect(() => {
    void load().catch((loadError: Error) => setError(loadError.message));
  }, [load]);

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
    if (!controlId) return;
    lastFrameAt.current = Date.now();
    const source = new EventSource(`/console/api${base}/stream`, {
      withCredentials: true,
    });
    let reconnectTimer: number | undefined;
    const reconnect = (message?: string) => {
      setStreamStatus("interrupted");
      if (message) setError(message);
      if (reconnectTimer !== undefined) return;
      reconnectTimer = window.setTimeout(() => {
        setStreamAttempt((attempt) => attempt + 1);
      }, STREAM_RECONNECT_MS);
    };
    setStreamStatus("connecting");
    source.onmessage = (message) => {
      const event = parsePreviewEvent(message.data);
      if (event.type === "frame") {
        if (reconnectTimer !== undefined) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
        lastFrameAt.current = Date.now();
        setFrame(event);
        setStreamStatus("live");
        setError(null);
      } else if (event.type === "error") {
        reconnect(event.error);
      }
    };
    source.onerror = () => reconnect("浏览器画面连接中断，正在自动恢复。");
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastFrameAt.current > STALE_FRAME_MS) {
        reconnect("浏览器画面暂时不可用，正在自动恢复。");
      }
    }, 1_000);
    return () => {
      window.clearInterval(watchdog);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      source.close();
    };
  }, [base, controlId, streamAttempt]);

  useEffect(() => {
    if (!controlId) return;
    const heartbeat = () =>
      void consoleApi(`${base}/control/heartbeat`, {
        body: JSON.stringify({ controlId }),
        method: "POST",
      }).catch((heartbeatError: Error) => {
        setStreamStatus("interrupted");
        setError(heartbeatError.message);
      });
    const timer = window.setInterval(heartbeat, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [base, controlId]);

  useEffect(() => {
    if (!controlId) return;
    return () => {
      void fetch(`/console/api${base}/control`, {
        body: JSON.stringify({ controlId }),
        credentials: "include",
        headers: { "content-type": "application/json" },
        keepalive: true,
        method: "DELETE",
      });
    };
  }, [base, controlId]);

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const lease = await consoleApi<{ id: string }>(`${base}/control`, {
        method: "POST",
      });
      setControlId(lease.id);
      setStreamAttempt((attempt) => attempt + 1);
      setStreamStatus("connecting");
      await load();
    } catch (claimError) {
      setError((claimError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const send = useCallback(
    async (events: BrowserHumanInputEvent[]) => {
      if (!controlId || streamStatus !== "live") return;
      try {
        await consoleApi(`${base}/control/input`, {
          body: JSON.stringify({ controlId, events }),
          method: "POST",
        });
      } catch (inputError) {
        setError((inputError as Error).message);
      }
    },
    [base, controlId, streamStatus],
  );

  async function complete(resolution: "continue" | "cancel") {
    if (!controlId) return;
    setBusy(true);
    setError(null);
    try {
      await consoleApi(`${base}/complete`, {
        body: JSON.stringify({ controlId, note, resolution }),
        method: "POST",
      });
      setControlId(null);
      setFrame(null);
      setStreamStatus("idle");
      await onComplete();
    } catch (completeError) {
      setError((completeError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const remaining = formatRemaining(checkpoint.expiresAt);

  const panel = (
    <section
      className={`dp-browser-handoff${floating ? " is-floating" : ""}${fullscreen ? " is-fullscreen" : ""}`}
    >
      <header>
        <span>
          <Hand />
          <b>浏览器人工接管</b>
        </span>
        <div className="dp-browser-handoff-header-actions">
          <span className="dp-browser-handoff-status">
            <Clock3 /> {remaining}
            <Badge tone={streamStatus === "live" ? "success" : "warning"}>
              {handoffLabel(controlId, streamStatus)}
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
        <strong>需要你在 Agent 的原浏览器会话中完成操作</strong>
        <p>{checkpoint.prompt}</p>
        <small>
          <ShieldCheck />
          输入只会通过临时控制通道发送到 Browser Runtime，不会进入 Agent
          提示词、验证追踪记录或制品。
        </small>
      </div>

      {error ? (
        <div className="dp-browser-handoff-error">
          <CircleAlert /> {error}
        </div>
      ) : null}

      {!handoff ? (
        <div className="dp-browser-handoff-loading">
          <LoaderCircle /> 正在检查浏览器会话…
        </div>
      ) : !handoff.ready ? (
        <div className="dp-browser-handoff-unavailable">
          <CircleAlert />
          <span>
            <b>{unavailableCopy(handoff).title}</b>
            <small>{unavailableCopy(handoff).detail}</small>
          </span>
          <Button onClick={() => void load()} variant="secondary">
            <RotateCcw /> 重试
          </Button>
        </div>
      ) : !controlId ? (
        <div className="dp-browser-handoff-claim">
          <MonitorPlay />
          <span>
            <b>
              {handoff.runtimeSession?.profileId
                ? "用户 Browser Profile"
                : `${displayLabel(handoff.runtimeSession?.profileMode)} Profile`}
            </b>
            <small>
              {displayLabel(handoff.runtimeSession?.profileMode)} ·
              同一浏览器会话
            </small>
          </span>
          <Button
            disabled={
              busy ||
              Boolean(handoff.control && !handoff.control.controlledByMe)
            }
            onClick={() => void claim()}
          >
            {busy ? <LoaderCircle /> : <Hand />}
            {handoff.control && !handoff.control.controlledByMe
              ? "已在其他窗口接管"
              : "开始接管浏览器"}
          </Button>
        </div>
      ) : (
        <div className="dp-browser-handoff-session">
          <div className="dp-browser-frame">
            <div
              aria-label="远程 Browser Runtime，可使用键盘和指针操作"
              className={`dp-browser-viewport ${streamStatus === "live" ? "is-controllable" : ""}`}
              onContextMenu={(event) => event.preventDefault()}
              onFocus={(event) => {
                if (event.target === event.currentTarget)
                  keyboardRef.current?.focus({ preventScroll: true });
              }}
              onPointerCancel={() => void send([{ type: "release" }])}
              onPointerDown={(event) =>
                void handlePointer(
                  event,
                  "down",
                  viewportRef.current,
                  imageRef.current,
                  keyboardRef.current,
                  send,
                )
              }
              onPointerMove={(event) => {
                if (
                  !event.buttons ||
                  Date.now() - lastPointerMoveAt.current < 32
                )
                  return;
                lastPointerMoveAt.current = Date.now();
                void handlePointer(
                  event,
                  "move",
                  viewportRef.current,
                  imageRef.current,
                  keyboardRef.current,
                  send,
                );
              }}
              onPointerUp={(event) =>
                void handlePointer(
                  event,
                  "up",
                  viewportRef.current,
                  imageRef.current,
                  keyboardRef.current,
                  send,
                )
              }
              onWheel={(event) =>
                void handleWheel(
                  event,
                  viewportRef.current,
                  imageRef.current,
                  send,
                )
              }
              ref={viewportRef}
              tabIndex={0}
            >
              <RemoteKeyboard ref={keyboardRef} send={send} />
              {frame ? (
                <img
                  alt="Browser Runtime 实时画面"
                  draggable={false}
                  ref={imageRef}
                  src={`data:image/jpeg;base64,${frame.dataBase64}`}
                />
              ) : (
                <div className="dp-browser-viewport-waiting">
                  <LoaderCircle /> 正在连接原浏览器会话…
                </div>
              )}
              {streamStatus === "interrupted" ? (
                <div className="dp-browser-viewport-blocked">
                  <LoaderCircle /> 连接中断，正在自动恢复画面与输入…
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
              点击画面定位输入焦点，可使用键盘、粘贴和滚轮完成登录、MFA
              或验证码。
            </div>
            <Field label="交还说明">
              <Input
                onChange={(event) => setNote(event.target.value)}
                value={note}
              />
            </Field>
            <div className="dp-browser-handoff-actions">
              <Button
                disabled={busy}
                onClick={() => void complete("cancel")}
                variant="secondary"
              >
                无法完成，返回 Agent
              </Button>
              <Button
                disabled={busy || streamStatus !== "live"}
                onClick={() => void complete("continue")}
              >
                {busy ? <LoaderCircle /> : <ShieldCheck />}
                我已完成，交还 Agent
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );

  if ((fullscreen || floating) && overlayHost) {
    return createPortal(panel, overlayHost);
  }
  return floating ? null : panel;
}

function RemoteKeyboard({
  ref,
  send,
}: {
  ref: React.Ref<HTMLTextAreaElement>;
  send: (events: BrowserHumanInputEvent[]) => Promise<void>;
}) {
  function key(
    event: KeyboardEvent<HTMLTextAreaElement>,
    phase: "down" | "up",
  ) {
    if (isPlainText(event) || isPaste(event)) return;
    event.preventDefault();
    void send([{ key: remoteKey(event.key), phase, type: "key" }]);
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
      onBlur={() => void send([{ type: "release" }])}
      onCompositionEnd={composition}
      onInput={text}
      onKeyDown={(event) => key(event, "down")}
      onKeyUp={(event) => key(event, "up")}
      onPaste={paste}
      ref={ref}
      tabIndex={-1}
    />
  );
}

async function handlePointer(
  event: PointerEvent<HTMLDivElement>,
  phase: "down" | "move" | "up",
  container: HTMLDivElement | null,
  image: HTMLImageElement | null,
  keyboard: HTMLTextAreaElement | null,
  send: (events: BrowserHumanInputEvent[]) => Promise<void>,
) {
  const point = normalizedPoint(event.clientX, event.clientY, container, image);
  if (!point) return;
  event.preventDefault();
  const target = event.currentTarget;
  if (phase === "down") target.setPointerCapture(event.pointerId);
  keyboard?.focus({ preventScroll: true });
  await send([
    { button: pointerButton(event.button), phase, type: "pointer", ...point },
  ]);
  if (phase === "up" && target.hasPointerCapture(event.pointerId))
    target.releasePointerCapture(event.pointerId);
}

async function handleWheel(
  event: WheelEvent<HTMLDivElement>,
  container: HTMLDivElement | null,
  image: HTMLImageElement | null,
  send: (events: BrowserHumanInputEvent[]) => Promise<void>,
) {
  const point = normalizedPoint(event.clientX, event.clientY, container, image);
  if (!point) return;
  event.preventDefault();
  await send([
    {
      deltaX: clampWheel(event.deltaX),
      deltaY: clampWheel(event.deltaY),
      type: "wheel",
      ...point,
    },
  ]);
}

function normalizedPoint(
  clientX: number,
  clientY: number,
  container: HTMLElement | null,
  image: HTMLImageElement | null,
) {
  if (
    !container ||
    !image ||
    image.naturalWidth <= 0 ||
    image.naturalHeight <= 0
  )
    return null;
  const bounds = container.getBoundingClientRect();
  const scale = Math.min(
    bounds.width / image.naturalWidth,
    bounds.height / image.naturalHeight,
  );
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const left = bounds.left + (bounds.width - width) / 2;
  const top = bounds.top + (bounds.height - height) / 2;
  const x = (clientX - left) / width;
  const y = (clientY - top) / height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function pointerButton(button: number): "left" | "middle" | "none" | "right" {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "none";
}

function isPlainText(event: KeyboardEvent<HTMLTextAreaElement>) {
  return (
    event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey
  );
}

function isPaste(event: KeyboardEvent<HTMLTextAreaElement>) {
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
}

function remoteKey(key: string) {
  return key === "Meta" ? "Control" : key;
}

function clampWheel(value: number) {
  return Math.max(-2000, Math.min(2000, value));
}

function parsePreviewEvent(
  value: string,
):
  | PreviewFrame
  | { error: string; type: "error" }
  | { connected: boolean; type: "status" } {
  try {
    return JSON.parse(value) as PreviewFrame;
  } catch {
    return { error: "浏览器画面流返回了无效数据。", type: "error" };
  }
}

function handoffLabel(
  controlId: string | null,
  status: "idle" | "connecting" | "live" | "interrupted",
) {
  if (!controlId) return "等待接管";
  if (status === "live") return "由你控制";
  if (status === "interrupted") return "连接中断";
  return "连接中";
}

function formatRemaining(expiresAt: string) {
  const seconds = Math.max(
    0,
    Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000),
  );
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function unavailableCopy(handoff: BrowserHandoffStatus) {
  if (handoff.unavailableReason === "PROTOCOL_UNSUPPORTED") {
    return {
      detail: "请重新构建并重启 Browser Runtime，然后重新发起验证。",
      title: "Browser Runtime 版本不支持网页内人工控制",
    };
  }
  if (handoff.unavailableReason === "SESSION_UNAVAILABLE") {
    return {
      detail: `原会话状态为 ${displayLabel(handoff.runtimeSession?.status ?? "未知")}，已无法恢复页面；请重新发起验证。`,
      title: "Agent 已关闭或丢失原浏览器会话",
    };
  }
  return {
    detail: "当前 HITL 没有关联可接管的浏览器会话。",
    title: "没有可用的浏览器会话",
  };
}
