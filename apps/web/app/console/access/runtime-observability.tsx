import {
  RUNTIME_TELEMETRY_MINOR,
  RUNTIME_TELEMETRY_STALE_MS,
  type RuntimeTelemetrySnapshot,
} from "@devproof/runtime-protocol";
import styles from "./runtime-observability.module.css";

export interface RuntimeCapacity {
  available: number;
  configured: number;
  draining: number;
  occupied: number;
  online: boolean;
  runtimeWaiting?: number;
  quarantined?: number;
}

export function telemetryState(
  status: string,
  protocolMinor: number | null,
  telemetry: RuntimeTelemetrySnapshot | null | undefined,
  now: number,
) {
  if (status !== "ONLINE") return "OFFLINE";
  if ((protocolMinor ?? 0) < RUNTIME_TELEMETRY_MINOR) return "UNSUPPORTED";
  if (!telemetry) return "MISSING";
  const age = now - Date.parse(telemetry.receivedAt);
  return Number.isFinite(age) && age < RUNTIME_TELEMETRY_STALE_MS
    ? "LIVE"
    : "STALE";
}

function bytes(value: number) {
  const gib = value / 1024 ** 3;
  return gib >= 1
    ? `${gib.toFixed(1)} GiB`
    : `${Math.round(value / 1024 ** 2)} MiB`;
}

function Gauge({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | null;
  detail: string;
}) {
  return (
    <div className={styles.metric}>
      <div>
        <span>{label}</span>
        <strong>{value === null ? "采样中" : `${value.toFixed(1)}%`}</strong>
      </div>
      <div
        className={styles.track}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value ?? undefined}
        aria-valuetext={
          value === null ? "等待第二次采样" : `${value.toFixed(1)}%`
        }
      >
        <span
          className={
            value !== null && value >= 85 ? styles.high : styles.normal
          }
          style={{ width: `${value ?? 0}%` }}
        />
      </div>
      <small>{detail}</small>
    </div>
  );
}

const unavailable = {
  OFFLINE: "节点未在线，暂无实时资源数据。",
  UNSUPPORTED: "升级并重启此节点后可查看 CPU 和内存（协议 v1.18+）。",
  MISSING: "尚未收到资源采样，或最近采样已过期。",
  STALE: "资源采样已过期，等待节点重新上报。",
};

export function RuntimeObservability({
  status,
  protocolMinor,
  telemetry,
  capacity,
  now,
}: {
  status: string;
  protocolMinor: number | null;
  telemetry?: RuntimeTelemetrySnapshot | null | undefined;
  capacity?: RuntimeCapacity | undefined;
  now: number;
}) {
  const state = telemetryState(status, protocolMinor, telemetry, now);
  const metrics = state === "LIVE" ? telemetry?.metrics : null;
  const slots =
    capacity &&
    Array.from(
      { length: Math.max(capacity.configured, capacity.occupied) },
      (_, index) => {
        if (index < Math.min(capacity.quarantined ?? 0, capacity.occupied))
          return "隔离";
        if (index < capacity.occupied) return "占用";
        return capacity.online ? "空闲" : "离线";
      },
    );
  const high =
    metrics &&
    ((metrics.cpu.usagePercent ?? 0) >= 85 ||
      metrics.memory.usagePercent >= 85);
  return (
    <section className={styles.panel} aria-label="节点资源与并发池">
      <div className={styles.heading}>
        <strong>机器资源</strong>
        <small title="包含 Chromium 和其他进程；容器资源配额可能低于整机容量。">
          整机口径
        </small>
      </div>
      {metrics ? (
        <>
          <div className={styles.metrics}>
            <Gauge
              label="CPU"
              value={metrics.cpu.usagePercent}
              detail={`${metrics.cpu.logicalCores} 个逻辑核 · 区间平均`}
            />
            <Gauge
              label="内存"
              value={metrics.memory.usagePercent}
              detail={`${bytes(metrics.memory.usedBytes)} / ${bytes(metrics.memory.totalBytes)}`}
            />
          </div>
          <p className={styles.note}>
            可用内存 {bytes(metrics.memory.availableBytes)} · Runtime 进程{" "}
            {bytes(metrics.process.rssBytes)}
            <br />
            {metrics.memory.availableSource === "MEM_AVAILABLE"
              ? "可用内存包含可回收缓存"
              : "可用内存采用系统空闲内存口径"}
          </p>
          <small className={styles.note}>
            最近上报{" "}
            {new Date(telemetry!.receivedAt).toLocaleTimeString("zh-CN")} · 每
            15 秒采样
          </small>
        </>
      ) : (
        <p className={styles.note}>
          {unavailable[state as keyof typeof unavailable]}
        </p>
      )}
      {capacity ? (
        <>
          <div className={styles.heading}>
            <strong>并发槽位池</strong>
            <span>
              {capacity.occupied} / {capacity.configured} 占用
            </span>
          </div>
          <div
            className={styles.slots}
            aria-label={`占用 ${capacity.occupied}，空闲 ${capacity.available}，隔离 ${capacity.quarantined ?? 0}（包含在占用内）`}
          >
            {slots?.map((slot, index) => (
              <span
                key={index}
                title={`${slot}（池容量示意）`}
                data-state={slot}
              />
            ))}
          </div>
          <div className={styles.counts}>
            <span>
              空闲 <b>{capacity.available}</b>
            </span>
            <span>
              槽位等待 <b>{capacity.runtimeWaiting ?? "—"}</b>
            </span>
            <span>
              隔离 <b>{capacity.quarantined ?? 0}</b>
            </span>
            {capacity.draining > 0 ? (
              <span>
                缩容待释放 <b>{capacity.draining}</b>
              </span>
            ) : null}
          </div>
          <p className={styles.note}>
            占用含准备、执行、人工接管及隔离；等待中的任务不占槽位。
          </p>
        </>
      ) : null}
      {high ? (
        <p className={styles.warning}>
          当前资源使用率较高，建议先观察持续负载，再调整并发。
        </p>
      ) : metrics &&
        metrics.cpu.usagePercent !== null &&
        capacity?.online &&
        capacity.available === 0 &&
        (capacity.runtimeWaiting ?? 0) > 0 &&
        !capacity.quarantined ? (
        <p className={styles.note}>
          槽位已满且有排队，可小幅增加并发并观察资源变化。
        </p>
      ) : null}
    </section>
  );
}
