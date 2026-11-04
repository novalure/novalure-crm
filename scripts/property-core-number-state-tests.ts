import assert from "node:assert/strict";
import { test } from "node:test";
import { propertyCoreNumberIsKnown, propertyOptionalPriceIsKnown } from "../src/lib/property-core-numbers";

test("legacy zero stays unknown while versioned explicit zero and missing values remain distinct", () => {
  assert.equal(propertyCoreNumberIsKnown({}, "areaSqm", 0), false);
  assert.equal(propertyCoreNumberIsKnown({}, "price", 0), false);
  assert.equal(propertyCoreNumberIsKnown({}, "price", 10), true);
  const payload = { coreNumericState: { version: 1, areaSqm: "known", price: "unknown" } };
  assert.equal(propertyCoreNumberIsKnown(payload, "areaSqm", 0), true);
  assert.equal(propertyCoreNumberIsKnown(payload, "price", 0), false);
  assert.equal(propertyCoreNumberIsKnown(payload, "price", 100), false);
  assert.equal(propertyCoreNumberIsKnown(payload, "areaSqm", null), false);
  assert.equal(propertyCoreNumberIsKnown(payload, "areaSqm", ""), false);
});

test("optional zero prices require their own flag even after an unrelated versioned edit", () => {
  for (const field of ["publicPrice", "rentPrice"] as const) {
    assert.equal(propertyOptionalPriceIsKnown({}, field, 0), false);
    assert.equal(propertyOptionalPriceIsKnown({}, field, "100"), true);
    const unrelated = { coreNumericState: { version: 1, areaSqm: "known", price: "known" } };
    assert.equal(propertyOptionalPriceIsKnown(unrelated, field, 0), false);
    assert.equal(propertyOptionalPriceIsKnown(unrelated, field, 100), true);
    assert.equal(propertyOptionalPriceIsKnown({ coreNumericState: { version: 1, [field]: "known" } }, field, 0), true);
    assert.equal(propertyOptionalPriceIsKnown({ coreNumericState: { version: 1, [field]: "unknown" } }, field, 100), false);
    for (const value of [null, undefined, "", "bad", -1, 0.1]) assert.equal(propertyOptionalPriceIsKnown(unrelated, field, value), false);
  }
  assert.equal(propertyOptionalPriceIsKnown({ coreNumericState: { version: 1, publicPrice: "known" } }, "rentPrice", 0), false);
  assert.equal(propertyOptionalPriceIsKnown({ coreNumericState: { version: 1, rentPrice: "known" } }, "publicPrice", 0), false);
});
