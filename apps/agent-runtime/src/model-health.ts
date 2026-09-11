import { createHash } from "node:crypto";
import type { RuntimeModelCandidate } from "@devproof/agent-runtime-protocol";

type Failure = { until: number; failures: number; reason: string };

/** Shared by concurrent runs on this executor; keys never expose credentials. */
export class ModelHealth {
  private readonly failures = new Map<string, Failure>();
  constructor(private readonly now = () => Date.now()) {}

  private key(candidate: RuntimeModelCandidate, credential = false) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          candidate.baseUrl,
          candidate.apiKey,
          credential ? null : candidate.modelId,
        ]),
      )
      .digest("hex");
  }

  available(candidate: RuntimeModelCandidate) {
    return [this.key(candidate), this.key(candidate, true)].every(
      (key) => (this.failures.get(key)?.until ?? 0) <= this.now(),
    );
  }

  success(candidate: RuntimeModelCandidate) {
    this.failures.delete(this.key(candidate));
  }

  failure(candidate: RuntimeModelCandidate, error: unknown) {
    const value =
      error && typeof error === "object"
        ? (error as Record<string, unknown>)
        : {};
    const message = error instanceof Error ? error.message : String(error);
    const code = String(value.code ?? "");
    const status = Number(value.status);
    const credential =
      [401, 402].includes(status) ||
      /insufficient[_ ](?:user[_ ])?(?:quota|funds|balance)|credit balance|balance.*(?:insufficient|low)|余额不足/iu.test(
        `${code} ${message}`,
      );
    const key = this.key(candidate, credential);
    const previous = this.failures.get(key);
    const failures = (previous?.failures ?? 0) + 1;
    const reason = credential
      ? "CREDENTIAL_UNAVAILABLE"
      : status === 429
        ? "RATE_LIMITED"
        : "MODEL_FAILED";
    const cooldownMs = credential
      ? 30 * 60_000
      : status === 429
        ? 60_000
        : failures >= 2
          ? 5 * 60_000
          : 0;
    this.failures.set(key, {
      failures,
      reason,
      until: this.now() + cooldownMs,
    });
    // Configuration changes create new keys; bound old failures in long-lived workers.
    while (this.failures.size > 256)
      this.failures.delete(this.failures.keys().next().value!);
    return { reason, cooldownMs, consecutiveFailures: failures };
  }
}
