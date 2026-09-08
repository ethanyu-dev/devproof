# Design 3: concise, command-specific tool corrections

Date: 2026-09-08. Status: implemented and regression-tested; not deployed or evaluated with live model tasks. Scope: Browser Verification Agent argument corrections.

## Problem and alternatives

The executor returns `parsed.error.message` directly to the model. Parsing an unknown command through the 39-variant union produces errors for unrelated commands. The local `{commandType: "page.content", payload: {}}` example produces 26,419 characters and is retained in subsequent history.

| Option          | Design                                                                          | Benefit                                   | Limitation                                                             |
| --------------- | ------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| A               | Truncate the existing Zod message                                               | Immediate size ceiling                    | May retain irrelevant branches and cut off the useful correction       |
| B — recommended | Select the command first, validate its payload, and format a bounded correction | Relevant errors with canonical validation | Requires a registry and explicit formatting of a few issue types       |
| C               | Automatically rewrite invalid arguments or ask another LLM to fix them          | Can eliminate a correction round          | May change action intent or repeat writes; adds another inference path |

Use a final size ceiling as a guard inside B, not as the primary design. Do not automatically execute corrected navigation, input, or click calls.

## Validation pipeline

1. Parse JSON and require an object. Return `INVALID_JSON` or `INVALID_ARGUMENTS` without echoing submitted content.
2. Read `commandType`. If absent, return its exact path and expected type. If unknown, return `UNKNOWN_COMMAND` and at most two catalog-backed suggestions.
3. The [tool-module layer](agent-tool-surface-design.md) rejects platform-owned lifecycle/control commands with `COMMAND_NOT_ALLOWED`. In grouped mode it gates inactive commands with `TOOL_GROUP_REQUIRED` and `requiredGroup` before payload parsing, and redirects the `page.open` alias to `page.navigate`. Group and alias checks are a no-op under the legacy full catalog.
4. Resolve the canonical command validator from a named registry derived from existing protocol variants. Validate the complete command, including strict properties, defaults, `timeoutSeconds`, and cross-field constraints.
5. Validate the executor-owned `locatorRecoveryToken` with its existing rules. Run recovery handling only after validation, exactly as today.
6. On success, forward the parsed command to the existing control plane. On failure, return one concise correction; no browser request has occurred.

The aggregate public protocol schema need not change. A registry export may be added while preserving existing command validators. Validate behavioral equivalence for strict extra fields, URL rules, locator alternatives, timeout limits, and the network response-body filter requirement.

## Model-facing correction format

Retain the existing string `error` field so current rejection/progress checks keep working, and add bounded structured guidance:

```json
{
  "accepted": false,
  "code": "UNKNOWN_COMMAND",
  "error": "未知浏览器命令。",
  "issues": [{ "path": "commandType", "expected": "已公布的浏览器命令" }],
  "suggestions": ["page.get_text", "page.dom"],
  "nextAction": "读取可见文本使用 page.get_text；获取 HTML 证据使用 page.dom。",
  "retryable": true
}
```

`retryable` means the model may submit a corrected call, not that the previous action should be repeated automatically. Messages shown to the model remain concise Chinese; command names, paths, enums, and evidence IDs retain their original spelling.

| Error case                 | Useful feedback                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| Malformed JSON             | Request valid JSON; do not echo the malformed string                                       |
| Unknown command            | The safe command name, up to two known alternatives, and their different uses              |
| Invalid locator ref        | `payload.target.ref`; preserve a complete ref from the latest snapshot                     |
| Missing click target       | The valid alternatives: `payload.target` or `payload.point`; no unrelated command variants |
| Missing network filter     | `payload.urlIncludes` is required when response bodies are requested                       |
| Unexpected field           | At most three sanitized field paths; no submitted values                                   |
| Invalid criterion evidence | The affected criterion and bounded reference details; keep the evidence gate               |

For a union inside one command, report the few relevant alternatives rather than choosing an arbitrary branch as truth. Suggestions must come from a small explicit alias map or deterministic catalog match; never invent a replacement command or a page ref. Unknown free-form names and paths must be sanitized and capped before rendering.

## Output limits and error boundaries

Proposed caps: at most three issues, two suggestions, and 2 KiB of serialized UTF-8 JSON per parameter correction. Bound each message and path before serializing; if still oversized, remove optional guidance and return a complete minimal JSON object. Do not truncate serialized JSON into invalid syntax.

Use the same formatter for local validation of `record_criterion`, `request_human_input`, and `finish_verification`, while preserving their semantic checks and Chinese-text requirements. Invalid calls continue consuming the existing tool-call budget and do not increment successful browser-command counts.

Keep these categories separate:

- Invalid model arguments: correct the call; no browser side effect occurred.
- Locator ambiguity or missing elements: retain current snapshot/recovery behavior and attempt limits.
- Runtime/network/lease errors: preserve the existing control-plane failure classification and execution disposition.
- Product assertion failures: derive only from actual observed evidence, never from parameter errors.

Do not replace existing browser failure envelopes wholesale with the validation format. Large locator snapshots are addressed by the context design; raw transport errors are not reclassified as invalid arguments.

For diagnostics, record the issue code, sanitized paths, canonical command name if known, and pre/post-format byte counts through existing events. Do not introduce logging of raw credentials or claim that current trace previews retain full validation errors. If a bounded redacted diagnostic is needed, store it outside the model response using the existing observability path.

## Acceptance and rollback

Regression tests should cover malformed JSON, unknown/absent/non-string command types, nested locator alternatives, extra keys, URL restrictions, timeout limits, missing `urlIncludes`, inactive tool groups, and strings containing credential-like values. The `page.content` fixture must yield valid JSON within 2 KiB containing only relevant alternatives and must never call the control plane.

Keep a corpus of valid commands and assert identical canonical parsed payloads before/after registry dispatch, including defaults and refinements. Preserve existing evidence, recovery, cancellation, and final-verdict tests. Target successful correction on the next model turn in task evaluations, but do not encode live model success as a deterministic guarantee.

This is the first recommended implementation because it is local and independently testable. It works before either context compaction or optional tools exist. Rollback restores the old model-facing formatter for new segments; the shared canonical validators and wire protocol remain unchanged.

## Implementation record

- `getRuntimeActionCommandSchema` selects an existing canonical action validator. This correction change initially retained the complete advertised schema. The separate tool-module change selects which variants to advertise; the Browser Runtime wire protocol remains unchanged.
- `apps/agent-runtime/src/tool-correction.ts` produces bounded JSON corrections for malformed arguments, unknown commands/tools, command-specific validation, and the other verification tools. Unknown command names, submitted values, and unexpected key names are not echoed.
- Corrections retain `accepted: false` and string `error`, include at most three issues and two known-command suggestions, and never exceed 2,048 serialized UTF-8 bytes. Invalid calls do not issue browser commands or count as browser execution; they still consume the tool-call budget.
- Existing tool trace previews include the correction code, safe issue paths, and `correctionBytes`. Baseline byte comparisons are measured in fixtures rather than reconstructing the obsolete full union error on each live rejection. No raw-validation logging was added.
- Transport errors, locator recovery limits, Chinese output requirements, evidence checks, and final-verdict validation retain their existing behavior. Optional groups and history compaction are not part of this implementation.
- For the `page.content` fixture, the old serialized tool output measured 29,394 bytes; the new output measures 306 bytes, a 98.96% reduction for this fixture. This is not a measured reduction in task tokens or latency.
- Validation passed: 69 Runtime protocol tests, 108 Agent Runtime tests, repository-wide `pnpm typecheck`, and the Runtime protocol / Agent Runtime builds. The Agent network-policy tests ran with permission to start temporary loopback HTTP servers; the sandbox-only attempt was blocked by `listen EPERM`.

The corpus covers all 39 existing action names, defaults/coercion, invalid extra fields, URL restrictions, recovery refs/tokens, network response-body filters, and invalid calls followed by corrected execution. Full-task model quality and deployment verification remain future release checks.
