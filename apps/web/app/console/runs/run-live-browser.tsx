"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CircleAlert, LoaderCircle, MonitorPlay, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { consoleApi } from "@/lib/api";
import { displayLabel, displayMessage } from "@/lib/display-text";
import styles from "./run-live-browser.module.css";

interface BrowserPreviewStatus {
  lifecycle: string;
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

export function RunLiveBrowser({
  fallback,
  runId,
}: {
  fallback?: ReactNode;
  runId: string;
}) {
  const [status, setStatus] = useState<BrowserPreviewStatus | null>(null);
  const [streamStatus, setStreamStatus] = useState<
    "idle" | "connecting" | "live" | "interrupted"
  >("idle");
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function loadStatus() {
      if (loading) return;
      loading = true;
      try {
        const nextStatus = await consoleApi<BrowserPreviewStatus>(
          `/runs/${runId}/browser`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setStatus(nextStatus);
          setStatusError(null);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setStatusError((error as Error).message);
        }
      } finally {
        loading = false;
      }
    }
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 3_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [runId]);

  useEffect(() => {
    setFrame(null);
    setStreamError(null);
    if (!status?.ready || status.lifecycle !== "RUNNING") {
      setStreamStatus("idle");
      return;
    }

    let lastFrameAt = Date.now();
    setStreamStatus("connecting");
    const source = new EventSource(
      `/console/api/runs/${runId}/browser/stream`,
      { withCredentials: true },
    );
    source.onmessage = (message) => {
      const event = parsePreviewEvent(message.data);
      if (event.type === "frame") {
        lastFrameAt = Date.now();
        setFrame(event);
        setStreamStatus("live");
        setStreamError(null);
      } else if (event.type === "error") {
        setStreamStatus("interrupted");
        setStreamError(displayMessage(event.error));
      }
    };
    source.onerror = () => {
      setStreamStatus("interrupted");
      setStreamError("实时画面连接中断，正在自动恢复。");
    };
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastFrameAt > STALE_FRAME_MS) {
        setStreamStatus("interrupted");
        setStreamError("暂时没有收到新画面，正在等待浏览器执行节点恢复。");
      }
    }, 1_000);
    return () => {
      window.clearInterval(watchdog);
      source.onmessage = null;
      source.onerror = null;
      source.close();
    };
  }, [runId, status?.ready, status?.lifecycle, status?.runtimeSession?.id]);

  const liveFrame =
    frame && (streamStatus === "live" || !fallback) ? frame : null;
  const error = streamError ?? statusError;

  return (
    <section className={styles.preview} aria-label="浏览器实时画面">
      <div className="dp-section-head">
        <span>
          <MonitorPlay />
          <b>运行画面</b>
        </span>
        <span className={styles.connection}>
          <small>
            {status?.runtimeSession?.runtime.name ?? "浏览器执行节点"}
          </small>
          <Badge tone={streamStatus === "live" ? "success" : "neutral"}>
            {streamLabel(streamStatus)}
          </Badge>
        </span>
      </div>
      {liveFrame ? (
        <div className={styles.frame}>
          <img
            alt="浏览器执行节点只读实时画面"
            draggable={false}
            src={`data:image/jpeg;base64,${liveFrame.dataBase64}`}
          />
        </div>
      ) : (
        (fallback ?? (
          <div className={styles.frame}>
            <div className={styles.placeholder}>
              {status && !status.ready ? (
                <>
                  <CircleAlert />
                  <span>
                    <b>{unavailableCopy(status).title}</b>
                    <small>{unavailableCopy(status).detail}</small>
                  </span>
                </>
              ) : (
                <>
                  <LoaderCircle className={styles.spinner} />
                  {status
                    ? "正在连接浏览器实时画面…"
                    : "正在检查浏览器执行节点…"}
                </>
              )}
            </div>
          </div>
        ))
      )}
      <footer className={styles.footer}>
        <span>
          <Radio />
          {liveFrame ? "只读实时画面" : "实时画面可用后自动接入"}
        </span>
        {liveFrame?.title ? (
          <small title={liveFrame.title}>{liveFrame.title}</small>
        ) : null}
      </footer>
      {error ? (
        <div className={styles.error} role="status">
          <CircleAlert />
          {error}
        </div>
      ) : null}
    </section>
  );
}

function parsePreviewEvent(
  value: string,
): PreviewFrame | { error: string; type: "error" } {
  try {
    return JSON.parse(value) as PreviewFrame;
  } catch {
    return { error: "实时画面流返回了无效数据。", type: "error" };
  }
}

function streamLabel(status: "idle" | "connecting" | "live" | "interrupted") {
  if (status === "live") return "实时";
  if (status === "interrupted") return "恢复中";
  if (status === "connecting") return "连接中";
  return "等待中";
}

function unavailableCopy(status: BrowserPreviewStatus) {
  if (status.unavailableReason === "NO_SESSION") {
    return {
      detail: "任务运行后会自动接入实时画面。",
      title: "正在等待浏览器会话",
    };
  }
  if (status.unavailableReason === "PROTOCOL_UNSUPPORTED") {
    return {
      detail: "请更新并重启浏览器执行节点后重新发起任务。",
      title: "当前执行节点不支持实时预览",
    };
  }
  if (status.unavailableReason === "RUNTIME_OFFLINE") {
    return {
      detail: "执行节点重新上线后会自动恢复画面。",
      title: "浏览器执行节点当前离线",
    };
  }
  return {
    detail: `会话状态：${displayLabel(status.runtimeSession?.status ?? "未知")}。`,
    title: "浏览器会话暂不可用",
  };
}
