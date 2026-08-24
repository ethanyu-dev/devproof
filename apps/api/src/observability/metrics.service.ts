import { Injectable } from "@nestjs/common";

type Labels = Record<string, string | number | boolean>;

interface MetricSeries {
  help: string;
  labels: Record<string, string>;
  name: string;
}

interface HistogramSeries extends MetricSeries {
  buckets: number[];
  counts: number[];
  count: number;
  sum: number;
}

const DEFAULT_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
];

function normalizedLabels(labels: Labels): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value)]),
  );
}

function seriesKey(name: string, labels: Record<string, string>) {
  return `${name}:${JSON.stringify(labels)}`;
}

function escapeLabel(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function renderedLabels(labels: Record<string, string>) {
  const entries = Object.entries(labels);
  return entries.length === 0
    ? ""
    : `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

@Injectable()
export class MetricsService {
  private readonly counters = new Map<
    string,
    MetricSeries & { value: number }
  >();
  private readonly gauges = new Map<string, MetricSeries & { value: number }>();
  private readonly histograms = new Map<string, HistogramSeries>();

  increment(name: string, help: string, labels: Labels = {}, value = 1) {
    const normalized = normalizedLabels(labels);
    const key = seriesKey(name, normalized);
    const current = this.counters.get(key);
    if (current) current.value += value;
    else this.counters.set(key, { help, labels: normalized, name, value });
  }

  setGauge(name: string, help: string, value: number, labels: Labels = {}) {
    const normalized = normalizedLabels(labels);
    this.gauges.set(seriesKey(name, normalized), {
      help,
      labels: normalized,
      name,
      value,
    });
  }

  clearGauge(name: string) {
    for (const [key, series] of this.gauges) {
      if (series.name === name) this.gauges.delete(key);
    }
  }

  observe(
    name: string,
    help: string,
    value: number,
    labels: Labels = {},
    buckets = DEFAULT_BUCKETS,
  ) {
    const normalized = normalizedLabels(labels);
    const key = seriesKey(name, normalized);
    let series = this.histograms.get(key);
    if (!series) {
      series = {
        buckets: [...buckets],
        count: 0,
        counts: buckets.map(() => 0),
        help,
        labels: normalized,
        name,
        sum: 0,
      };
      this.histograms.set(key, series);
    }
    series.count += 1;
    series.sum += value;
    series.buckets.forEach((bucket, index) => {
      if (value <= bucket) series!.counts[index]! += 1;
    });
  }

  render() {
    this.setGauge(
      "devproof_process_uptime_seconds",
      "Process uptime in seconds.",
      process.uptime(),
    );
    const memory = process.memoryUsage();
    this.setGauge(
      "devproof_process_resident_memory_bytes",
      "Resident memory size in bytes.",
      memory.rss,
    );
    this.setGauge(
      "devproof_process_heap_used_bytes",
      "Used JavaScript heap in bytes.",
      memory.heapUsed,
    );

    const lines: string[] = [];
    this.renderSimple(lines, "counter", this.counters);
    this.renderSimple(lines, "gauge", this.gauges);

    const histogramGroups = new Map<string, HistogramSeries[]>();
    for (const series of this.histograms.values()) {
      const group = histogramGroups.get(series.name) ?? [];
      group.push(series);
      histogramGroups.set(series.name, group);
    }
    for (const [name, group] of [...histogramGroups].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      lines.push(`# HELP ${name} ${group[0]!.help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const series of group) {
        series.buckets.forEach((bucket, index) => {
          lines.push(
            `${name}_bucket${renderedLabels({ ...series.labels, le: String(bucket) })} ${series.counts[index]}`,
          );
        });
        lines.push(
          `${name}_bucket${renderedLabels({ ...series.labels, le: "+Inf" })} ${series.count}`,
        );
        lines.push(`${name}_sum${renderedLabels(series.labels)} ${series.sum}`);
        lines.push(
          `${name}_count${renderedLabels(series.labels)} ${series.count}`,
        );
      }
    }
    return `${lines.join("\n")}\n`;
  }

  private renderSimple(
    lines: string[],
    type: "counter" | "gauge",
    values: Map<string, MetricSeries & { value: number }>,
  ) {
    const groups = new Map<string, Array<MetricSeries & { value: number }>>();
    for (const series of values.values()) {
      const group = groups.get(series.name) ?? [];
      group.push(series);
      groups.set(series.name, group);
    }
    for (const [name, group] of [...groups].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      lines.push(`# HELP ${name} ${group[0]!.help}`);
      lines.push(`# TYPE ${name} ${type}`);
      for (const series of group) {
        lines.push(`${name}${renderedLabels(series.labels)} ${series.value}`);
      }
    }
  }
}
