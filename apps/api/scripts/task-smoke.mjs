import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { directTask, localApi } from "../../../scripts/local-browser/api.mjs";

const api = localApi();
const request = directTask(
  `task-smoke-${randomUUID()}`,
  "Exercise Task/Run creation, idempotency, and cancellation without a model call.",
  [
    {
      id: "smoke",
      description: "The local task is cancelled before execution.",
    },
  ],
);
// No Runtime implements this per-run capability, so even an online worker
// cannot acquire a browser or invoke a model for this smoke task.
request.run.browserPolicy.requiredCapabilities = [`smoke-only-${randomUUID()}`];
request.run.deadlineSeconds = 60;
let task;
try {
  task = await api("/v2/tasks", request, 202);
  assert.equal(task.kind, "DIRECT_RUN");
  assert.equal(task.runs.length, 1);
  const retried = await api("/v2/tasks", request, 202);
  assert.equal(retried.id, task.id);
  assert.equal(retried.runs[0].runId, task.runs[0].runId);
  await api(
    "/v2/tasks",
    { ...request, run: { ...request.run, goal: "Changed goal" } },
    409,
  );

  const cancelled = await api(`/v2/tasks/${task.id}/cancel`, {});
  assert.equal(cancelled.lifecycle, "CANCELLED");
  const run = await api(`/v2/runs/${task.runs[0].runId}`);
  assert.equal(run.lifecycle, "CANCELLED");
  const events = await api(`/v2/tasks/${task.id}/events`);
  assert.ok(events.length > 0);
  const runEvents = await api(`/v2/runs/${task.runs[0].runId}/events`);
  assert.ok(runEvents.length > 0);
  assert.ok(runEvents.every((event) => /^\d+$/u.test(event.sequence)));
  const next = await api(
    `/v2/runs/${task.runs[0].runId}/events?after=${runEvents.at(-1).sequence}`,
  );
  assert.ok(
    next.every(
      (event) => BigInt(event.sequence) > BigInt(runEvents.at(-1).sequence),
    ),
  );
  const trajectory = await api(`/v2/runs/${task.runs[0].runId}/trajectory`);
  assert.equal(
    trajectory.records.some((row) => row.kind === "MODEL"),
    false,
  );
  console.log(
    JSON.stringify({ status: "passed", taskId: task.id, runId: run.id }),
  );
} finally {
  // Cleanup belongs to the control plane. Keep the cancelled audit records.
  if (task) await api(`/v2/tasks/${task.id}/cancel`, {});
}
