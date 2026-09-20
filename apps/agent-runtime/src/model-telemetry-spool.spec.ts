import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { ModelTelemetrySpool } from "./model-telemetry-spool.js";
describe("model telemetry durable retry", () => {
  it("replays a failed settlement after a process restart with the original identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "devproof-telemetry-"));
    try {
      const input = {
        workerId: "worker",
        leaseToken: randomUUID(),
        telemetry: {
          modelCallId: randomUUID(),
          requestedModel: "model",
          startedAt: new Date().toISOString(),
          durationMs: 10,
          outcome: "SUCCEEDED" as const,
          usage: { prompt_tokens: 12 },
        },
      };
      const failed = vi.fn().mockRejectedValue(new Error("offline"));
      await new ModelTelemetrySpool("namespace", failed, root).settle(input);
      await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
      expect(await readdir(join(root, "namespace"))).toEqual([
        `${input.telemetry.modelCallId}.json`,
      ]);
      const success = vi.fn().mockResolvedValue({ accepted: true });
      await new ModelTelemetrySpool("namespace", success, root).flush();
      expect(success).toHaveBeenCalledWith(input);
      expect(await readdir(join(root, "namespace"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
