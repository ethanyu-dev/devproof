# DOM + visual browser observations

The verification Agent must work with sites it does not control. It observes
native DOM nodes and viewport pixels; sites do not need ARIA attributes,
test IDs, prescribed component libraries, or framework-specific selectors.

## Observation and interaction

`page.snapshot` describes visible text, native tags, labels, values, options,
and opaque node references. It traverses open Shadow DOM and iframe documents.
Boxes within an iframe use that frame's coordinates; visual clicks use the
top-level viewport image in CSS pixels. Closed shadow roots and Canvas pixels
remain available through the screenshot. A snapshot can be limited by depth,
node count or text budget; truncation is explicit and smaller scopes are allowed.

References retain actual node identity using a Runtime-owned selector registry,
without adding attributes to site elements. A detached node cannot silently
resolve to a replacement. New snapshots replace references. The Agent rejects
historical or unread references and automatically observes again for stale refs
and images. Recovery retains the existing two-attempt limit and requires a
recovery token. A locator failure is not evidence of a product failure.

For a custom dropdown, click its trigger, observe the expanded DOM and image,
click the visible option, and verify the resulting value or business response.
`page.select` rejects non-native controls immediately with actionable guidance.
For visual-only controls, click a point from the current viewport image and pass
its `observationId` as `visualObservationId`. After visual focus, `page.type`
without a target types into the focused element; `page.press` supports keyboard
navigation. Timeouts do not prove that a save failed: inspect the resulting page
or response before repeating a write.

## Image delivery and budgets

Successful navigation, interaction and snapshot commands capture a viewport
screenshot. The API reads at most one screenshot belonging to the authenticated
task's current command from object storage. It does not accept arbitrary artifact
IDs, URLs or storage keys from model tool arguments. JPEG/PNG content is limited
to 1,280,000 bytes. Failed reads preserve the original action result and report
that the visual observation is unavailable, avoiding an accidental action replay.

The executor supplies a typed Responses `input_image` data URL with `detail: high`,
alongside the current observation ID and viewport dimensions. Only the current
image is retained, outside the 96 KiB text budget; request metrics report text
bytes, image count, decoded image bytes and complete request bytes separately.
Tool history and traces retain metadata, never base64 image bodies. Full-page
evidence images are not treated as coordinate-ready viewport observations.

Runtime screenshots use CSS pixel scale. Agent coordinate actions require the
current image ID. Runtime also checks tab identity, URL, viewport, scroll position,
known intervening actions and a two-minute age limit. These checks do not freeze
the website: asynchronous content or an overlay can still change after capture.
The Agent must observe results and refresh when the UI changes. Visual perception
accuracy depends on the configured model and is not established by transport tests.

## Deployment and validation

Browser Runtime 0.2.22 advertises protocol v1.16 and `dom-vision-v1`. API admission
requires this capability before allocating new work. An existing session on an
older Runtime returns `BROWSER_RUNTIME_UPGRADE_REQUIRED`; it is not silently
treated as visually capable. Upgrade the API, Browser Runtime and Agent Runtime
before resuming verification. The configured model/gateway must support image
input; no model choice is changed by this implementation. No database migration
is required, and normal session closure remains necessary before a fresh attempt.

Automated coverage exercises role-free div dropdowns and hidden duplicates,
replacement nodes, open Shadow DOM, iframe refs, Canvas coordinate actions,
focused Unicode input, stale screenshots, bounded owned-artifact retrieval,
actual image parts in model requests, text/image budgets and trace redaction.
These tests use local fixtures and a mocked model; they do not establish that the
previous production task now passes.

Image request format follows the official [OpenAI images and vision guide](https://developers.openai.com/api/docs/guides/images-vision).
