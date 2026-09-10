# Browser DOM references and bounded locator recovery

Fresh DOM references could fail with `STALE_DOM_REFERENCE` even when their
observed nodes remained connected. A local Chromium fixture reproduces this
when an iframe-created node is rendered in an open shadow root and its
`ownerDocument` and `getRootNode()` expose a sandbox document. Wujie implements
this virtualization in its [iframe patches](https://github.com/Tencent/wujie/blob/master/packages/wujie-core/src/iframe.ts).
This is a reproduced failure mechanism, not a claim that every production stale
reference has this cause.

The selector previously used the node's document to locate its reference store
and its overridden root to cross shadow boundaries. It now uses the evaluating
frame's store and native `Node` methods from that realm. Scoped snapshots write
to the same store. References still identify the exact observed node; detached
or replaced nodes and references from earlier observations remain invalid.

Separately, the Agent's two-retarget guard rejected further clicks but continued
asking the model for decisions. Repeated observations and rejected operations
could consume the remaining task deadline. Exhausting recovery now enters the
existing bounded finalization path immediately, including when the same model
response contains additional tool calls. Accepted criteria and evidence survive;
unverified criteria become `INCONCLUSIVE`. The durable checkpoint records
`LOCATOR_RECOVERY_EXHAUSTED` instead of waiting for a generic deadline reason.

The API still audits possibly completed writes. A read-only task description or
a failed click is not proof that no write occurred. If write outcomes remain
unknown, the API preserves partial criteria and the original stop reason while
blocking the run and quarantining conflicting resources.

## Regression coverage

- Real Chromium: a connected sandbox node resolves and can be clicked through
  its fresh reference; a scoped observation of the same node also resolves.
- Existing DOM tests: shadow roots, frame isolation, expired references, and
  replacement-node rejection continue to work.
- Agent: two unsuccessful retargets stop further model calls and queued tools,
  preserve a passed criterion, finalize unresolved criteria, persist a checkpoint,
  and release the browser.
- Protocol and API: the new reason survives parsing, fenced checkpoint recovery,
  and uncertain-write reconciliation; older outcomes without a reason still parse.

## Rollout

Deploy the API with Agent protocol v2.14 before the Agent. Publish and install a
Browser Runtime release containing the DOM fix on the machines executing tests;
updating only API and Agent leaves the browser bug in place. This change needs no
database migration or Browser wire-protocol increment. Slow model responses and
upstream provider failures remain separate causes of latency; the recovery bound
prevents them from extending an already exhausted locator loop.
