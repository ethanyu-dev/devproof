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
import {
  Globe2,
  KeyRound,
  Keyboard,
  LoaderCircle,
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
import { displayLabel } from "@/lib/display-text";

type TriggerSource = "CONSOLE" | "FEISHU" | "ISSUE_ASSIGNEE";

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
            ? "登录状态验证成功，Profile 已可用于任务。"
            : name === "approve"
              ? "已授权本次任务入口使用该 Profile。"
              : "操作已提交。",
        tone: "success",
      });
    } catch (error) {
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
        text: "Profile 及其 Browser Runtime 登录数据已删除。",
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
      <PageHeader title="浏览器 Profile" />
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
              <strong>我的 Profile</strong>
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
                  暂无登录任务。任务选择“使用我的 Profile”或“Issue owner
                  Profile”后，系统会按目标站点自动创建。
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
                      和登录态只保存在分配的 Browser Runtime。
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
                Profile 会由需要登录态的任务自动创建，无需提前配置。
              </div>
            )}
          </section>
        </div>
      )}
      {selected?.activeSession?.status === "HUMAN_CONTROL" ? (
        <ProfileBrowser
          profile={selected}
          busy={busy}
          onVerify={() => void action("verify")}
        />
      ) : selected ? (
        <Card className="dp-profile-status-card">
          <ShieldCheck />
          <span>
            <b>Profile 状态：{displayLabel(selected.status)}</b>
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
  onVerify,
  profile,
}: {
  busy: boolean;
  onVerify: () => void;
  profile: Profile;
}) {
  const [frame, setFrame] = useState<{
    dataBase64: string;
    height: number;
    title: string;
    url: string;
    width: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const lastPointerMoveAt = useRef(0);

  useEffect(() => {
    const source = new EventSource(
      `/console/api/browser-profiles/${profile.id}/browser/stream`,
      { withCredentials: true },
    );
    source.onmessage = (message) => {
      let event: {
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
        setError("Browser Runtime 返回了无法识别的实时画面事件。");
        return;
      }
      if (
        event.type === "frame" &&
        event.dataBase64 &&
        event.height &&
        event.width
      )
        setFrame({
          dataBase64: event.dataBase64,
          height: event.height,
          title: event.title ?? "",
          url: event.url ?? "",
          width: event.width,
        });
      if (event.type === "error") setError(event.error ?? "实时画面连接中断。");
    };
    source.onerror = () =>
      setError("实时画面连接中断，正在等待 Runtime 恢复。");
    return () => source.close();
  }, [profile.id]);

  async function send(events: BrowserHumanInputEvent[]) {
    await consoleApi(`/browser-profiles/${profile.id}/browser/input`, {
      body: JSON.stringify({ events }),
      method: "POST",
    }).catch((inputError: Error) => setError(inputError.message));
  }

  return (
    <Card className="dp-profile-browser">
      <header>
        <span>
          <Keyboard />
          <b>完成登录或 MFA</b>
          <small>{frame?.url ?? "正在连接浏览器画面…"}</small>
        </span>
        <Button disabled={busy || !frame} onClick={onVerify}>
          <ShieldCheck />
          验证并保存
        </Button>
      </header>
      <div
        aria-label="远程 Profile 登录浏览器，可使用键盘和指针操作"
        className="dp-profile-browser-frame"
        onContextMenu={(event) => event.preventDefault()}
        onFocus={(event) => {
          if (event.target === event.currentTarget)
            keyboard.current?.focus({ preventScroll: true });
        }}
        onPointerCancel={() => void send([{ type: "release" }])}
        onPointerDown={(event) =>
          void pointer(
            event,
            "down",
            container.current,
            image.current,
            keyboard.current,
            send,
          )
        }
        onPointerMove={(event) => {
          if (!event.buttons || Date.now() - lastPointerMoveAt.current < 32)
            return;
          lastPointerMoveAt.current = Date.now();
          void pointer(
            event,
            "move",
            container.current,
            image.current,
            keyboard.current,
            send,
          );
        }}
        onPointerUp={(event) =>
          void pointer(
            event,
            "up",
            container.current,
            image.current,
            keyboard.current,
            send,
          )
        }
        onWheel={(event) =>
          void wheel(event, container.current, image.current, send)
        }
        ref={container}
        tabIndex={0}
      >
        {frame ? (
          <img
            alt="用户 Profile 登录浏览器"
            draggable={false}
            ref={image}
            src={`data:image/jpeg;base64,${frame.dataBase64}`}
          />
        ) : (
          <div>
            <LoaderCircle />
            正在加载 Browser Runtime…
          </div>
        )}
        <RemoteKeyboard inputRef={keyboard} send={send} />
      </div>
      <footer>
        {error ??
          "点击画面后可输入键盘、粘贴、点击与滚动。完成后点击“验证并保存”。"}
      </footer>
    </Card>
  );
}

function RemoteKeyboard({
  inputRef,
  send,
}: {
  inputRef: React.Ref<HTMLTextAreaElement>;
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
      onBlur={() => void send([{ type: "release" }])}
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

async function pointer(
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
    {
      button: pointerButton(event),
      phase,
      type: "pointer",
      ...point,
    },
  ]);
  if (phase === "up" && target.hasPointerCapture(event.pointerId))
    target.releasePointerCapture(event.pointerId);
}

function pointerButton(event: PointerEvent<HTMLDivElement>) {
  if (event.button === 2 || (event.button === -1 && event.buttons === 2))
    return "right" as const;
  if (event.button === 1 || (event.button === -1 && event.buttons === 4))
    return "middle" as const;
  return "left" as const;
}

async function wheel(
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
      deltaX: Math.max(-2000, Math.min(2000, event.deltaX)),
      deltaY: Math.max(-2000, Math.min(2000, event.deltaY)),
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
  if (!container || !image || !image.naturalWidth || !image.naturalHeight)
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
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
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
