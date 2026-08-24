"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CircleAlert,
  LoaderCircle,
  Maximize2,
  Minimize2,
  MonitorPlay,
  Radio,
  RotateCcw,
  Square,
} from "lucide-react";
import { Badge, Button } from "@devproof/ui";

import { consoleApi } from "@/lib/api";
import { displayLabel } from "@/lib/display-text";

interface BrowserPreviewStatus {
  ready: boolean;
  runId: string;
  runtimeSession: {
    id: string;
    profileId: string | null;
    profileMode: string;
    runtime: { id: string; name: string; status: string };
    status: string;
  } | null;
  unavailableReason:
    | "NO_SESSION"
    | "PROTOCOL_UNSUPPORTED"
    | "RUNTIME_OFFLINE"
    | "SESSION_UNAVAILABLE"
    | null;
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

const STALE_FRAME_MS = 6_000;

export function VerificationLiveBrowser({ runId }: { runId: string }) {
  const [status, setStatus] = useState<BrowserPreviewStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [streamStatus, setStreamStatus] = useState<
    "idle" | "connecting" | "live" | "interrupted"
  >("idle");
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  const lastFrameAt = useRef(0);

  const loadStatus = useCallback(async () => {
    try {
      setError(null);
      setStatus(
        await consoleApi<BrowserPreviewStatus>(
          `/verifications/${runId}/browser`,
        ),
      );
    } catch (loadError) {
      setError((loadError as Error).message);
    }
  }, [runId]);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 3_000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  useEffect(() => {
    if (!status || status.ready || !enabled) return;
    setEnabled(false);
    setFrame(null);
    setStreamStatus("idle");
  }, [enabled, status]);

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
    if (!enabled) return;
    lastFrameAt.current = Date.now();
    setStreamStatus("connecting");
    const source = new EventSource(
      `/console/api/verifications/${runId}/browser/stream`,
      { withCredentials: true },
    );
    source.onmessage = (message) => {
      const event = parsePreviewEvent(message.data);
      if (event.type === "frame") {
        lastFrameAt.current = Date.now();
        setFrame(event);
        setStreamStatus("live");
        setError(null);
      } else if (event.type === "error") {
        setStreamStatus("interrupted");
        setError(event.error);
      }
    };
    source.onerror = () => {
      setStreamStatus("interrupted");
      setError("实时画面连接中断，正在自动恢复。");
    };
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastFrameAt.current > STALE_FRAME_MS) {
        setStreamStatus("interrupted");
        setError("暂时没有收到新画面，正在等待浏览器执行节点恢复。");
      }
    }, 1_000);
    return () => {
      window.clearInterval(watchdog);
      source.close();
    };
  }, [enabled, runId]);

  function start() {
    setFrame(null);
    setError(null);
    setEnabled(true);
  }

  function stop() {
    setEnabled(false);
    setFrame(null);
    setStreamStatus("idle");
    setError(null);
  }

  const panel = (
    <section className={`dp-live-browser${fullscreen ? " is-fullscreen" : ""}`}>
      <header>
        <span>
          <MonitorPlay />
          <b>浏览器实时画面</b>
        </span>
        <div className="dp-live-browser-actions">
          <Badge tone={streamStatus === "live" ? "success" : "neutral"}>
            {streamLabel(enabled, streamStatus)}
          </Badge>
          {enabled ? (
            <Button onClick={stop} variant="secondary">
              <Square /> 停止画面
            </Button>
          ) : null}
          {frame ? (
            <Button
              aria-label={fullscreen ? "退出全屏预览" : "全屏预览"}
              onClick={() => setFullscreen((current) => !current)}
              variant="secondary"
            >
              {fullscreen ? <Minimize2 /> : <Maximize2 />}
              {fullscreen ? "退出全屏" : "全屏"}
            </Button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="dp-live-browser-error">
          <CircleAlert /> {error}
        </div>
      ) : null}

      {!status ? (
        <div className="dp-live-browser-placeholder">
          <LoaderCircle /> 正在检查浏览器执行节点…
        </div>
      ) : !status.ready ? (
        <div className="dp-live-browser-placeholder">
          <CircleAlert />
          <span>
            <b>{unavailableCopy(status).title}</b>
            <small>{unavailableCopy(status).detail}</small>
          </span>
          <Button onClick={() => void loadStatus()} variant="secondary">
            <RotateCcw /> 重试
          </Button>
        </div>
      ) : !enabled ? (
        <div className="dp-live-browser-start">
          <Radio />
          <span>
            <b>{status.runtimeSession?.runtime.name}</b>
            <small>
              {displayLabel(status.runtimeSession?.status)} ·
              画面默认关闭，不会占用实时流量
            </small>
          </span>
          <Button onClick={start}>
            <MonitorPlay /> 开启实时画面
          </Button>
        </div>
      ) : (
        <div className="dp-live-browser-viewport">
          {frame ? (
            <img
              alt="浏览器执行节点实时画面"
              draggable={false}
              src={`data:image/jpeg;base64,${frame.dataBase64}`}
            />
          ) : (
            <div className="dp-browser-viewport-waiting">
              <LoaderCircle /> 正在连接浏览器执行节点…
            </div>
          )}
          {frame ? (
            <div className="dp-browser-viewport-meta">
              <span>{frame.title || "未命名页面"}</span>
              <small>{frame.url}</small>
            </div>
          ) : null}
          {streamStatus === "interrupted" ? (
            <div className="dp-browser-viewport-blocked">
              <LoaderCircle /> 连接中断，正在自动恢复…
            </div>
          ) : null}
        </div>
      )}

      <footer>
        只读预览 · 每秒更新 · 不会暂停 Agent，也不会向页面发送键盘或鼠标输入
      </footer>
    </section>
  );

  return fullscreen && overlayHost ? createPortal(panel, overlayHost) : panel;
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
    return { error: "实时画面流返回了无效数据。", type: "error" };
  }
}

function streamLabel(
  enabled: boolean,
  status: "idle" | "connecting" | "live" | "interrupted",
) {
  if (!enabled) return "未开启";
  if (status === "live") return "实时";
  if (status === "interrupted") return "恢复中";
  return "连接中";
}

function unavailableCopy(status: BrowserPreviewStatus) {
  if (status.unavailableReason === "NO_SESSION") {
    return {
      detail: "这个验证任务没有关联浏览器执行会话。",
      title: "没有可预览的浏览器画面",
    };
  }
  if (status.unavailableReason === "PROTOCOL_UNSUPPORTED") {
    return {
      detail: "请更新并重启浏览器执行节点后重新发起验证。",
      title: "浏览器执行节点版本不支持实时预览",
    };
  }
  if (status.unavailableReason === "RUNTIME_OFFLINE") {
    return {
      detail: "浏览器执行节点重新上线后可继续查看。",
      title: "浏览器执行节点当前离线",
    };
  }
  return {
    detail: `会话状态为 ${displayLabel(status.runtimeSession?.status ?? "未知")}，实时画面只在任务执行或人工接管期间可用。`,
    title: "浏览器会话已结束",
  };
}
