import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  directTask,
  localApi,
  localCredentials,
} from "./local-browser/api.mjs";
import {
  oraclePassed,
  scenarios,
  startFixtures,
} from "./local-browser/fixtures.mjs";
import {
  browserResourcesReleased,
  evidenceCheck,
  initialNavigationMatches,
  modes,
  summarizeEvents,
} from "./local-browser/metrics.mjs";

const { values } = parseArgs({
  options: {
    "fixture-only": { type: "boolean", default: false },
    groups: { type: "string", default: "A,B,C" },
    cases: {
      type: "string",
      default: scenarios.map((scenario) => scenario.id).join(","),
    },
    repeats: { type: "string", default: "1" },
    "deadline-seconds": { type: "string", default: "600" },
    output: { type: "string" },
  },
});
const deadlineSeconds = Number(values["deadline-seconds"]);
if (
  !Number.isInteger(deadlineSeconds) ||
  deadlineSeconds < 30 ||
  deadlineSeconds > 1_800
)
  throw new Error("deadline-seconds must be an integer from 30 to 1800.");
const fixture = await startFixtures();
console.log(`Local fixtures: ${fixture.url}`);
const root = fileURLToPath(new URL("../", import.meta.url));
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => stop.abort());

if (values["fixture-only"]) {
  await once(stop.signal, "abort");
  await fixture.close();
} else {
  try {
    await compare();
  } finally {
    await fixture.close();
  }
}

async function compare() {
  if (process.env.RUNTIME_SESSION_RECOVERY_ENABLED !== "true") {
    throw new Error(
      "Enable verified session recovery on the current-version local API before comparing modes.",
    );
  }
  const credentials = localCredentials();
  const runtimeToken =
    process.env.DEVPROOF_AGENT_RUNTIME_TOKEN ?? credentials.runtimeToken;
  const modelId = process.env.DEVPROOF_COMPARISON_MODEL ?? credentials.modelId;
  if (!runtimeToken || !modelId)
    throw new Error(
      "Configure a local Runtime credential and DEVPROOF_COMPARISON_MODEL (one approved model) before starting live comparisons.",
    );
  const api = localApi();
  const selectedModes = select(modes, values.groups);
  const selectedScenarios = select(scenarios, values.cases);
  const repeats = Number(values.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10)
    throw new Error("repeats must be 1–10.");
  const active = (await api("/v2/runs")).filter(
    (run) => !terminal(run.lifecycle),
  );
  if (active.length)
    throw new Error("Drain active local Runs before comparing modes.");
  const output = resolve(
    values.output ?? `${tmpdir()}/devproof-comparison-${Date.now()}`,
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  const rows = [];
  const metadata = {
    modelId,
    modes: selectedModes,
    scenarios: selectedScenarios,
    repeats,
    deadlineSeconds,
    startedAt: new Date().toISOString(),
    note: "All modes retain concise corrections. Token totals are null when provider usage is incomplete. Evidence checks verify references and required kinds; inspect saved evidence for semantic correctness.",
  };
  await save("manifest", metadata);
  console.log(`Results: ${output}`);
  // Rotate mode order on repeated passes to reduce a fixed temporal ordering bias.
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const order = [
      ...selectedModes.slice(repeat % selectedModes.length),
      ...selectedModes.slice(0, repeat % selectedModes.length),
    ];
    for (const mode of order) {
      stop.signal.throwIfAborted();
      const log = createWriteStream(
        `${output}/worker-${repeat + 1}-${mode.id}.log`,
        { mode: 0o600 },
      );
      const worker = spawn(
        process.execPath,
        ["apps/agent-runtime/dist/main.js"],
        {
          cwd: root,
          env: {
            ...process.env,
            DEVPROOF_AGENT_RUNTIME_TOKEN: runtimeToken,
            DEVPROOF_AGENT_RUNTIME_POOL: "BROWSER_EXECUTION",
            DEVPROOF_AGENT_WORKER_ID: `comparison-${repeat + 1}-${mode.id}`,
            DEVPROOF_AGENT_CONTEXT_MODE: mode.context,
            DEVPROOF_AGENT_TOOL_SURFACE_MODE: mode.tools,
            DEVPROOF_AGENT_TOOL_LIMIT: "60",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      worker.stdout.pipe(log, { end: false });
      worker.stderr.pipe(log, { end: false });
      const exited = once(worker, "exit");
      try {
        for (const scenario of selectedScenarios) {
          stop.signal.throwIfAborted();
          if (worker.exitCode !== null)
            throw new Error(
              `Worker exited with ${worker.exitCode}; see its log.`,
            );
          const trial = randomUUID();
          let task;
          let cleanupChecked = false;
          try {
            const request = directTask(
              `comparison-${trial}`,
              scenario.goal,
              [
                {
                  id: scenario.id,
                  description: scenario.description,
                  requiredEvidenceKinds: scenario.requiredEvidenceKinds ?? [],
                },
              ],
              { targetUrl: `${fixture.url}/${scenario.id}?trial=${trial}` },
            );
            request.run.deadlineSeconds = deadlineSeconds;
            task = await api("/v2/tasks", request, 202);
            const runId = task.runs[0].runId;
            console.log(`${mode.id} ${scenario.id}: ${task.id}`);
            const deadline = Date.now() + (deadlineSeconds + 60) * 1_000;
            let run;
            do {
              stop.signal.throwIfAborted();
              if (worker.exitCode !== null)
                throw new Error("Worker exited during the comparison.");
              run = await api(`/v2/runs/${runId}`);
              if (run.lifecycle === "WAITING_HUMAN")
                throw new Error(
                  "Unexpected human intervention in a fixture task.",
                );
              if (terminal(run.lifecycle)) break;
              await delay(1_000, undefined, { signal: stop.signal });
            } while (Date.now() < deadline);
            if (!terminal(run.lifecycle))
              throw new Error(
                `Comparison exceeded its ${deadlineSeconds + 60}-second polling limit.`,
              );
            let cleanupError;
            try {
              await waitForCleanup(api, runId);
            } catch (error) {
              cleanupError = error;
            } finally {
              cleanupChecked = true;
            }
            run = await api(`/v2/runs/${runId}`);
            const events = [];
            for (;;) {
              const page = await api(
                `/v2/runs/${runId}/events${events.length ? `?after=${events.at(-1).sequence}` : ""}`,
              );
              events.push(...page);
              if (page.length < 500) break;
            }
            const state = await (
              await fetch(`${fixture.url}/__results?trial=${trial}`)
            ).json();
            const metrics = summarizeEvents(events);
            const evidence = evidenceCheck(run, scenario);
            const modelMatches =
              metrics.models.length === 1 && metrics.models[0] === modelId;
            const row = {
              mode: mode.id,
              scenario: scenario.id,
              repeat: repeat + 1,
              deadlineSeconds,
              taskId: task.id,
              runId,
              lifecycle: run.lifecycle,
              verdict: run.verdict,
              expectedVerdict: scenario.expectedVerdict,
              executionDisposition: run.executionDisposition,
              cleanupComplete: !cleanupError,
              cleanupError: cleanupError?.message ?? null,
              elapsedMs: run.finishedAt
                ? Date.parse(run.finishedAt) - Date.parse(run.createdAt)
                : null,
              fixtureActionsMatch: oraclePassed(scenario.id, state),
              targetUrlMatches: initialNavigationMatches(
                events,
                request.run.environment.targetUrl,
              ),
              modelMatches,
              evidence,
              ...metrics,
            };
            row.checksPassed =
              row.cleanupComplete &&
              row.verdict === row.expectedVerdict &&
              row.fixtureActionsMatch &&
              row.targetUrlMatches &&
              modelMatches &&
              Object.values(evidence).every(Boolean);
            rows.push(row);
            await save(`${repeat + 1}-${mode.id}-${scenario.id}`, {
              row,
              run,
              events,
              fixtureState: state,
            });
            await save("results", rows);
            console.log(JSON.stringify(row));
            if (cleanupError) throw cleanupError;
            if (!modelMatches)
              throw new Error(
                "The model configuration differs from the fixed comparison model. Stop and correct the local configuration.",
              );
          } finally {
            if (task) {
              // A terminal child Run can precede Task reconciliation. Do not
              // turn a completed comparison into a cancelled parent Task.
              const latest = await api(`/v2/runs/${task.runs[0].runId}`);
              if (!terminal(latest.lifecycle))
                await api(`/v2/tasks/${task.id}/cancel`, {});
              if (!cleanupChecked)
                await waitForCleanup(api, task.runs[0].runId);
            }
          }
        }
      } finally {
        if (worker.exitCode === null) worker.kill("SIGTERM");
        const timer = setTimeout(() => worker.kill("SIGKILL"), 15_000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
          log.end();
        }
      }
    }
  }
  if (rows.some((row) => !row.checksPassed)) process.exitCode = 1;
  async function save(name, value) {
    await writeFile(
      `${output}/${name}.json`,
      JSON.stringify(value, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
}

function terminal(lifecycle) {
  return ["COMPLETED", "CANCELLED", "TIMED_OUT"].includes(lifecycle);
}

function select(items, input) {
  const ids = input.split(",");
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !items.some((item) => item.id === id))
  )
    throw new Error(`Invalid selection: ${input}`);
  return ids.map((id) => items.find((item) => item.id === id));
}

async function waitForCleanup(api, runId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const run = await api(`/v2/runs/${runId}`);
    if (browserResourcesReleased(run.browserExecutions)) return;
    await delay(500);
  }
  throw new Error(
    `Browser cleanup is unfinished for ${runId}; do not start the next mode.`,
  );
}
