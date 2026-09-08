export const modes = [
  { id: "A", context: "LEGACY", tools: "LEGACY" },
  { id: "B", context: "BOUNDED", tools: "LEGACY" },
  { id: "C", context: "BOUNDED", tools: "GROUPED" },
];

export function browserResourcesReleased(executions) {
  return executions.every(
    (execution) =>
      execution.status === "RELEASED" ||
      (["FAILED", "TIMED_OUT"].includes(execution.status) &&
        !execution.runtimeSessionId),
  );
}

export function initialNavigationMatches(events, targetUrl) {
  const navigation = events.find(
    (event) =>
      event.kind === "executor.navigation.started" ||
      (event.kind === "agent.tool.started" &&
        event.payload.name === "browser_command" &&
        ["page.navigate", "page.open"].includes(
          event.payload.inputPreview?.commandType,
        )),
  );
  try {
    return (
      new URL(
        navigation?.payload.command?.payload?.url ??
          navigation?.payload.inputPreview?.payload?.url,
      ).href === new URL(targetUrl).href
    );
  } catch {
    return false;
  }
}

export function summarizeEvents(events) {
  const started = events.filter(
    (event) => event.kind === "agent.model.started",
  );
  const completed = events.filter(
    (event) => event.kind === "agent.model.completed",
  );
  const tools = events.filter((event) => event.kind === "agent.tool.started");
  const finishedTools = events.filter(
    (event) => event.kind === "agent.tool.completed",
  );
  const modelFinished = events.filter((event) =>
    ["agent.model.completed", "agent.model.failed"].includes(event.kind),
  );
  const navigationCalls = events.filter(
    (event) => event.kind === "executor.navigation.started",
  ).length;
  const modelBrowserCalls = tools.filter(
    (event) => event.payload.name === "browser_command",
  ).length;
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const completeSum = (values) =>
    values.length && values.every(Number.isFinite) ? sum(values) : null;
  const usageComplete =
    started.length > 0 && started.length === completed.length;
  const transportComplete =
    started.length > 0 &&
    started.length === modelFinished.length &&
    modelFinished.every(
      (event) =>
        event.payload.inputPreview?.transport?.attempts?.length > 0 &&
        event.payload.inputPreview.transport.attempts.every(
          (attempt) => attempt.outcome !== "RUNNING",
        ),
    );
  const tokenTotal = (key) =>
    usageComplete
      ? completeSum(completed.map((event) => event.payload.usage?.[key]))
      : null;
  return {
    modelCalls: started.length,
    modelFailures: events.filter((event) => event.kind === "agent.model.failed")
      .length,
    modelDurationMs:
      started.length === modelFinished.length
        ? completeSum(modelFinished.map((event) => event.payload.durationMs))
        : null,
    modelHttpAttempts: transportComplete
      ? sum(
          modelFinished.map(
            (event) => event.payload.inputPreview.transport.attemptCount,
          ),
        )
      : null,
    modelRetries: transportComplete
      ? sum(
          modelFinished.map(
            (event) => event.payload.inputPreview.transport.retryCount,
          ),
        )
      : null,
    modelHttpDurationMs: transportComplete
      ? completeSum(
          modelFinished.flatMap((event) =>
            event.payload.inputPreview.transport.attempts.map(
              (attempt) => attempt.durationMs,
            ),
          ),
        )
      : null,
    models: [...new Set(started.map((event) => event.payload.model))],
    requestBytes: completeSum(
      started.map((event) => event.payload.inputPreview?.context?.requestBytes),
    ),
    firstToolSchemaBytes:
      started[0]?.payload.inputPreview?.context?.toolSchemaBytes ?? null,
    inputTokens: tokenTotal("input_tokens"),
    cachedInputTokens: usageComplete
      ? completeSum(
          completed.map(
            (event) => event.payload.usage?.input_tokens_details?.cached_tokens,
          ),
        )
      : null,
    outputTokens: tokenTotal("output_tokens"),
    totalTokens: tokenTotal("total_tokens"),
    toolCalls: tools.length,
    browserToolCalls: modelBrowserCalls + navigationCalls,
    modelBrowserToolCalls: modelBrowserCalls,
    runtimeNavigationCalls: navigationCalls,
    enableCalls: tools.filter(
      (event) => event.payload.name === "enable_browser_tools",
    ).length,
    observationReads: tools.filter(
      (event) => event.payload.name === "read_observation",
    ).length,
    correctionCount: finishedTools.filter(
      (event) => event.payload.outputPreview?.correctionBytes > 0,
    ).length,
  };
}

export function evidenceCheck(run, scenario) {
  const criterion = run.criterionResults.find(
    (result) => result.criterionId === scenario.id,
  );
  const refs = new Set(run.evidences.map((evidence) => evidence.externalId));
  const referencesResolve =
    Boolean(criterion?.evidenceRefs.length) &&
    criterion.evidenceRefs.every((ref) => refs.has(ref));
  const kindsPresent = (scenario.requiredEvidenceKinds ?? []).every((kind) =>
    run.evidences.some(
      (evidence) =>
        evidence.kind === kind &&
        criterion?.evidenceRefs.includes(evidence.externalId),
    ),
  );
  return {
    criterionMatches: criterion?.status === scenario.expectedVerdict,
    referencesResolve,
    kindsPresent,
  };
}
