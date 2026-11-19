import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePropertyCreationInput } from "../src/lib/property-create-validation";

test("creation rejects invalid supplied values before normalization can turn them into unknowns", () => {
  for (const value of [{ areaSqm: "12m2" }, { areaSqm: -1 }, { areaSqm: 1.234 }, { rooms: "3.25" }, { yearBuilt: "2000.5" },
    { price: "garbage" }, { price: -1 }, { fieldValues: { "costs.kaufpreis": "garbage" } },
    { availableFrom: "2026-02-31" }, { contactEmail: "invalid" }, { objectType: "unknown-type" }, { projectId: "invalid" }]) {
    assert.ok(validatePropertyCreationInput(value), JSON.stringify(value));
  }
  for (const value of [{}, { areaSqm: null, price: null }, { areaSqm: 0, price: 0 }, { areaSqm: "52,75", price: "123456,78", rooms: "2,5", yearBuilt: 2020, availableFrom: "2028-02-29" }]) {
    assert.equal(validatePropertyCreationInput(value), null, JSON.stringify(value));
  }
});
