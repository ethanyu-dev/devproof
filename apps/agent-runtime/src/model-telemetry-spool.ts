import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { modelCallSettlementSchema } from "@devproof/agent-runtime-protocol";
import type { z } from "zod";

type Settlement = z.infer<typeof modelCallSettlementSchema>;
/** Contains numeric telemetry and an expiring lease identity, never model/API credentials. */
export class ModelTelemetrySpool {
  private flushing = false;
  constructor(
    private readonly namespace: string,
    private readonly send: (input: Settlement) => Promise<unknown>,
    private readonly root = process.env.DEVPROOF_AGENT_TELEMETRY_DIR ??
      join(homedir(), ".devproof", "model-telemetry"),
  ) {}
  private get directory() {
    return join(this.root, this.namespace);
  }
  async settle(input: Settlement) {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const entries = await readdir(this.directory);
      if (entries.length >= 2000)
        throw new Error("Model telemetry spool capacity reached.");
      const path = join(this.directory, `${input.telemetry.modelCallId}.json`);
      await writeFile(`${path}.tmp`, JSON.stringify(input), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      // Only the local durable write is on the model critical path.
      void this.flush();
    } catch {
      // Persistence failure must not turn a successful provider request into a model retry.
      console.error("runtime.model_telemetry.persistence_failed");
      try {
        await this.send(input);
      } catch {
        console.error("runtime.model_telemetry.unavailable");
      }
    }
  }
  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const entries = await readdir(this.directory).catch(() => []);
      for (const name of entries
        .filter((n) => n.endsWith(".json"))
        .slice(0, 20)) {
        const path = join(this.directory, name);
        try {
          const input = modelCallSettlementSchema.parse(
            JSON.parse(await readFile(path, "utf8")),
          );
          if (Date.now() - Date.parse(input.telemetry.startedAt) > 86400000) {
            console.error("runtime.model_telemetry.expired");
            await unlink(path);
            continue;
          }
          await this.send(input);
          await unlink(path);
        } catch {
          /* Retain until the replay window expires. */
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
