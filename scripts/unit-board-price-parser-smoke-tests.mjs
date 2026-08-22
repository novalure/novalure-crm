import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { parseEuroAmountToCents } from "../src/lib/inventory-validation.ts";

const unitBoardSource = fs.readFileSync("src/components/unit-board.tsx", "utf8");

describe("UnitBoard Euro price contract", () => {
  it("delegates filters and mutation drafts to the shared Euro-to-cent parser", () => {
    assert.match(
      unitBoardSource,
      /function parsePrice\(value: string\) \{\s*return parseEuroAmountToCents\(value\);\s*\}/,
    );
    assert.match(unitBoardSource, /priceEuros: string/);
    assert.match(unitBoardSource, /name="priceEuros"/);
    assert.match(unitBoardSource, /step="0\.01"/);
  });

  it("treats empty and invalid input as no price", () => {
    assert.equal(parseEuroAmountToCents(""), null);
    assert.equal(parseEuroAmountToCents("  "), null);
    assert.equal(parseEuroAmountToCents("abc"), null);
    assert.equal(parseEuroAmountToCents("-1"), null);
    assert.equal(parseEuroAmountToCents("1.001"), null);
  });

  it("converts the explicit Euro amount to integer cents without magnitude heuristics", () => {
    assert.equal(parseEuroAmountToCents("0"), 0);
    assert.equal(parseEuroAmountToCents("0.01"), 1);
    assert.equal(parseEuroAmountToCents("750000"), 75_000_000);
    assert.equal(parseEuroAmountToCents("1500000"), 150_000_000);
    assert.equal(parseEuroAmountToCents(1_500_000), 150_000_000);
  });
});
