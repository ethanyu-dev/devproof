import type { Locator } from "playwright";

/** Bounded native inputs only. Every completed field is reported on interruption. */
export async function fillFields(input: {
  fields: readonly { ref: string; text: string }[];
  locator: (ref: string) => Locator;
  assertActive: () => void;
  beforeField: (ref: string) => Promise<void>;
  timeout: () => number;
}) {
  const results: Array<{
    ref: string;
    status: "COMPLETED" | "FAILED" | "SKIPPED";
    error?: string;
  }> = [];
  const locators = input.fields.map((f) => input.locator(f.ref));
  // Resolve and validate every field before performing the first mutation.
  for (const locator of locators) {
    input.assertActive();
    const native = await locator.evaluate(
      (el) => {
        const tag = el.tagName.toLowerCase();
        const type = (el as HTMLInputElement).type;
        return (
          (tag === "textarea" ||
            (tag === "input" &&
              ["text", "email", "search", "tel", "url", "number"].includes(
                type,
              ))) &&
          el.getAttribute("role") !== "combobox" &&
          !(el as HTMLInputElement).readOnly
        );
      },
      undefined,
      { timeout: input.timeout() },
    );
    if (!native || !(await locator.isVisible()) || !(await locator.isEnabled()))
      throw new Error(
        "FORM_SEQUENCE_UNSUPPORTED: use individual commands for non-native, hidden or disabled controls.",
      );
  }
  const root = await locators[0]!.evaluateHandle((el) =>
    el.closest("form,dialog,[role=dialog],[role=form]"),
  );
  try {
    if (!(await root.evaluate((el) => Boolean(el))))
      throw new Error("FORM_SEQUENCE_SCOPE_REQUIRED");
    for (const locator of locators) {
      if (
        !(await locator.evaluate(
          (el, root) =>
            el.closest("form,dialog,[role=dialog],[role=form]") === root,
          root,
        ))
      )
        throw new Error("FORM_SEQUENCE_SCOPE_MISMATCH");
    }
    for (const [i, field] of input.fields.entries()) {
      try {
        input.assertActive();
        await input.beforeField(field.ref);
        input.assertActive();
        if (
          !(await locators[i]!.evaluate(
            (el, root) =>
              el.closest("form,dialog,[role=dialog],[role=form]") === root,
            root,
          ))
        )
          throw new Error("FORM_SEQUENCE_SCOPE_CHANGED");
        await locators[i]!.fill(field.text, { timeout: input.timeout() });
        results.push({ ref: field.ref, status: "COMPLETED" });
        input.assertActive();
      } catch (error) {
        if (results.length === i)
          results.push({
            ref: field.ref,
            status: "FAILED",
            error: String(error).slice(0, 500),
          });
        for (const rest of input.fields.slice(i + 1))
          results.push({ ref: rest.ref, status: "SKIPPED" });
        return {
          status: "PARTIAL" as const,
          fields: results,
          nextAction:
            "Observe the current form. Do not replay completed fields or submit automatically.",
        };
      }
    }
    return { status: "COMPLETED" as const, fields: results };
  } finally {
    await root.dispose().catch(() => undefined);
  }
}
