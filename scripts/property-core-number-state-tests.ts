import assert from "node:assert/strict";
import { test } from "node:test";
import { propertyCoreNumberIsKnown } from "../src/lib/property-core-numbers";

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
