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
  ChevronDown,
  CircleAlert,
  Clock3,
  Globe2,
  KeyRound,
  Keyboard,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Monitor,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { BrowserHumanInputEvent } from "@devproof/runtime-protocol";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/native-select";
import styles from "./profiles.module.css";

import { PageHeader } from "@/components/page-header";
import {
  ErrorState,
  FormMessage,
  LoadingState,
} from "@/components/settings-layout";
import { consoleApi } from "@/lib/api";
import { BrowserControlConnection } from "@/lib/browser-connection";
import { BrowserInputQueue } from "@/lib/browser-input-queue";
import {
  BrowserPointerController,
  normalizedBrowserPoint,
} from "@/lib/browser-pointer-controller";
import { displayLabel } from "@/lib/display-text";

import type { Profile, TriggerSource } from "./profile-types";
import { ProfileCreateDialog } from "./profile-create-dialog";

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

export function ProfilesClient() {
  const [createOpen, setCreateOpen] = useState(false);
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
    name: Exclude<ProfileOperation, "delete" | "settings">,
    prepareIsolatedAuth = false,
    profile = selected,
  ) {
    if (!profile) return;
    if (operation && name !== "close") return;
    if (name === "close") operationAbort.current?.abort();
    const controller = new AbortController();
    const sequence = ++operationSequence.current;
    operationAbort.current = controller;
    setOperation(name);
    setMessage(null);
    try {
      const result = await consoleApi<Profile>(
        `/browser-profiles/${profile.id}/${name}`,
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
      await load(profile.id);
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
      await load(profile.id).catch(() => undefined);
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
    <div className={styles.page}>
      <PageHeader
        description="在你的身份库中分别保存各网站、环境和角色的登录状态，供后续任务复用。"
        title="浏览器身份"
        actions={
          <>
            <Button
              disabled={busy}
              onClick={() => void load().catch(() => undefined)}
              variant="secondary"
              size="sm"
            >
              <RefreshCw /> 刷新
            </Button>
            <Button
              disabled={busy || profiles === null}
              onClick={() => setCreateOpen(true)}
              aria-haspopup="dialog"
              size="sm"
            >
              <Plus /> 添加网站并登录
            </Button>
          </>
        }
      />
      {message ? (
        <FormMessage message={message.text} tone={message.tone} />
      ) : null}
      {loadError && profiles !== null && !message ? (
        <FormMessage message={loadError} tone="error" />
      ) : null}
      {profiles === null ? (
        <Card className={styles.detail}>
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
        <div className={styles.layout}>
          <Card className={styles.sidebar}>
            <section aria-labelledby="profile-list-heading">
              <header className={styles.listHeader}>
                <h2 id="profile-list-heading">我的身份库</h2>
                <span>{profiles.length}</span>
              </header>
              <div className={styles.list}>
                {profiles.map((profile) => (
                  <button
                    aria-pressed={profile.id === selectedId}
                    className={styles.entry}
                    key={profile.id}
                    onClick={() => select(profile)}
                    disabled={operation !== null}
                    type="button"
                  >
                    <span className={styles.entryHeading}>
                      <strong title={profile.displayName}>
                        {profile.displayName}
                      </strong>
                      <Badge tone={profileTone(profile.status)}>
                        {displayLabel(profile.status)}
                      </Badge>
                    </span>
                    <small>
                      {profile.siteHostname &&
                      profile.siteHostname !== profile.displayName
                        ? profile.siteHostname
                        : profile.lastUsedAt
                          ? `最近使用 ${formatDate(profile.lastUsedAt)}`
                          : "尚未用于任务"}
                    </small>
                  </button>
                ))}
                {!profiles.length ? (
                  <p className={styles.emptyCopy}>
                    添加常用网站，提前准备登录身份。
                  </p>
                ) : null}
              </div>
              {profiles.length > 0 && (
                <p className={styles.listHint}>
                  可主动添加网站，也会展示任务自动创建的身份。
                </p>
              )}
            </section>
          </Card>
          <Card className={styles.detail}>
            {selected ? (
              <>
                <header className={styles.detailHeader}>
                  <div className={styles.identityHeading}>
                    <div>
                      <h2>{selected.displayName}</h2>
                      <Badge tone={profileTone(selected.status)}>
                        {displayLabel(selected.status)}
                      </Badge>
                    </div>
                    <p>
                      {selected.snapshotDistributionAvailable
                        ? "各网站登录独立保存；兼容的登录快照可加密分发给执行节点，用于后续任务验证。"
                        : "登录状态仅保存在执行节点，用于后续任务验证。"}
                    </p>
                  </div>
                  <Button
                    className={`dp-profile-operation-button${operation === "prepare" || operation === "reauth" ? " is-loading" : ""}`}
                    disabled={busy || loginBlocked}
                    onClick={() =>
                      void action(requiresReauth ? "reauth" : "prepare")
                    }
                    variant={requiresReauth ? "secondary" : "primary"}
                    size="sm"
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
                        : "登录网站"}
                  </Button>
                </header>
                <dl className={styles.facts}>
                  <div>
                    <dt>
                      <Globe2 />
                      目标站点
                    </dt>
                    <dd>{selected.siteHostname ?? "待确定"}</dd>
                  </div>
                  <div>
                    <dt>
                      <ShieldCheck />
                      已授权入口
                    </dt>
                    <dd>
                      {activeTriggerSources(selected).length
                        ? activeTriggerSources(selected)
                            .map(grantLabel)
                            .join("、")
                        : "尚未授权"}
                    </dd>
                  </div>
                </dl>
                {selected.pendingTriggerSources.length ? (
                  <section
                    className={styles.consent}
                    aria-label="待确认的授权请求"
                  >
                    <div>
                      <h3>任务正在请求使用此身份</h3>
                      <p>
                        请求入口：
                        {selected.pendingTriggerSources
                          .map(grantLabel)
                          .join("、")}
                      </p>
                    </div>
                    {selected.status === "READY" ? (
                      <Button
                        disabled={busy}
                        onClick={() => void action("approve")}
                        size="sm"
                      >
                        <ShieldCheck /> 确认授权
                      </Button>
                    ) : (
                      <p>完成登录后将自动确认该请求。</p>
                    )}
                  </section>
                ) : null}
                {selected.activeSession?.status !== "HUMAN_CONTROL" &&
                ["PREPARING", "VERIFYING"].includes(selected.status) ? (
                  <div className={styles.sessionNotice} role="status">
                    <span>
                      <LoaderCircle />
                      {displayLabel(selected.status)}
                    </span>
                    <Button
                      disabled={operation === "close"}
                      onClick={() => void action("close")}
                      variant="secondary"
                      size="sm"
                    >
                      {operation === "close" ? <LoaderCircle /> : <X />}
                      {operation === "close" ? "正在关闭…" : "关闭登录"}
                    </Button>
                  </div>
                ) : null}
                <section
                  className={styles.settings}
                  aria-labelledby="profile-settings-heading"
                >
                  <h3 id="profile-settings-heading">执行设置</h3>
                  <form onSubmit={(event) => void saveExecutionSettings(event)}>
                    <div
                      className={`${styles.settingsFields}${executionMode === "ISOLATED_AUTH" ? ` ${styles.withConcurrency}` : ""}`}
                    >
                      <Field label="执行方式">
                        <Select
                          value={executionMode}
                          onChange={(event) =>
                            setExecutionMode(event.target.value)
                          }
                          disabled={busy}
                          aria-describedby="profile-execution-help"
                        >
                          <option value="SERIAL_PERSISTENT">
                            串行复用浏览器
                          </option>
                          <option
                            value="ISOLATED_AUTH"
                            disabled={
                              !selected.isolatedExecutionAvailable ||
                              !selected.authSnapshotGeneration
                            }
                          >
                            独立会话并发执行
                          </option>
                        </Select>
                      </Field>
                      {executionMode === "ISOLATED_AUTH" ? (
                        <Field label="此登录身份的并发上限（1–32）">
                          <Input
                            type="number"
                            min={1}
                            max={32}
                            value={executionConcurrency}
                            onChange={(event) =>
                              setExecutionConcurrency(
                                Number(event.target.value),
                              )
                            }
                            disabled={busy}
                            required
                          />
                        </Field>
                      ) : null}
                      <Button type="submit" disabled={busy} size="sm">
                        {operation === "settings" ? "正在保存…" : "保存设置"}
                      </Button>
                    </div>
                    <p className={styles.help} id="profile-execution-help">
                      {!selected.isolatedExecutionAvailable
                        ? "当前部署尚未启用并发登录功能，仅支持串行复用此身份。"
                        : selected.authSnapshotGeneration
                          ? "已通过 4 个独立会话的登录验证。实际并发受执行节点容量限制，存在读写冲突的任务仍会排队执行。"
                          : "如需并发执行，请先重新登录，在登录窗口勾选“验证并发登录”并保存。"}
                    </p>
                  </form>
                </section>
                <dl className={styles.timestamps} aria-label="身份使用记录">
                  <div>
                    <dt>最近验证</dt>
                    <dd>
                      <ProfileTimestamp value={selected.lastVerifiedAt} />
                    </dd>
                  </div>
                  <div>
                    <dt>最近使用</dt>
                    <dd>
                      <ProfileTimestamp value={selected.lastUsedAt} />
                    </dd>
                  </div>
                  <div>
                    <dt>自动清理</dt>
                    <dd>
                      <ProfileTimestamp value={selected.inactivityExpiresAt} />
                    </dd>
                  </div>
                </dl>
                <footer className={styles.management}>
                  <span>身份管理</span>
                  <div>
                    <Button
                      disabled={busy || selected.status === "DISABLED"}
                      onClick={() => void action("disable")}
                      variant="ghost"
                      size="sm"
                    >
                      停用
                    </Button>
                    <Button
                      aria-label={`永久清理 ${selected.displayName}`}
                      disabled={busy}
                      onClick={() => void purge()}
                      variant="ghost"
                      size="sm"
                      className={styles.deleteButton}
                    >
                      <Trash2 /> 清理登录数据
                    </Button>
                  </div>
                </footer>
              </>
            ) : (
              <div className={styles.empty}>
                <Globe2 />
                <h2>暂无浏览器身份</h2>
                <p>
                  提前登录常用网站并保存，后续任务选择“使用我的浏览器身份”即可复用。
                  需要登录的任务也会自动创建身份。
                </p>
                <Button
                  disabled={busy}
                  onClick={() => setCreateOpen(true)}
                  aria-haspopup="dialog"
                  size="sm"
                >
                  <Plus /> 添加网站并登录
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}
      <ProfileCreateDialog
        open={createOpen}
        profiles={profiles ?? []}
        onClose={() => setCreateOpen(false)}
        onRefresh={() => load()}
        onSelectExisting={(profile) => {
          setCreateOpen(false);
          select(profile);
        }}
        onCreated={(profile) => {
          setProfiles((current) => [profile, ...(current ?? [])]);
          setSelectedId(profile.id);
          setCreateOpen(false);
          void action("prepare", false, profile);
        }}
      />
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
      ) : null}
    </div>
  );
}

function ProfileTimestamp({ value }: { value: string | null }) {
  return value ? (
    <time dateTime={value}>{formatDate(value)}</time>
  ) : (
    <span>尚无</span>
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
  const connection = useRef<{
    profileId: string;
    sessionId: string | undefined;
    channel: BrowserControlConnection;
  } | null>(null);
  const inputQueue = useMemo(
    () =>
      new BrowserInputQueue((events) => {
        const current = connection.current;
        if (
          !current ||
          current.profileId !== profile.id ||
          current.sessionId !== profile.activeSession?.id
        )
          return Promise.reject(new Error("浏览器会话已切换，请重新操作。"));
        return current.channel.input(events);
      }),
    [profile.id, profile.activeSession?.id],
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
    const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const source = new BrowserControlConnection({
      connectionPath: `/browser-profiles/${profile.id}/browser/connection`,
      streamUrl: `/console/api/browser-profiles/${profile.id}/browser/stream?pixelRatio=${pixelRatio}`,
      relayInput: (events) =>
        consoleApi(`/browser-profiles/${profile.id}/browser/input`, {
          method: "POST",
          body: JSON.stringify({ events }),
        }),
    });
    connection.current = {
      profileId: profile.id,
      sessionId: profile.activeSession?.id,
      channel: source,
    };
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
      if (connection.current?.channel === source) connection.current = null;
    };
  }, [profile.id, profile.activeSession?.id]);

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
      className={`dp-browser-handoff dp-profile-browser-handoff ${styles.handoffPanel} is-floating${fullscreen ? " is-fullscreen" : ""}`}
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

      <details className={styles.handoffDetails}>
        <summary className={styles.handoffSummary}>
          <span className={styles.handoffPrompt}>
            完成登录或 MFA 后，点击“验证并保存”。
          </span>
          {profile.assignedRuntime ? (
            <span
              aria-label={`已分配浏览器执行节点 ${profile.assignedRuntime.name}`}
              className={styles.handoffRuntime}
            >
              <Monitor />
              <span
                className={styles.handoffRuntimeName}
                title={profile.assignedRuntime.name}
              >
                {profile.assignedRuntime.name}
              </span>
              <Badge tone={runtimeTone(profile.assignedRuntime.status)}>
                {displayLabel(profile.assignedRuntime.status)}
              </Badge>
            </span>
          ) : null}
          <span className={styles.handoffDetailsToggle}>
            详情 <ChevronDown />
          </span>
        </summary>
        <div className={styles.handoffDetailsContent}>
          <p>
            <ShieldCheck />
            <span>
              输入只会通过临时控制通道发送到浏览器执行节点，不会进入 Agent
              提示词、验证轨迹或制品。
            </span>
          </p>
          {profile.assignedRuntime ? (
            <dl>
              <div>
                <dt>执行节点</dt>
                <dd>{profile.assignedRuntime.name}</dd>
              </div>
              {profile.assignedRuntime.deviceInfo ? (
                <div>
                  <dt>系统</dt>
                  <dd>{profile.assignedRuntime.deviceInfo}</dd>
                </div>
              ) : null}
              {profile.assignedRuntime.lastSeenAt ? (
                <div>
                  <dt>最近心跳</dt>
                  <dd>{formatDate(profile.assignedRuntime.lastSeenAt)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </div>
      </details>

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
          <div className={styles.handoffInstructions}>
            <div className="dp-browser-handoff-guide">
              <Keyboard />
              <span>
                点击画面定位输入焦点，可使用键盘、粘贴、点击和滚轮完成登录。
              </span>
            </div>
            {profile.isolatedExecutionAvailable &&
            profile.executionMode !== "ISOLATED_AUTH" ? (
              <label className={styles.concurrentLogin}>
                <input
                  type="checkbox"
                  checked={prepareIsolatedAuth}
                  disabled={busy}
                  onChange={(event) =>
                    setPrepareIsolatedAuth(event.target.checked)
                  }
                />
                <span>
                  <strong>验证并发登录：</strong>使用 4
                  个独立会话检查兼容性。部分站点可能要求重新登录；未勾选时只保存串行登录状态。
                  {profile.snapshotDistributionAvailable &&
                    " 启用后会加密保存认证快照，供兼容的执行节点按需获取；每个节点在执行前再次验证登录。"}
                </span>
              </label>
            ) : null}
          </div>
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

  return overlayHost
    ? createPortal(
        <>
          <div aria-hidden="true" className={styles.handoffBackdrop} />
          {panel}
        </>,
        overlayHost,
      )
    : null;
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
function profileTone(status: string): BadgeTone {
  if (["PREPARING", "VERIFYING"].includes(status)) return "info";
  return status === "READY"
    ? "success"
    : ["REAUTH_REQUIRED", "UNINITIALIZED"].includes(status)
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
