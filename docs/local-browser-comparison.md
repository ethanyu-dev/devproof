# Local browser comparison

Use the current `/v2/tasks` → child Run flow to compare Browser Agent behavior with real model calls and Chromium. The retired `test:verification-smoke` command has been removed; it imported the deleted legacy HITL coordinator and exercised retired writes.

## Task smoke without model calls

Start the local API and its dependencies, then supply a local tool credential with `run:read`, `run:write`, and `run:cancel`:

```bash
pnpm --filter @devproof/api test:task-smoke
```

Set `DEVPROOF_TOOL_TOKEN` in the process environment, or set `DEVPROOF_LOCAL_CREDENTIALS` to a private JSON file containing `toolToken`. Do not put tokens in shell command arguments or commit them. The script loads the checkout's `.env`, accepts only a loopback API, and rejects redirects. It checks Task/Run creation, idempotent retries, conflicting payload rejection, cancellation, and event reads. A unique unsupported browser capability prevents this task from acquiring a browser and calling a model even if a worker is running. Cancelled audit records remain in the database.

## Prepare the comparison

1. Use a dedicated local database, Redis, and MinIO. Apply committed migrations. With all local API and Browser Runtime processes on the current version, set `RUNTIME_SESSION_RECOVERY_ENABLED=true` and `BACKGROUND_WORKERS_ENABLED=true` before starting the API. The recovery flag defaults to false as a mixed-version rollout barrier; leaving it disabled prevents completed tasks from releasing their browser slots. Keep production credentials and browser profiles out of the fixture environment.
2. Configure exactly one approved model in the test team's `BROWSER_EXECUTION` pool. Set `DEVPROOF_COMPARISON_MODEL` to that model ID. Configure no fallback candidates for the comparison.
3. Pair a local Browser Runtime, set its capacity to one, and allow exactly `127.0.0.1` for these fixture pages. Start that Runtime, the API, and optionally Web. Leave other Agent workers stopped; the comparison runner starts and stops its own worker for each mode.
4. Supply a local Agent Runtime credential in `DEVPROOF_AGENT_RUNTIME_TOKEN`. Alternatively, the private credentials JSON can contain `runtimeToken` and `modelId` alongside `toolToken`.
5. Build the current API, Agent Runtime, Browser Runtime, and shared packages before running. The runner executes the built Agent Runtime.

Preview the synthetic pages without a model:

```bash
pnpm test:browser-comparison --fixture-only
```

Stop the preview before starting the comparison; both use port 3311. The API defaults to port 4433 and Web to 3344.

## Run

```bash
pnpm test:browser-comparison
# Narrow the first live pass, or repeat with rotating mode order:
pnpm test:browser-comparison --cases form,broken-form --groups A,B,C
pnpm test:browser-comparison --repeats 3
# Separate functional qualification when a slow model exceeds the normal deadline:
pnpm test:browser-comparison --groups C --cases long-workflow --deadline-seconds 1200
```

| Mode | Context | Tool surface |
| ---- | ------- | ------------ |
| A    | LEGACY  | LEGACY       |
| B    | BOUNDED | LEGACY       |
| C    | BOUNDED | GROUPED      |

All modes retain concise tool-error corrections. A is a baseline for context and tool-surface changes, not a rollback of all three optimizations. Each case uses a new Task, a fresh ephemeral browser session, a single attempt, a ten-minute fixed deadline by default, and no human notifications. `--deadline-seconds` accepts 30–1800 seconds and records the chosen limit in the manifest and each result. Keep deadlines identical for matched comparisons. Runs with a longer deadline are separate functional qualifications and must not replace timed-out rows or enter the original success-rate comparison. The runner waits for browser resource release before changing modes. Run only in a dedicated idle test team so unrelated workers and tasks cannot affect allocation.

The five cases cover a form, an intentionally incorrect total, a popup plus iframe, a large initial page followed by eight checkout steps that need an earlier reservation number, and required network evidence. Fixture server observations check whether the expected actions really occurred. The first requested navigation must match the supplied trial URL; a mistyped trial identifier can load an identical-looking page while exercising the wrong test instance. The incorrect-total case must produce `FAILED`; a blanket `PASSED` response cannot satisfy the suite. This initial suite does not cover human intervention or network fault injection.

Results are written to a new private temporary directory (or `--output PATH`): a manifest, per-case Task/Run IDs, Run details, events, fixture observations, worker logs, and `results.json`. Evidence artifacts remain in the configured local object store. Failed cases remain in the report; they are not silently retried. A different model stops the comparison. Provider, timeout, and cleanup failures must be investigated before treating the measured costs as comparable.

## Interpret results

Compare verdict and criterion correctness first, then request bytes, provider-reported input/output/total tokens, cached input tokens, model calls, browser tool attempts, module enables, observation reads, corrections, and wall time. A missing or incomplete usage report is `null`, not zero. Request byte metrics include tools but are not token estimates. Browser tool attempts include calls rejected before browser dispatch. Input token totals include cached tokens and do not directly measure billed cost.

The automated evidence check verifies that criterion references resolve and required evidence kinds are present. It does not replace inspecting the actual screenshots, DOM, or network artifacts against the criterion. One pass is a smoke comparison, not a reliable success-rate or latency estimate; repeat before drawing performance conclusions.

Check the harness and actual fixture behavior without paying for model calls:

```bash
pnpm test:browser-comparison-unit
pnpm --filter @devproof/browser-runtime test:comparison-fixtures
```

The fixture tests drive real Chromium through all five pages and assert both visible results and server observations. They validate the test cases, not LLM performance.
