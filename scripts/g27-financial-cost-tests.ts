import assert from "node:assert/strict";
import test from "node:test";
import { exactCostMinorUnits, reconcileCostTriplet } from "../src/lib/financial-costs";

const missing = () => exactCostMinorUnits(undefined, undefined, "amount");
const cents = (value: string) => exactCostMinorUnits(undefined, value, "amount");

test("G27 cost boundary converts exact decimal strings without floating-point rounding", () => {
  assert.deepEqual(exactCostMinorUnits("20370", undefined, "amount"), {
    minorUnits: "2037000", provided: true, source: "EURO_DECIMAL",
  });
  assert.equal(exactCostMinorUnits("0.01", undefined, "amount").minorUnits, "1");
  assert.equal(exactCostMinorUnits("10.1", undefined, "amount").minorUnits, "1010");
  assert.equal(exactCostMinorUnits("92233720368547758.07", undefined, "amount").minorUnits, "9223372036854775807");
  assert.equal(exactCostMinorUnits("20370.00", "2037000", "amount").minorUnits, "2037000");
});

test("G27 cost boundary rejects ambiguous, rounded, unsafe and mismatched representations", () => {
  for (const invalid of ["01", "1.001", "1e2", " 1", "+1", "-1", "1,20", "NaN", "Infinity"]) {
    assert.throws(() => exactCostMinorUnits(invalid, undefined, "amount"), { code: "INVALID_MONEY" });
  }
  for (const invalid of ["01", "1.0", "1e2", " 1", "+1", "-1", "9223372036854775808"]) {
    assert.throws(() => exactCostMinorUnits(undefined, invalid, "amount"), { code: "INVALID_MONEY" });
  }
  assert.throws(() => exactCostMinorUnits("20.37", "2038", "amount"), { code: "MONEY_REPRESENTATION_MISMATCH" });
  assert.throws(() => exactCostMinorUnits(0.1, undefined, "amount"), { code: "INVALID_MONEY" });
  assert.throws(() => exactCostMinorUnits(undefined, Number.MAX_SAFE_INTEGER + 1, "amount"), { code: "INVALID_MONEY" });
});

test("G27 cost triples validate or derive exactly one dimension with integer arithmetic", () => {
  const complete = reconcileCostTriplet({ net: cents("1000"), tax: cents("200"), gross: cents("1200") }, "cost");
  assert.deepEqual([complete.net, complete.tax, complete.gross, complete.evidence.complete], ["1000", "200", "1200", true]);
  assert.deepEqual(reconcileCostTriplet({ net: cents("1000"), tax: cents("200"), gross: missing() }, "cost").evidence.derived, ["gross"]);
  assert.deepEqual(reconcileCostTriplet({ net: cents("1000"), tax: missing(), gross: cents("1200") }, "cost").evidence.derived, ["tax"]);
  assert.deepEqual(reconcileCostTriplet({ net: missing(), tax: cents("200"), gross: cents("1200") }, "cost").evidence.derived, ["net"]);
  assert.throws(() => reconcileCostTriplet({ net: cents("1000"), tax: cents("201"), gross: cents("1200") }, "cost"), { code: "MONEY_TOTAL_MISMATCH" });
  assert.throws(() => reconcileCostTriplet({ net: cents("1300"), tax: missing(), gross: cents("1200") }, "cost"), { code: "MONEY_TOTAL_MISMATCH" });
});

test("G27 partial legacy cost evidence remains visibly incomplete instead of inventing fields", () => {
  const partial = reconcileCostTriplet({ net: missing(), tax: missing(), gross: cents("1200") }, "cost");
  assert.equal(partial.evidence.complete, false);
  assert.deepEqual(partial.evidence.provided, { net: false, tax: false, gross: true });
  assert.deepEqual(partial.evidence.derived, []);
});

test("G27 cost reconciliation property loop stays exact at precision boundaries", () => {
  let state = 0x6d2b79f5;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0);
  };
  for (let index = 0; index < 512; index += 1) {
    const net = BigInt(random()) * BigInt(1_000_000) + BigInt(random());
    const tax = BigInt(random()) * BigInt(10_000) + BigInt(random() % 10_000);
    const gross = net + tax;
    const result = reconcileCostTriplet({ net: cents(net.toString()), tax: cents(tax.toString()), gross: missing() }, `cost-${index}`);
    assert.equal(BigInt(result.net) + BigInt(result.tax), BigInt(result.gross));
    assert.equal(result.gross, gross.toString());
  }
});
