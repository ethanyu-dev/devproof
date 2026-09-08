import assert from "node:assert/strict";
import { test } from "node:test";

import { localUrl } from "./api.mjs";
import { oraclePassed } from "./fixtures.mjs";
import {
  browserResourcesReleased,
  evidenceCheck,
  initialNavigationMatches,
  summarizeEvents,
} from "./metrics.mjs";

test("runtime navigation is included in URL checks and browser totals", () => {
  const expected = "https://fixture.example/form?trial=exact";
  const events = [
    {
      kind: "executor.navigation.started",
      payload: {
        command: { commandType: "page.navigate", payload: { url: expected } },
      },
    },
  ];
  assert.equal(initialNavigationMatches(events, expected), true);
  assert.equal(initialNavigationMatches(events, expected + "-wrong"), false);
  assert.equal(summarizeEvents(events).browserToolCalls, 1);
  assert.equal(summarizeEvents(events).modelBrowserToolCalls, 0);
  assert.equal(summarizeEvents(events).runtimeNavigationCalls, 1);
});

test("retry metrics require complete transport observations, including failed requests", () => {
  const start = { kind: "agent.model.started", payload: {} };
  const end = {
    kind: "agent.model.failed",
    payload: {
      durationMs: 100,
      inputPreview: {
        transport: {
          attemptCount: 2,
          retryCount: 1,
          attempts: [
            { durationMs: 20, outcome: "RESPONSE", status: 429 },
            { durationMs: 30, outcome: "ERROR", status: null },
          ],
        },
      },
    },
  };
  const metrics = summarizeEvents([start, end]);
  assert.equal(metrics.modelRetries, 1);
  assert.equal(metrics.modelHttpAttempts, 2);
  assert.equal(metrics.modelDurationMs, 100);
  assert.equal(metrics.modelHttpDurationMs, 50);
  assert.equal(summarizeEvents([start]).modelRetries, null);
  assert.equal(
    summarizeEvents([start, { kind: "agent.model.completed", payload: {} }])
      .modelHttpAttempts,
    null,
  );
  end.payload.inputPreview.transport.attempts[1].outcome = "RUNNING";
  assert.equal(summarizeEvents([start, end]).modelHttpDurationMs, null);
});

test("incomplete provider usage stays unknown instead of appearing as a token saving", () => {
  const started = {
    kind: "agent.model.started",
    payload: {
      model: "fixed",
      inputPreview: { context: { requestBytes: 100 } },
    },
  };
  const completed = {
    kind: "agent.model.completed",
    payload: {
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    },
  };
  assert.equal(summarizeEvents([started, completed]).totalTokens, 13);
  assert.equal(
    summarizeEvents([started, completed, started]).totalTokens,
    null,
  );
  assert.equal(
    summarizeEvents([started, { kind: "agent.model.completed", payload: {} }])
      .totalTokens,
    null,
  );
  assert.equal(
    summarizeEvents([started, completed, started]).requestBytes,
    200,
  );
});

test("an expected failed verdict needs matching criterion evidence, not only a matching run label", () => {
  const scenario = {
    id: "broken-form",
    expectedVerdict: "FAILED",
    requiredEvidenceKinds: ["DOM"],
  };
  const run = {
    evidences: [{ externalId: "dom-1", kind: "DOM" }],
    criterionResults: [
      {
        criterionId: "broken-form",
        status: "FAILED",
        evidenceRefs: ["missing"],
      },
    ],
  };
  assert.equal(evidenceCheck(run, scenario).referencesResolve, false);
  assert.equal(evidenceCheck(run, scenario).kindsPresent, false);
  run.criterionResults[0].evidenceRefs = ["dom-1"];
  assert.ok(Object.values(evidenceCheck(run, scenario)).every(Boolean));
});

test("the fixture oracle rejects skipped steps, duplicate writes, and unexercised regressions", () => {
  assert.equal(oraclePassed("broken-form", { actions: [] }), false);
  const order = {
    kind: "order",
    name: "Ada",
    quantity: 2,
    newsletter: true,
    total: 42,
  };
  assert.equal(oraclePassed("form", { actions: [order, order] }), false);
  assert.equal(
    oraclePassed("long-workflow", {
      actions: [{ kind: "reservation", accepted: true }],
    }),
    false,
  );
});

test("mode switches wait for release, including failed executions that still own a session", () => {
  assert.equal(
    browserResourcesReleased([
      { status: "RELEASED", runtimeSessionId: "session" },
    ]),
    true,
  );
  assert.equal(
    browserResourcesReleased([{ status: "FAILED", runtimeSessionId: null }]),
    true,
  );
  for (const status of ["RELEASING", "LOST", "FAILED", "TIMED_OUT"]) {
    assert.equal(
      browserResourcesReleased([{ status, runtimeSessionId: "session" }]),
      false,
    );
  }
});

test("the initial navigation must preserve the trial URL even when a different trial looks correct", () => {
  const expected = "http://127.0.0.1:3311/broken-form?trial=expected";
  const event = {
    kind: "agent.tool.started",
    payload: {
      name: "browser_command",
      inputPreview: {
        commandType: "page.navigate",
        payload: { url: expected },
      },
    },
  };
  assert.equal(initialNavigationMatches([event], expected), true);
  const wrongTrial = structuredClone(event);
  wrongTrial.payload.inputPreview.payload.url = expected.replace(
    "trial=expected",
    "trial=typo",
  );
  assert.equal(initialNavigationMatches([wrongTrial, event], expected), false);
  assert.equal(initialNavigationMatches([], expected), false);
});

test("the local API client rejects external and credential-bearing URLs", () => {
  assert.equal(localUrl("http://localhost:4433").hostname, "localhost");
  for (const url of [
    "https://example.com",
    "http://localhost.example.com",
    "http://secret@localhost",
    "file:///tmp/test",
  ]) {
    assert.throws(() => localUrl(url));
  }
});
