import { describe, expect, it } from "vitest";

import { MetricsService } from "./metrics.service.js";

describe("MetricsService", () => {
  it("renders counters, replaceable gauges and cumulative histograms", () => {
    const metrics = new MetricsService();
    metrics.increment("example_total", "Example counter.", { status: "ok" }, 2);
    metrics.setGauge("example_state", "Example state.", 1, { status: "old" });
    metrics.clearGauge("example_state");
    metrics.setGauge("example_state", "Example state.", 3, { status: "new" });
    metrics.observe("example_duration_seconds", "Example duration.", 0.2, {
      operation: "test",
    });

    const output = metrics.render();
    expect(output).toContain('example_total{status="ok"} 2');
    expect(output).toContain('example_state{status="new"} 3');
    expect(output).not.toContain('example_state{status="old"}');
    expect(output).toContain(
      'example_duration_seconds_bucket{operation="test",le="0.25"} 1',
    );
    expect(output).toContain(
      'example_duration_seconds_count{operation="test"} 1',
    );
  });
});
