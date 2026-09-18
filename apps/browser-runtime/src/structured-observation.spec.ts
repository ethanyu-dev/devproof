import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { structuredObservationSchema } from "@devproof/runtime-protocol";
import { evaluateObservationTarget } from "../../../packages/agent-runtime-protocol/src/observation-evaluator.js";
import type { ObservationTargetV2 } from "../../../packages/agent-runtime-protocol/src/observation-contract.js";
import { DomObservations } from "./dom-observation.js";
import { focusedObservation } from "../../agent-runtime/src/observation-view.js";

it("preserves established reopening history across a scoped read and exposes row membership", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      await readFile(
        new URL("./fixtures/object-evidence.html", import.meta.url),
        "utf8",
      ),
    );
    const dom = new DomObservations();
    const first = (await dom.snapshot(page)).structured;
    const row = first.nodes.find((n) => n.tag === "tr")!;
    const cell = first.nodes.find((n) => n.tag === "td")!;
    expect(
      first.renderedText.slice(cell.textLocation.start, cell.textLocation.end),
    ).toContain(`scopeRef="${row.ref}"`);
    expect(row.textLocation.start).toBeLessThan(cell.textLocation.start);
    await dom.markAction(page, randomUUID());
    await page.locator("#open").click();
    await dom.snapshot(page);
    await dom.markAction(page, randomUUID());
    await page.locator("#close").click();
    await dom.snapshot(page);
    await dom.snapshot(page, page.locator("table"));
    await dom.markAction(page, randomUUID());
    await page.locator("#open").click();
    const reopened = (await dom.snapshot(page)).structured;
    const dialog = reopened.nodes.find((n) => n.tag === "dialog")!;
    expect(
      reopened.regions.find((r) => r.nodeId === dialog.nodeId),
    ).toMatchObject({ phaseProven: true, reopened: true });
    await dom.invalidatePhases(page);
    const invalidated = (await dom.snapshot(page)).structured;
    expect(
      invalidated.regions.find((r) => r.nodeId === dialog.nodeId)?.phaseProven,
    ).toBe(false);
  } finally {
    await browser.close();
  }
});

it("captures popup ownership and focuses visible options beside a virtualized ARIA list", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <label for="type">Type</label><input id="type" role="combobox" aria-controls="choices" aria-expanded="true">
      <div><div id="choices" role="listbox" style="height:0;overflow:hidden"><div role="option">MAPPING_ENUM</div></div>
      <div aria-selected="false" title="Mapping">Mapping</div></div>
      <p>${"Unrelated background records. ".repeat(150)}</p>`);
    const dom = new DomObservations();
    const snapshot = (await dom.snapshot(page)).structured;
    expect(
      snapshot.nodes.find((n) => n.role === "combobox")!.attributes[
        "aria-controls"
      ],
    ).toBe("choices");
    const view = focusedObservation(snapshot)!;
    expect(view.content).toContain("Mapping");
    expect(view.content).toContain("Type");
    expect(view.content).not.toContain("Unrelated background");
    expect(view.content).not.toContain("MAPPING_ENUM");
    expect(snapshot.renderedText).toContain("Unrelated background");
    await page
      .locator("#type")
      .evaluate((el) => el.setAttribute("aria-expanded", "false"));
    expect(
      focusedObservation((await dom.snapshot(page)).structured, view),
    ).toBeUndefined();
  } finally {
    await browser.close();
  }
});

const defaultTarget: ObservationTargetV2 = {
  targetId: "default",
  label: "Default enabled",
  scope: { kind: "DIALOG", names: ["Settings"] },
  entity: {
    controlKind: "SELECT",
    label: "Type",
    property: "SELECTED_LABEL",
    oneOf: ["A"],
  },
  phase: "INITIAL_AFTER_OPEN",
  assertions: [
    {
      assertionId: "enabled",
      subject: { kind: "SWITCH", label: "Enabled" },
      property: "CHECKED",
      operator: "EQ",
      expected: true,
    },
  ],
  requiredEvidenceKinds: ["DOM", "SCREENSHOT"],
  temporal: "SAME_OBSERVATION",
};

it("pairs focused deeply nested form controls with their labels and screenshot", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const dom = new DomObservations();
    await page.setContent(`<button id="open">Open</button>`);
    const initial = (await dom.snapshot(page)).structured;
    await dom.markAction(
      page,
      randomUUID(),
      initial.nodes.find((n) => n.tag === "button")!.ref,
    );
    await page.locator("body").evaluate((el) => {
      el.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog" aria-label="Settings">
        <div><div><label>Type</label></div><div><div><div><div><div>
          <span><span><input type="search" role="combobox"></span></span><span title="A">A</span>
        </div></div></div></div></div></div>
        <div><label>Enabled</label><button role="switch" aria-checked="true">On</button></div>
      </div>`,
      );
    });
    await page.locator("input").focus();
    await dom.snapshot(page);
    let capture = (await dom.snapshot(page, page.locator("[role=dialog]")))
      .structured;
    const control = capture.nodes.find((n) => n.role === "combobox")!;
    expect(control).toMatchObject({ name: "Type", selectedLabel: "A" });
    await page.screenshot();
    expect(await dom.verifyCapture(page, capture)).toBe(false);
    expect(capture.consistencyIssues).toEqual([
      expect.objectContaining({ code: "DOCUMENT_MUTATED" }),
    ]);
    capture = (await dom.snapshot(page, page.locator("[role=dialog]")))
      .structured;
    await page.screenshot({ caret: "initial" });
    expect(
      await dom.verifyCapture(page, capture),
      JSON.stringify(capture.consistencyIssues),
    ).toBe(true);
    capture.consistency = "VERIFIED";
    expect(
      evaluateObservationTarget(defaultTarget, capture, ["DOM", "SCREENSHOT"])
        .binding,
    ).toMatchObject({ readiness: "READY", evaluation: "MATCHED" });
  } finally {
    await browser.close();
  }
});

it("does not infer a label across multiple form controls", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div><label>Type</label><div><input role="combobox"><input role="combobox"></div></div>',
    );
    const capture = (await new DomObservations().snapshot(page)).structured;
    expect(
      capture.nodes
        .filter((n) => n.role === "combobox")
        .every((n) => !n.name && !n.relations.length),
    ).toBe(true);
  } finally {
    await browser.close();
  }
});

it.each(["replacement", "region replacement", "scroll"])(
  "does not regain default-state proof after %s",
  async (mode) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 800, height: 600 },
      });
      const dom = new DomObservations();
      await page.setContent(`
      <button id="open">Open</button>
      <div role="dialog" aria-label="Settings" style="display:none">
        <label>Type<select><option>A</option></select></label>
        <button role="switch" aria-label="Enabled" aria-checked="false">Toggle</button>
      </div><div style="height:2200px"></div>`);
      const initial = (await dom.snapshot(page)).structured;
      await dom.markAction(
        page,
        randomUUID(),
        initial.nodes.find((n) => n.tag === "button")!.ref,
      );
      await page.locator("#open").evaluate((el) => {
        el.addEventListener("click", () => {
          (
            document.querySelector("[role=dialog]") as HTMLElement
          ).style.display = "block";
        });
      });
      await page.locator("#open").click();
      const opened = (await dom.snapshot(page)).structured;
      const region = opened.regions.find(
        (r) =>
          r.nodeId === opened.nodes.find((n) => n.role === "dialog")!.nodeId,
      )!;
      expect(region.phaseProven).toBe(true);
      const toggle = opened.nodes.find((n) => n.role === "switch")!;
      await page.locator("[role=switch]").evaluate((el, mode) => {
        el.addEventListener("click", () => {
          if (mode === "region replacement") {
            const region = el.closest("[role=dialog]")!;
            const next = region.cloneNode(true) as Element;
            next
              .querySelector("[role=switch]")!
              .setAttribute("aria-checked", "true");
            region.replaceWith(next);
            return;
          }
          const next =
            mode === "replacement" ? (el.cloneNode(true) as Element) : el;
          next.setAttribute("aria-checked", "true");
          if (mode === "replacement") el.replaceWith(next);
        });
      }, mode);
      await dom.markAction(page, randomUUID(), toggle.ref);
      await dom.locator(page, toggle.ref!).click();
      await dom.snapshot(page);
      if (mode === "scroll") {
        await page.evaluate(() => scrollTo(0, 1000));
        await dom.snapshot(page);
        await page.evaluate(() => scrollTo(0, 0));
      }
      const after = (await dom.snapshot(page)).structured;
      await page.screenshot();
      expect(await dom.verifyCapture(page, after)).toBe(true);
      after.consistency = "VERIFIED";
      if (mode !== "region replacement")
        expect(
          after.regions.find((r) => r.nodeId === region.nodeId),
        ).toMatchObject({
          epoch: region.epoch,
          reopened: false,
          modifiedNodeIds: expect.arrayContaining([toggle.nodeId]),
        });
      expect(
        evaluateObservationTarget(defaultTarget, after, ["DOM", "SCREENSHOT"])
          .binding,
      ).toMatchObject({
        evaluation: "MATCHED",
        readiness: "PARTIAL",
        phaseProven: false,
        reasons: ["PHASE_UNPROVEN"],
      });
    } finally {
      await browser.close();
    }
  },
);

it("does not treat an unrelated removed popup option as an edit inside the dialog", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const dom = new DomObservations();
    await page.setContent('<button id="open">Open</button>');
    const initial = (await dom.snapshot(page)).structured;
    await dom.markAction(page, randomUUID(), initial.nodes[1]!.ref);
    await page.locator("body").evaluate((el) => {
      el.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog" aria-label="Settings"><label>Type<select><option>A</option></select></label><button role="switch" aria-label="Enabled" aria-checked="true">Toggle</button></div><div role="listbox"><button id="option">A</button></div>`,
      );
      document
        .querySelector("#option")!
        .addEventListener("click", () =>
          document.querySelector("[role=listbox]")!.remove(),
        );
    });
    const opened = (await dom.snapshot(page)).structured;
    const option = opened.nodes.find(
      (n) => n.tag === "button" && n.text === "A",
    )!;
    await dom.markAction(page, randomUUID(), option.ref);
    await dom.locator(page, option.ref!).click();
    const after = (await dom.snapshot(page)).structured;
    expect(
      evaluateObservationTarget(
        { ...defaultTarget, requiredEvidenceKinds: ["DOM"] },
        after,
        ["DOM"],
      ).binding,
    ).toMatchObject({
      readiness: "READY",
      evaluation: "MATCHED",
      phaseProven: true,
    });
  } finally {
    await browser.close();
  }
});

it("uses inherited native disabled state, including the first legend exception, in capture and verification", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const dom = new DomObservations();
    await page.setContent(
      `<form aria-label="Settings"><label>Type<select><option>A</option></select></label><fieldset disabled><legend><label>Legend<input id="legend"></label></legend><label>Name<input id="name"></label><button id="save">Save</button></fieldset></form>`,
    );
    const capture = (await dom.snapshot(page)).structured;
    const name = capture.nodes.find(
      (n) => n.tag === "input" && n.name === "Name",
    )!;
    expect(await page.locator("#name").isEnabled()).toBe(false);
    expect(name.enabled).toBe(false);
    expect(capture.nodes.find((n) => n.tag === "button")!.enabled).toBe(false);
    expect(
      capture.nodes.find((n) => n.tag === "input" && n.name === "Legend")!
        .enabled,
    ).toBe(true);
    expect(await dom.verifyCapture(page, capture)).toBe(true);
    const target: ObservationTargetV2 = {
      ...defaultTarget,
      scope: { kind: "FORM", names: ["Settings"] },
      phase: "CURRENT",
      requiredEvidenceKinds: ["DOM"],
      assertions: [
        {
          assertionId: "disabled",
          subject: { kind: "FIELD", label: "Name" },
          property: "ENABLED",
          operator: "EQ",
          expected: false,
        },
      ],
    };
    expect(
      evaluateObservationTarget(target, capture, ["DOM"]).binding,
    ).toMatchObject({
      evaluation: "MATCHED",
      readiness: "READY",
      facts: [{ actual: false }],
    });
    // Verification must reject the old incorrect enabled=true interpretation too.
    const incorrect = structuredClone(capture);
    incorrect.nodes.find((n) => n.nodeId === name.nodeId)!.enabled = true;
    expect(await dom.verifyCapture(page, incorrect)).toBe(false);
  } finally {
    await browser.close();
  }
});

it("preserves literal field whitespace and marks clipped values and labels", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<label for="value">精确字段</label><textarea id="value"></textarea><button id="long"></button>',
    );
    const dom = new DomObservations();
    await page.locator("textarea").fill("  two   words\n");
    const exact = (await dom.snapshot(page)).structured;
    expect(exact.nodes.find((n) => n.tag === "textarea")?.value).toBe(
      "  two   words\n",
    );
    expect(await dom.verifyCapture(page, exact)).toBe(true);
    await page.locator("textarea").fill("x".repeat(501));
    await page.locator("button").evaluate((el) => {
      el.setAttribute("aria-label", "label".repeat(101));
      el.textContent = "text".repeat(126);
    });
    const clipped = structuredObservationSchema.parse(
      (await dom.snapshot(page)).structured,
    );
    expect(
      clipped.nodes.find((n) => n.tag === "textarea")?.truncatedProperties,
    ).toContain("VALUE");
    expect(
      clipped.nodes.find((n) => n.tag === "button")?.truncatedProperties,
    ).toEqual(expect.arrayContaining(["NAME", "TEXT"]));
  } finally {
    await browser.close();
  }
});

it("rejects paired evidence when text or a new dialog changes during capture", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<p>初始说明</p><input value="two   words">');
    const dom = new DomObservations();
    const before = (await dom.snapshot(page)).structured;
    expect(await dom.verifyCapture(page, before)).toBe(true);
    await page.locator("p").evaluate((el) => {
      el.textContent = "新的说明";
    });
    expect(await dom.verifyCapture(page, before)).toBe(false);
    const next = (await dom.snapshot(page)).structured;
    await page.evaluate(() => {
      const dialog = document.createElement("dialog");
      document.body.append(dialog);
      dialog.showModal();
    });
    expect(await dom.verifyCapture(page, next)).toBe(false);
  } finally {
    await browser.close();
  }
});

it("captures separate dialog identity/state and tracks opening, edits and reopening", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      await readFile(
        new URL("./fixtures/object-evidence.html", import.meta.url),
        "utf8",
      ),
    );
    const dom = new DomObservations();
    await dom.snapshot(page);
    await dom.markAction(page, randomUUID());
    await page.locator("#open").click();
    const capture = structuredObservationSchema.parse(
      (await dom.snapshot(page)).structured,
    );
    const select = capture.nodes.find((n) => n.tag === "select")!;
    expect(select.selectedLabel).toBe("合规模型映射");
    const toggle = capture.nodes.find((n) => n.role === "switch")!;
    expect(toggle.checked).toBe(true);
    expect(toggle.name).toBe("启用状态");
    const dialog = capture.nodes.find((n) => n.tag === "dialog")!;
    expect(
      capture.regions.find((r) => r.nodeId === dialog.nodeId)?.phaseProven,
    ).toBe(true);
    expect(await dom.verifyCapture(page, capture)).toBe(true);
    await dom.markAction(page, randomUUID(), toggle.ref);
    await dom.locator(page, toggle.ref!).click();
    expect(await dom.verifyCapture(page, capture)).toBe(false);
    const edited = (await dom.snapshot(page)).structured;
    expect(
      edited.regions.find((r) => r.nodeId === dialog.nodeId)?.modifiedNodeIds,
    ).toContain(toggle.nodeId);
    await page.locator("#close").click();
    await dom.snapshot(page);
    await dom.markAction(page, randomUUID());
    await page.locator("#open").click();
    const reopened = (await dom.snapshot(page)).structured;
    expect(
      reopened.regions.find((r) => r.nodeId === dialog.nodeId)?.reopened,
    ).toBe(true);
    expect(
      reopened.regions.find((r) => r.nodeId === dialog.nodeId)?.epoch,
    ).not.toBe(capture.regions.find((r) => r.nodeId === dialog.nodeId)?.epoch);
    await dom.invalidatePhases(page);
    expect(
      (await dom.snapshot(page)).structured.regions.find(
        (r) => r.nodeId === dialog.nodeId,
      )?.phaseProven,
    ).toBe(false);
  } finally {
    await browser.close();
  }
});

it("never treats the search input value as the selected option", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<label for="search">类型</label><div><span><input id="search" role="combobox" value="Wrong type"></span><span title="Selected type">Selected type</span></div>',
    );
    const capture = (await new DomObservations().snapshot(page)).structured;
    const node = capture.nodes.find((n) => n.role === "combobox")!;
    expect(node.value).toBe("Wrong type");
    expect(node.selectedLabel).toBe("Selected type");
    expect(node.relations.some((r) => r.kind === "SELECTED_DISPLAY")).toBe(
      true,
    );
  } finally {
    await browser.close();
  }
});

it("keeps stable form evidence when a background row mutates, but rejects changed or replaced controls", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<p id="background">old</p><div role="dialog"><form>
      <label>Type<select><option>A</option></select></label>
      <button type="button" role="switch" aria-label="Enabled" aria-checked="true">On</button>
    </form></div>`);
    const dom = new DomObservations();
    let capture = (await dom.snapshot(page)).structured;
    const formId = capture.nodes.find((n) => n.tag === "form")!.nodeId;
    await page.locator("#background").evaluate((el) => {
      el.textContent = "new";
    });
    await page.screenshot({ caret: "initial" });
    expect(await dom.verifyCapture(page, capture)).toBe(false);
    expect(capture.verifiedScopeNodeIds).toContain(formId);
    expect(capture.consistencyIssues).toContainEqual(
      expect.objectContaining({
        code: "DOCUMENT_MUTATED",
        nodeId: expect.any(String),
      }),
    );
    capture = (await dom.snapshot(page)).structured;
    await page
      .locator("[role=switch]")
      .evaluate((el) => el.setAttribute("aria-checked", "false"));
    expect(await dom.verifyCapture(page, capture)).toBe(false);
    expect(capture.verifiedScopeNodeIds).not.toContain(formId);
    expect(capture.consistencyIssues).toContainEqual(
      expect.objectContaining({ code: "CHECKED_CHANGED" }),
    );
    capture = (await dom.snapshot(page)).structured;
    await page
      .locator("[role=switch]")
      .evaluate((el) => el.replaceWith(el.cloneNode(true)));
    expect(await dom.verifyCapture(page, capture)).toBe(false);
    expect(capture.verifiedScopeNodeIds).not.toContain(formId);
  } finally {
    await browser.close();
  }
});
