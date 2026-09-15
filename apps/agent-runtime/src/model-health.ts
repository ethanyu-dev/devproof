import { createHash } from "node:crypto";
import type { RuntimeModelCandidate } from "@devproof/agent-runtime-protocol";
import { MAX_MODEL_ATTEMPTS } from "./model-types.js";

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

  restore(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, entry] of Object.entries(value).slice(-256)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !entry || typeof entry !== "object")
        continue;
      const item = entry as Failure;
      if (
        typeof item.until !== "number" ||
        item.until <= this.now() ||
        item.until > this.now() + 30 * 60_000 ||
        ![
          "MODEL_UNAVAILABLE",
          "CREDENTIAL_UNAVAILABLE",
          "MODEL_TIMEOUT",
        ].includes(item.reason)
      )
        continue;
      if ((this.failures.get(key)?.until ?? 0) < item.until)
        this.failures.set(key, {
          until: item.until,
          reason: item.reason,
          failures: Number(item.failures) || 1,
        });
    }
  }

  success(candidate: RuntimeModelCandidate) {
    this.failures.delete(this.key(candidate));
  }

  /** Admit once per decision; transient cooldowns cannot consume its retries.
   * Exhausted credentials still exclude their aliases immediately.
   */
  *attempts(candidates: RuntimeModelCandidate[]) {
    const admitted = candidates.filter((candidate) =>
      this.available(candidate),
    );
    for (
      let modelAttempt = 1;
      modelAttempt <= MAX_MODEL_ATTEMPTS;
      modelAttempt++
    ) {
      for (const candidate of admitted) {
        if (
          (this.failures.get(this.key(candidate, true))?.until ?? 0) >
            this.now() ||
          (["MODEL_UNAVAILABLE", "MODEL_TIMEOUT"].includes(
            this.failures.get(this.key(candidate))?.reason ?? "",
          ) &&
            !this.available(candidate))
        )
          continue;
        yield { candidate, modelAttempt, maxModelAttempts: MAX_MODEL_ATTEMPTS };
      }
    }
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
    const unavailable =
      [403, 404].includes(status) &&
      /model.*(?:not.*(?:exist|found|available)|access|permission|denied)|(?:unknown|invalid|unsupported|unavailable).*model|model_not_found/iu.test(
        `${code} ${message}`,
      );
    const timeout = /模型响应超过|timed?\s*out|timeout/iu.test(
      `${code} ${message}`,
    );
    const key = this.key(candidate, credential);
    const previous = this.failures.get(key);
    const failures = (previous?.failures ?? 0) + 1;
    const reason = credential
      ? "CREDENTIAL_UNAVAILABLE"
      : unavailable
        ? "MODEL_UNAVAILABLE"
        : timeout
          ? "MODEL_TIMEOUT"
          : status === 429
            ? "RATE_LIMITED"
            : "MODEL_FAILED";
    const cooldownMs = credential
      ? 30 * 60_000
      : unavailable
        ? 30 * 60_000
        : status === 429
          ? 60_000
          : (timeout && previous?.reason === "MODEL_TIMEOUT") ||
              failures >= MAX_MODEL_ATTEMPTS
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
    return {
      reason,
      cooldownMs,
      consecutiveFailures: failures,
      key,
      until: this.now() + cooldownMs,
    };
  }
}
