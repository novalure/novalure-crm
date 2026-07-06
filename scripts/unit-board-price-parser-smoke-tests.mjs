import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

function loadParsePrice() {
  const source = fs.readFileSync("src/components/unit-board.tsx", "utf8");
  const match = source.match(/function parsePrice\(value: string\) \{[\s\S]*?\n\}/);
  assert.ok(match, "parsePrice helper must exist in UnitBoard");

  const js = `${match[0].replace(/: string/g, "")}\nparsePrice;`;
  return vm.runInNewContext(js, {}, { filename: "unit-board.parsePrice.test.js" });
}

const parsePrice = loadParsePrice();

describe("UnitBoard price filter parser", () => {
  it("treats empty and invalid input as no price filter", () => {
    assert.equal(parsePrice(""), null);
    assert.equal(parsePrice("  "), null);
    assert.equal(parsePrice("abc"), null);
  });

  it("keeps valid Euro input semantics and rejects negative values", () => {
    assert.equal(parsePrice("0"), 0);
    assert.equal(parsePrice("750000"), 75_000_000);
    assert.equal(parsePrice("-1"), null);
  });
});