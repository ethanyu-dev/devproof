# Virtual dropdown scrolling

A virtual dropdown can have a 256px viewport over a 544px spacer with
`overflow-y:hidden`. It is still programmatically scrollable. Only a subset of
rows are mounted; a DOM snapshot deliberately includes only the visible subset.
Reading the cached snapshot does not render the remaining rows.

The Runtime shares permitted overflow values (`auto`, `scroll`, `hidden`)
between DOM observation and scrolling. Nonzero visible dimensions and actual
overflow determine which containers receive a snapshot ref. `overflow:clip`
does not establish a programmatic scrolling target. HTML controls are recognized
by namespace and tag so adopted microfrontend controls retain actionable refs;
password values remain omitted.

`page.scroll.target` names the container itself. Supplying an option does not
implicitly scroll its parent: the Runtime returns `SCROLL_TARGET_NOT_SCROLLABLE`
with nearby container geometry. The Agent takes a fresh snapshot and retargets
using its bounded locator recovery flow. Scrolling an inner container never
chains to the background when it reaches its boundary.

With protocol v1.17 and `scroll-feedback-v1`, targeted scrolling returns measured
positions and bounds. It waits for local geometry/text stability (two consecutive
animation-frame samples, at least 100ms, at most one second within the command
budget). A replaced target invalidates the operation. This wait is not proof that
network-driven work finished; the subsequent snapshot is the source of truth for
new virtual rows. Untargeted wheel input reports `UNVERIFIED`.

After a ref-targeted scroll, the next snapshot identifies the same connected
element with a new `focusRef`. The Agent pins the text page containing that ref,
while preserving unread coverage of preceding pages. An absent/replaced target
does not gain a fabricated ref. Explicit snapshot targets retain their scope.

Two measured no-movement results for the same observed target, direction, and
unchanged page block another identical scroll before dispatch. A confirmed
boundary also blocks further movement in that direction. New page content,
reverse scrolling, and actual input/search allow recovery; changing ref or delta
magnitude alone does not. Legacy responses without feedback are not assumed to
prove motion. Search and complete-list traversal remain distinct coverage claims.

Observation descriptors in model requests are limited to 8 KiB, prioritizing the
current DOM and the last requested observation, then recent entries. The complete
segment cache and its read cursors are retained. `observationIndexOmitted` reports
omissions; an omitted index entry is still readable by an existing ID until normal
cache eviction. This prevents long read/snapshot sequences from exhausting the
96 KiB text request budget just through historical descriptors. Context metrics
and budget failures report component byte counts without logging their content.

## Verification and rollout

Regression tests run a live virtual renderer with delayed scroll handling in a
normal document, an open shadow microfrontend with a sandbox document, and an
iframe. They verify the target row is absent initially, scroll to render it,
click its new ref, and check the selected value. Other tests cover clipped rows,
horizontal/reverse motion, invalid targets, nested background isolation,
no movement, target replacement, adopted controls, password redaction, focused
pagination, Agent recovery/dispatch limits, bounded context, and negotiation.

The BrowserSessionManager integration test exercises the actual command and
snapshot handlers as well as persistent step evidence. These local fixtures are
not a replay of the production site's complete React application.

Deploy the API/Agent changes, release and upgrade the independently installed
Browser Runtime, and verify the running process reconnects with protocol v1.17
and `scroll-feedback-v1`. An API deploy alone does not update that process.
Rerun the read-only dropdown case before any case that writes test data.
