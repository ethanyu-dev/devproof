# Design 2: a smaller, discoverable browser tool surface

Date: 2026-09-08. Status: implemented locally and regression-tested. Live gateway evaluation and deployment have not been performed.

## Problem and alternatives

`toolDefinitions()` previously published the complete `runtimeActionCommandInputSchema` on every model call. Its 39 command variants included a navigation alias, advanced network manipulation, and recovery-token documentation repeated in every branch. The number of top-level Agent tools therefore understated the actual decision surface.

| Option          | Design                                                               | Benefit                                                               | Limitation                                                         |
| --------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A               | Keep all operations; remove aliases and repeated schema descriptions | Small change; stable surface                                          | Most advanced parameters remain present on every request           |
| B — recommended | Stable core command set with explicit optional groups                | Smaller ordinary requests; every distinct operation remains reachable | Discovery can add a model round; active groups must be tracked     |
| C               | Replace low-level commands with tools such as `complete_form`        | Very small visible surface                                            | Introduces ambiguous action planning and new retry/write semantics |

Splitting the union into 39 always-visible tools does not by itself reduce total schema size. Option C is deferred because an additional action planner would need its own specification and evaluation.

## Recommended surface

Keep `browser_command` and its current argument vocabulary. The default catalog now advertises these 15 core commands:

`page.navigate`, `page.snapshot`, `page.get_text`, `page.get_url`, `page.get_title`, `page.click`, `page.fill`, `page.press`, `page.check`, `page.uncheck`, `page.select`, `page.scroll`, `page.wait`, `page.screenshot`, `page.dom`.

Keep `record_criterion`, `finish_verification`, the existing conditional `request_human_input`, and `read_observation` when bounded context is enabled. The core set retains both checkbox states, keyboard interaction, explicit waits, and evidence capture.

Provide one local `enable_browser_tools` tool with a short group catalog:

| Group            | Additional commands                                                        |
| ---------------- | -------------------------------------------------------------------------- |
| `navigation`     | `page.back`, `page.forward`, `page.reload`                                 |
| `input`          | `page.type`, `page.hover`, `page.drag`                                     |
| `tabs`           | `tab.list`, `tab.new`, `tab.switch`, `tab.close`                           |
| `frames`         | `frame.snapshot`, `frame.click`, `frame.fill`                              |
| `diagnostics`    | `page.errors`, `page.console`, `page.network`                              |
| `inspection`     | `element.state`, `locator.count`                                           |
| `viewport`       | `page.resize`                                                              |
| `network_faults` | `network.arm`, `network.wait_for_hit`, `network.status`, `network.release` |

These groups cover the other 23 distinct operations. The remaining alias, `page.open`, is omitted from the grouped Agent catalog; an attempted call returns a concise correction suggesting `page.navigate` without executing it. The wire protocol and legacy Agent catalog still accept `page.open`.

The pre-change core-only parameter schema measured 13,460 characters / 14,460 UTF-8 bytes before schema cleanup. The implementation measurements below include all top-level tools and group discovery. They are serialized byte counts, not token counts.

## Activation rules

- Begin with the core set. Enable `diagnostics` immediately if a criterion requires NETWORK or CONSOLE evidence.
- Advertise a one-line description of every optional group in `enable_browser_tools`. Do not depend on an LLM guessing undocumented commands or on brittle keyword classification of the goal.
- A group-enable call validates the complete list before adding any groups and returns `{enabledGroups: [...]}` in stable catalog order. The next request's `tools` contains their full schemas; schemas are not duplicated in the enable result.
- Activation is additive for the rest of the segment. Repeated enables are idempotent and still consume the existing tool-call budget. No browser command is issued by discovery.
- Calling a recognized but inactive operation returns `TOOL_GROUP_REQUIRED`, `requiredGroup`, and a concise next action before payload validation or browser dispatch. The model must enable the group and submit its action after receiving the next request's definitions. An enable and action emitted in the same model response cannot bypass this boundary.
- An activated group is a model-discovery setting, not an authorization grant or a guarantee of negotiated Runtime support. Existing API compatibility and policy checks remain authoritative. Do not invent capability information absent from the current acquisition response.
- Keep the active surface identical across model-provider fallback within a round. Pin legacy/core mode when the segment starts.

Groups remain active after earlier conversation turns are compacted. The bounded working state and model trace metrics include mode, active groups, and advertised command count. A new segment, including formal HITL resume, rebuilds the catalog from the new task's evidence requirements; it does not inherit optional activations from a previous segment. Required NETWORK or CONSOLE evidence enables diagnostics without classifying goal text or implicitly enabling network faults.

## Shared schema source and recovery

The catalog reuses `getRuntimeActionCommandSchema` from the canonical protocol registry introduced by the correction change. The aggregate wire schema and validation semantics are unchanged. There is no second command grammar or inspection of private Zod internals.

Selected registry entries generate the same non-strict `anyOf` shape used previously. Validation-only `format` annotations are removed as before; no `$defs` or `$ref` indirection is introduced. Each branch still accepts the optional recovery token with the existing length limits. Grouped mode removes its repeated branch description while keeping the recovery guidance on `browser_command` and in the system instructions. Schema generation is cached until the active group set changes.

The initial change keeps the exact `locatorRecoveryToken` input contract and two-attempt policy. It can shorten repeated descriptions, but it must not remove recovery enforcement as a side effect. Lifecycle and credential commands remain absent from the Agent surface.

[`browser-tool-catalog.ts`](../apps/agent-runtime/src/browser-tool-catalog.ts) owns group membership, activation, presentation, and catalog corrections. [`model-tool-schema.ts`](../apps/agent-runtime/src/model-tool-schema.ts) owns the existing model-schema format adaptation. `parseBrowserCommand` still validates active calls with the canonical parser before the executor dispatches them. Activation grants neither authorization nor negotiated Runtime support.

Local errors distinguish `TOOL_GROUP_REQUIRED`, `COMMAND_NOT_ALLOWED` for platform-owned lifecycle/control commands, `UNKNOWN_COMMAND`, and `INVALID_ARGUMENTS`. They use the existing 2 KiB correction budget. Runtime errors such as `UNSUPPORTED_COMMAND` remain original browser failures rather than being reclassified as discovery or validation problems.

## Verification and measurements

- Verify every current variant is either core, in exactly one optional group, or the explicit `page.open` alias. Every advertised payload must pass the same canonical parser as before.
- Exercise an ordinary form without discovery; a keyboard-sensitive field via `input`; tab and iframe workflows; network evidence; fault arm/wait/release; and an ambiguous locator after a group enable.
- Verify unknown commands, inactive commands, unsupported Runtime commands, and forbidden lifecycle operations produce distinct outcomes without issuing unintended browser commands.
- Preserve payload semantics: do not silently turn typing into filling, checking into clicking, or a network wait into a generic sleep.
- The initial ordinary-task request targets at most 60% of legacy advertised-tool bytes, including all top-level tools and discovery. The fixture achieves 45.29%.

175 Agent Runtime tests and repository-wide type checking pass. Tests verify complete canonical coverage, identical payload constraints and defaults, ordinary forms, typing, tabs/iframes, required network/console evidence, fault arm/wait/status/release, locator recovery after activation, invalid and duplicate enables, same-response gating, compaction, fallback, HITL reset, and independent rollback modes. Agent Runtime build, formatting, and local documentation links are checked as well.

The fixtures use scripted Responses and the same bounded-context settings in both catalog modes. They compare commands delivered to the control plane rather than counting local enable calls as browser operations:

| Fixture / measurement                            |       Grouped |        Legacy |
| ------------------------------------------------ | ------------: | ------------: |
| Ordinary task: initial complete tool definitions |  17,199 bytes |  37,974 bytes |
| Ordinary form: cumulative request bodies         | 143,046 bytes | 265,848 bytes |
| Ordinary form: model rounds / browser commands   |         6 / 4 |         6 / 4 |
| Tabs + iframe: cumulative request bodies         | 228,047 bytes | 312,130 bytes |
| Tabs + iframe: model rounds / browser commands   |         8 / 5 |         7 / 5 |

Initial tool definitions are 54.71% smaller. Optional modules can add a model round; the tabs/iframe fixture explicitly counts that round. These deterministic fixtures do not measure live task success, completion latency, billed tokens, or gateway acceptance. Those require separate live evaluations.

## Configuration and rollback

`DEVPROOF_AGENT_TOOL_SURFACE_MODE=GROUPED` is the default. Set it to `LEGACY`, drain active segments, and restart the Agent Runtime to advertise the full 39-command catalog for new segments without `enable_browser_tools`. This setting is independent of `DEVPROOF_AGENT_CONTEXT_MODE`; grouped discovery works with full history, and the full catalog works with bounded context.

No Browser Runtime deployment, protocol major change, Console setting, or database migration is required for this model-facing change. Browser authorization, capabilities, leases, evidence, and command records retain their existing ownership and validation boundaries.
