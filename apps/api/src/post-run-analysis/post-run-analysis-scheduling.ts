import { env } from "../config/env.js";

const MAX_RETRY_BACKOFF_SECONDS = 60 * 60;

export function postRunAnalysisHardDeadline(now = new Date()) {
  return new Date(
    now.getTime() + env().POST_RUN_ANALYSIS_HARD_DEADLINE_SECONDS * 1_000,
  );
}

export function postRunAnalysisAttemptDeadline(
  hardDeadlineAt: Date,
  now = new Date(),
) {
  return new Date(
    Math.min(
      hardDeadlineAt.getTime(),
      now.getTime() + env().POST_RUN_ANALYSIS_DEADLINE_SECONDS * 1_000,
    ),
  );
}

export function postRunAnalysisRetryAt(
  attemptNumber: number,
  now = new Date(),
) {
  const delaySeconds = Math.min(
    MAX_RETRY_BACKOFF_SECONDS,
    env().POST_RUN_ANALYSIS_RETRY_BACKOFF_SECONDS *
      2 ** Math.max(0, attemptNumber - 1),
  );
  return new Date(now.getTime() + delaySeconds * 1_000);
}
