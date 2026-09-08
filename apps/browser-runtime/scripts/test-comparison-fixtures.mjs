import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { chromium } from "playwright";

import {
  oraclePassed,
  scenarios,
  startFixtures,
} from "../../../scripts/local-browser/fixtures.mjs";

for (const scenario of scenarios) {
  test(`comparison fixture: ${scenario.id}`, async (t) => {
    const fixture = await startFixtures(0);
    t.after(() => fixture.close());
    const browser = await chromium.launch({
      channel: "chromium",
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const trial = randomUUID();
    await page.goto(`${fixture.url}/${scenario.id}?trial=${trial}`);
    if (["form", "broken-form"].includes(scenario.id)) {
      const snapshot = await page.locator("body").ariaSnapshot({ mode: "ai" });
      const target = (label) => {
        const line = snapshot
          .split("\n")
          .find((line) => line.includes(`"${label}"`));
        const ref = line?.match(/\[ref=((?:f\d+)?e\d+)\]/u)?.[1];
        assert.ok(ref, `Snapshot must expose ${label}`);
        return page.locator(`aria-ref=${ref}`);
      };
      // Reuse one observed ref set through the complete form, as the Agent
      // should be able to do without taking a snapshot after every field.
      await target("Name").fill("Ada");
      await target("Quantity").fill("2");
      await target("Newsletter").check();
      await target("Submit order").click();
      const expectedTotal = scenario.id === "broken-form" ? 21 : 42;
      await page
        .getByRole("status")
        .filter({ hasText: `total $${expectedTotal}` })
        .waitFor();
    } else if (scenario.id === "frames-tabs") {
      const popupPromise = page.waitForEvent("popup");
      await page.getByRole("link", { name: "Shipping instructions" }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      assert.match(await popup.locator("body").innerText(), /PICKUP-731/u);
      const frame = page.frameLocator("iframe");
      await frame.getByLabel("Pickup code").fill("PICKUP-731");
      await frame.getByRole("button", { name: "Confirm pickup" }).click();
      await frame
        .getByRole("status")
        .filter({ hasText: "Pickup confirmed" })
        .waitFor();
    } else if (scenario.id === "long-workflow") {
      const content = await page.locator("body").innerText();
      assert.ok(Buffer.byteLength(content) > 32 * 1024);
      const reservation = content.match(/Reservation number: (RES-\S+)/u)[1];
      await page.getByRole("link", { name: "Start checkout" }).click();
      for (let step = 2; step <= 8; step += 1) {
        await page
          .getByRole("link", { name: `Continue to step ${step}` })
          .click();
      }
      await page.getByLabel("Reservation number").fill(reservation);
      await page.getByRole("button", { name: "Confirm reservation" }).click();
      await page
        .getByRole("status")
        .filter({ hasText: "Reservation confirmed" })
        .waitFor();
    } else {
      const networkResponse = page.waitForResponse((response) =>
        response.url().includes("/api/availability"),
      );
      await page.getByRole("button", { name: "Check availability" }).click();
      const response = await networkResponse;
      assert.equal(response.status(), 200);
      assert.deepEqual(await response.json(), { available: true });
      await page.getByRole("status").filter({ hasText: "Available" }).waitFor();
    }
    const state = await (
      await fetch(`${fixture.url}/__results?trial=${trial}`)
    ).json();
    assert.equal(oraclePassed(scenario.id, state), true);
    const untouched = await (
      await fetch(`${fixture.url}/__results?trial=untouched`)
    ).json();
    assert.equal(oraclePassed(scenario.id, untouched), false);
  });
}
