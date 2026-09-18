"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { BrowserHumanInputEvent } from "@devproof/runtime-protocol";
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
  X,
} from "lucide-react";
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

import { consoleApi } from "@/lib/api";
import { BrowserControlConnection } from "@/lib/browser-connection";
import { BrowserInputQueue } from "@/lib/browser-input-queue";
import {
  BrowserPointerController,
  normalizedBrowserPoint,
} from "@/lib/browser-pointer-controller";
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

interface RunBrowserHitlProps {
  intervention: {
    expiresAt: string;
    id: string;
    kind?: string;
    context?: {
      accountSlots?: Array<{
        slotId: string;
        label: string;
        requiredTypes: string[];
      }>;
    };
    prompt: string;
    notificationError?: string;
  };
  onComplete: () => Promise<void>;
  runId: string;
}

interface SharedBrowserHitlProps {
  base: string;
  checkpoint: {
    expiresAt: string;
    id: string;
    prompt: string;
    kind?: string;
    context?: RunBrowserHitlProps["intervention"]["context"];
  };
  floating?: boolean;
  onComplete: () => Promise<void>;
}

const HEARTBEAT_MS = 8_000;
const STALE_FRAME_MS = 6_000;
const STREAM_RECONNECT_MS = 1_200;

export function RunHitlBrowser({
  intervention,
  onComplete,
  runId,
}: RunBrowserHitlProps) {
  if (intervention.kind === "TEST_ACCOUNT") {
    return (
      <TestAccountInput
        intervention={intervention}
        onComplete={onComplete}
        runId={runId}
      />
    );
  }
  return (
    <BrowserHitl
      base={`/runs/${runId}/interventions/${intervention.id}/browser`}
      checkpoint={intervention}
      floating
      onComplete={onComplete}
    />
  );
}

function TestAccountInput({
  intervention,
  onComplete,
  runId,
}: RunBrowserHitlProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const accountInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(true);
  const [account, setAccount] = useState("");
  const [instructions, setInstructions] = useState("");
  const [accounts, setAccounts] = useState<Record<string, string>>({});
  const slots = intervention.context?.accountSlots ?? [];
  const [mode, setMode] = useState<"account" | "instructions">("account");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      accountInput.current?.focus({ preventScroll: true });
    } else dialog.current?.close();
  }, [open]);

  function close() {
    if (busy) return;
    setOpen(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (
      mode === "account" &&
      slots.length === 0 &&
      (!/^[\p{L}\p{N}][\p{L}\p{N}._@+:-]*$/u.test(account.trim()) ||
        /删除|重新创建|允许你|先把|再创建|帮我|重试/u.test(account))
    ) {
      setError("请填写账号标识；删除或重建说明请切换到处置意见。");
      return;
    }
    if (
      mode === "account" &&
      slots.some(
        (slot) =>
          !/^[\p{L}\p{N}][\p{L}\p{N}._@+:-]*$/u.test(
            accounts[slot.slotId]?.trim() ?? "",
          ),
      )
    ) {
      setError("请填写每个请求角色的有效账号。");
      return;
    }
    if (mode === "instructions" && instructions.trim().length < 5) {
      setError("请说明具体处置意见（至少 5 个字符）。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await consoleApi(
        `/runs/${runId}/interventions/${intervention.id}/resolve`,
        {
          method: "POST",
          body: JSON.stringify({
            response:
              mode === "account"
                ? slots.length
                  ? {
                      accounts: Object.fromEntries(
                        slots.map((slot) => [
                          slot.slotId,
                          accounts[slot.slotId]!.trim(),
                        ]),
                      ),
                    }
                  : { account: account.trim() }
                : { instructions: instructions.trim() },
          }),
        },
      );
      await onComplete();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        ref={trigger}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Hand /> 待人工处理
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={`account-title-${intervention.id}`}
        aria-describedby={`account-prompt-${intervention.id}`}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus({ preventScroll: true });
        }}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        className="m-auto max-h-[85vh] w-[min(640px,calc(100vw_-_32px))] overflow-y-auto rounded-xl border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/40"
      >
        <div className="flex items-center justify-between gap-4">
          <h2
            id={`account-title-${intervention.id}`}
            className="flex items-center gap-2 text-lg font-semibold"
          >
            <Hand className="size-5 text-primary" /> 提供测试账号
          </h2>
          <Button
            aria-label="关闭人工处理弹窗"
            disabled={busy}
            onClick={close}
            size="icon-sm"
            variant="ghost"
          >
            <X />
          </Button>
        </div>
        <p
          id={`account-prompt-${intervention.id}`}
          className="my-4 whitespace-pre-wrap break-words text-sm leading-6"
        >
          {intervention.prompt}
        </p>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <div className="flex gap-2" role="group" aria-label="处理方式">
            <Button
              type="button"
              disabled={busy}
              variant={mode === "account" ? "default" : "secondary"}
              onClick={() => {
                setMode("account");
                setError(null);
              }}
            >
              提供新账号
            </Button>
            <Button
              type="button"
              disabled={busy}
              variant={mode === "instructions" ? "default" : "secondary"}
              onClick={() => {
                setMode("instructions");
                setError(null);
              }}
            >
              提交处置意见
            </Button>
          </div>
          {intervention.notificationError ? (
            <p role="status" className="text-sm text-amber-700">
              通知未送达：{intervention.notificationError}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            等待截止：{new Date(intervention.expiresAt).toLocaleString("zh-CN")}
          </p>
          {mode === "account" ? (
            slots.length ? (
              <div className="grid gap-3">
                {slots.map((slot) => (
                  <Field
                    key={slot.slotId}
                    label={slot.label}
                    description={slot.requiredTypes.join("、")}
                  >
                    <Input
                      aria-label={slot.label}
                      disabled={busy}
                      maxLength={200}
                      required
                      value={accounts[slot.slotId] ?? ""}
                      onChange={(event) =>
                        setAccounts({
                          ...accounts,
                          [slot.slotId]: event.target.value,
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
            ) : (
              <Field label="测试账号">
                <Input
                  ref={accountInput}
                  autoComplete="off"
                  disabled={busy}
                  maxLength={200}
                  onChange={(event) => setAccount(event.target.value)}
                  required
                  value={account}
                />
              </Field>
            )
          ) : (
            <Field
              label="处置意见"
              description="保留原账号。Agent 将结合记录归属和实际状态判断能否执行你的处置意见。"
            >
              <textarea
                className="min-h-24 w-full rounded-md border p-3 text-sm"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                maxLength={2000}
                disabled={busy}
                required
              />
            </Field>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <p className="text-xs leading-5 text-muted-foreground">
            用例正在等待处理。关闭后可从页面顶部“待人工处理”重新打开。
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={busy}
              onClick={close}
              type="button"
              variant="secondary"
            >
              稍后处理
            </Button>
            <Button
              disabled={
                busy ||
                !(mode === "account"
                  ? slots.length
                    ? slots.every((slot) => accounts[slot.slotId]?.trim())
                    : account.trim()
                  : instructions.trim())
              }
              type="submit"
            >
              {busy ? "正在提交…" : "提交并继续执行"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}

function BrowserHitl({
  base,
  checkpoint,
  floating = false,
  onComplete,
}: SharedBrowserHitlProps) {
  const [handoff, setHandoff] = useState<BrowserHandoffStatus | null>(null);
  const connection = useRef<{
    base: string;
    controlId: string;
    channel: BrowserControlConnection;
  } | null>(null);
  const [controlId, setControlId] = useState<string | null>(null);
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const [streamStatus, setStreamStatus] = useState<
    "idle" | "connecting" | "live" | "interrupted"
  >("idle");
  const [streamAttempt, setStreamAttempt] = useState(0);
  const dataPrecondition = checkpoint.kind === "DATA_PRECONDITION";
  const accountSlots = checkpoint.context?.accountSlots ?? [];
  const [replaceAccount, setReplaceAccount] = useState(false);
  const [replacementAccount, setReplacementAccount] = useState("");
  const [replacementSlot, setReplacementSlot] = useState(
    accountSlots.length === 1 ? accountSlots[0]!.slotId : "",
  );
  const [note, setNote] = useState(
    dataPrecondition ? "" : "已在浏览器中完成所需操作。",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
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
    const source = new BrowserControlConnection({
      connectionPath: `${base}/connection`,
      connectionBody: { controlId },
      streamUrl: `/console/api${base}/stream`,
      relayInput: (events) =>
        consoleApi(`${base}/control/input`, {
          method: "POST",
          body: JSON.stringify({ controlId, events }),
        }),
    });
    connection.current = { base, controlId, channel: source };
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
      if (connection.current?.channel === source) connection.current = null;
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

  const inputQueue = useMemo(
    () =>
      new BrowserInputQueue((events) => {
        if (!controlId) return Promise.resolve();
        const current = connection.current;
        if (
          !current ||
          current.base !== base ||
          current.controlId !== controlId
        )
          return Promise.reject(new Error("浏览器控制权已切换，请重新操作。"));
        return current.channel.input(events);
      }),
    [base, controlId],
  );
  const send = useCallback(
    async (events: BrowserHumanInputEvent[]) => {
      if (!controlId) return;
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
    [controlId, inputQueue],
  );
  const pointerController = useMemo(
    () => new BrowserPointerController(send),
    [send],
  );

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

  async function complete(resolution: "continue" | "cancel") {
    if (!controlId) return;
    setBusy(true);
    setError(null);
    try {
      await consoleApi(`${base}/complete`, {
        body: JSON.stringify({
          controlId,
          note,
          resolution,
          ...(dataPrecondition && replaceAccount && resolution === "continue"
            ? {
                accountReplacement: {
                  account: replacementAccount.trim(),
                  ...(replacementSlot ? { slotId: replacementSlot } : {}),
                },
              }
            : {}),
        }),
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
          输入只会通过临时控制通道发送到浏览器执行节点，不会进入 Agent
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
                ? "用户浏览器身份"
                : `${displayLabel(handoff.runtimeSession?.profileMode)} · 浏览器身份`}
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
              aria-label="远程浏览器执行节点，可使用键盘和指针操作"
              className={`dp-browser-viewport ${streamStatus === "live" ? "is-controllable" : ""}`}
              onContextMenu={(event) => event.preventDefault()}
              onFocus={(event) => {
                if (event.target === event.currentTarget)
                  keyboardRef.current?.focus({ preventScroll: true });
              }}
              onPointerCancel={() => pointerController.cancel()}
              onPointerDown={(event) =>
                handlePointer(
                  event,
                  "down",
                  viewportRef.current,
                  frame,
                  keyboardRef.current,
                  pointerController,
                )
              }
              onPointerMove={(event) => {
                if (
                  !event.buttons ||
                  Date.now() - lastPointerMoveAt.current < 32
                )
                  return;
                lastPointerMoveAt.current = Date.now();
                handlePointer(
                  event,
                  "move",
                  viewportRef.current,
                  frame,
                  keyboardRef.current,
                  pointerController,
                );
              }}
              onPointerUp={(event) =>
                handlePointer(
                  event,
                  "up",
                  viewportRef.current,
                  frame,
                  keyboardRef.current,
                  pointerController,
                )
              }
              onWheel={(event) =>
                void handleWheel(event, viewportRef.current, frame, send)
              }
              ref={viewportRef}
              tabIndex={0}
            >
              <RemoteKeyboard
                ref={keyboardRef}
                release={() => pointerController.cancel()}
                send={send}
              />
              {frame ? (
                <img
                  alt="浏览器执行节点实时画面"
                  draggable={false}
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
              {dataPrecondition
                ? "可以在浏览器中处理冲突，也可以填写处置意见，让 Agent 按授权处理后继续测试。"
                : "点击画面定位输入焦点，可使用键盘、粘贴和滚轮完成登录、MFA 或验证码。"}
            </div>
            {dataPrecondition ? (
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={replaceAccount}
                    onChange={(e) => setReplaceAccount(e.target.checked)}
                  />
                  更换测试账号后继续
                </label>
                {replaceAccount ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {accountSlots.length > 1 ? (
                      <Field label="账号角色">
                        <select
                          className="h-10 w-full rounded border px-3"
                          value={replacementSlot}
                          onChange={(e) => setReplacementSlot(e.target.value)}
                        >
                          <option value="">请选择需要更换的角色</option>
                          {accountSlots.map((slot) => (
                            <option key={slot.slotId} value={slot.slotId}>
                              {slot.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ) : null}
                    <Field label="新账号">
                      <Input
                        value={replacementAccount}
                        onChange={(e) => setReplacementAccount(e.target.value)}
                        placeholder="UUID、邮箱、手机号或用户 ID"
                      />
                    </Field>
                  </div>
                ) : null}
              </div>
            ) : null}
            <Field label={dataPrecondition ? "处置意见" : "交还说明"}>
              <Input
                placeholder={
                  dataPrecondition
                    ? "例如：可以先删除上述记录开展后续测试"
                    : undefined
                }
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
                disabled={
                  busy ||
                  streamStatus !== "live" ||
                  (replaceAccount &&
                    (!replacementAccount.trim() ||
                      (accountSlots.length > 1 && !replacementSlot)))
                }
                onClick={() => void complete("continue")}
              >
                {busy ? <LoaderCircle /> : <ShieldCheck />}
                {dataPrecondition
                  ? "提交意见，交还 Agent"
                  : "我已完成，交还 Agent"}
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
  release,
  send,
}: {
  ref: React.Ref<HTMLTextAreaElement>;
  release: () => void;
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
      onBlur={release}
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

function handlePointer(
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
    button: pointerButton(event.button),
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

async function handleWheel(
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
      deltaX: clampWheel(event.deltaX),
      deltaY: clampWheel(event.deltaY),
      type: "wheel",
      ...point,
    },
  ]);
}

function releasePointerCapture(event: PointerEvent<HTMLDivElement>) {
  if (event.currentTarget.hasPointerCapture(event.pointerId))
    event.currentTarget.releasePointerCapture(event.pointerId);
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
      detail: "请重新构建并重启浏览器执行节点，然后重新发起验证。",
      title: "浏览器执行节点版本不支持网页内人工控制",
    };
  }
  if (handoff.unavailableReason === "SESSION_UNAVAILABLE") {
    return {
      detail: `原会话状态为 ${displayLabel(handoff.runtimeSession?.status ?? "未知")}，已无法恢复页面；请重新发起验证。`,
      title: "Agent 已关闭或丢失原浏览器会话",
    };
  }
  return {
    detail: "当前人工接管任务没有关联可接管的浏览器会话。",
    title: "没有可用的浏览器会话",
  };
}
