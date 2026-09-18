import { chromium } from "playwright";
import { expect, it } from "vitest";
import { fillFields } from "./fill-fields.js";

it("stops when a remaining control moves to another form after preflight", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<form id="original"><input id="one"><input id="two"></form><form id="other"></form>',
    );
    const result = await fillFields({
      fields: [
        { ref: "one", text: "saved" },
        { ref: "two", text: "must not run" },
      ],
      locator: (ref) => page.locator(`#${ref}`),
      beforeField: async (ref) => {
        if (ref === "two")
          await page.evaluate(() =>
            document
              .querySelector("#other")!
              .append(document.querySelector("#two")!),
          );
      },
      timeout: () => 1000,
      assertActive: () => {},
    });
    expect(result).toMatchObject({
      status: "PARTIAL",
      fields: [
        { status: "COMPLETED" },
        {
          status: "FAILED",
          error: expect.stringContaining("FORM_SEQUENCE_SCOPE_CHANGED"),
        },
      ],
    });
    expect(await page.locator("#two").inputValue()).toBe("");
  } finally {
    await browser.close();
  }
});

it("reports completed fields and stops immediately when cancellation arrives between fields", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<form><input id="one"><textarea id="two"></textarea></form>',
    );
    let checks = 0;
    const result = await fillFields({
      fields: [
        { ref: "one", text: "saved" },
        { ref: "two", text: "must not run" },
      ],
      locator: (ref) => page.locator(`#${ref}`),
      beforeField: async () => {},
      timeout: () => 1000,
      assertActive: () => {
        if (++checks === 5) throw new Error("CANCELLED");
      },
    });
    expect(result).toMatchObject({
      status: "PARTIAL",
      fields: [
        { ref: "one", status: "COMPLETED" },
        { ref: "two", status: "SKIPPED" },
      ],
    });
    expect(await page.locator("#one").inputValue()).toBe("saved");
    expect(await page.locator("#two").inputValue()).toBe("");
  } finally {
    await browser.close();
  }
});

it.each(["different form", "custom select", "password"])(
  "rejects %s before changing any field",
  async (kind) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<form><input id="one">${kind === "different form" ? '</form><form><input id="two">' : `<input id="two" ${kind === "custom select" ? 'role="combobox"' : 'type="password"'}>`}</form>`,
      );
      await expect(
        fillFields({
          fields: [
            { ref: "one", text: "changed" },
            { ref: "two", text: "changed" },
          ],
          locator: (ref) => page.locator(`#${ref}`),
          beforeField: async () => {},
          timeout: () => 1000,
          assertActive: () => {},
        }),
      ).rejects.toThrow(/FORM_SEQUENCE/);
      expect(await page.locator("#one").inputValue()).toBe("");
    } finally {
      await browser.close();
    }
  },
);
