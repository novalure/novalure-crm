import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { DirectPropertyNumericDraftError, normalizeDirectPropertyNumericDraft } from "../src/lib/property-direct-numeric";
import { parsePropertyEuroCents } from "../src/lib/property-money";

test("local native DOM preserves trailing-zero payload strings despite different numeric semantics", { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const requests: string[] = [];
    context.on("request", request => requests.push(request.url()));
    await context.route("**/*", route => route.abort());
    const page = await context.newPage();
    await page.setContent('<form><input name="price" type="number" min="0" step="0.01"></form>');
    for (const [raw, numeric, valid, canonical, cents] of [["1.000", 1, true, "1", 100], ["1.010", 1.01, true, "1.01", 101], ["1.001", 1.001, false, null, null], ["1e3", 1000, true, null, null]] as const) {
      const result = await page.evaluate(raw => {
        const input = document.querySelector("input")!;
        input.value = raw;
        // React's event.target.value and the direct form's draft spread retain
        // this string; JSON serialization does not apply valueAsNumber.
        const payload = JSON.stringify({ price: input.value });
        return { value: input.value, numeric: input.valueAsNumber, valid: input.checkValidity(), stepMismatch: input.validity.stepMismatch, payload };
      }, raw);
      assert.equal(result.value, raw); assert.equal(result.numeric, numeric); assert.equal(result.valid, valid);
      const payload = JSON.parse(result.payload) as { price: string };
      assert.equal(payload.price, raw);
      if (canonical === null) {
        assert.throws(() => normalizeDirectPropertyNumericDraft(payload), (error: unknown) => error instanceof DirectPropertyNumericDraftError && error.code === (raw.includes("e") ? "UNSUPPORTED_EXPONENT" : "EXCESS_PRECISION"));
      } else {
        assert.notEqual(parsePropertyEuroCents(payload.price), cents);
        const normalized = normalizeDirectPropertyNumericDraft(payload);
        assert.equal(normalized.price, canonical); assert.equal(parsePropertyEuroCents(normalized.price), cents);
      }
    }
    assert.deepEqual(requests, []);
  } finally { await browser.close(); }
});
