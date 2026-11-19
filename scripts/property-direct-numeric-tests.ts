import assert from "node:assert/strict";
import { test } from "node:test";
import { DirectPropertyNumericDraftError, normalizeDirectPropertyNumericDraft } from "../src/lib/property-direct-numeric";
import { parsePropertyEuroCents } from "../src/lib/property-money";

test("native dot-decimal strings cannot become EUR grouping, and generic German text semantics remain", () => {
  assert.equal(parsePropertyEuroCents("1.000"), 100_000);
  assert.equal(parsePropertyEuroCents("1.010"), 101_000);
  const normalized = normalizeDirectPropertyNumericDraft({ price: "1.000", publicPrice: "1.010", rentPrice: "00012.3400", rentNet: ".50", monthlyCostsGross: "0.000", purchaseAncillaryCosts: "001000.000" });
  assert.deepEqual(normalized, { price: "1", publicPrice: "1.01", rentPrice: "12.34", rentNet: "0.5", monthlyCostsGross: "0", purchaseAncillaryCosts: "1000" });
  assert.equal(parsePropertyEuroCents(normalized.price), 100);
  assert.equal(parsePropertyEuroCents(normalized.publicPrice), 101);
  assert.equal(parsePropertyEuroCents("1.234,56 €"), 123_456);
});

test("all six cost amount fields normalize without mutating their row or other draft fields", () => {
  const geography = { countryCode: "AT" as const }, fieldValues = { "costs.kaufpreis": "1.000", custom: "1.234,56" };
  const draft = { title: "1.000 remains text", geography, fieldValues, areaSqm: "00080.1000", rooms: "02.500", yearBuilt: "02000.000", costItems: [{ costKey: "synthetic", exposeVisible: false, monthlyNet: "1.000", monthlyVat: "2.0100", monthlyGross: "3.000", oneTimeNet: "4.000", oneTimeVat: "5.010", oneTimeGross: "6.000" }] };
  const result = normalizeDirectPropertyNumericDraft(draft);
  assert.deepEqual([result.areaSqm, result.rooms, result.yearBuilt], ["80.1", "2.5", "2000"]);
  assert.deepEqual(result.costItems[0], { costKey: "synthetic", exposeVisible: false, monthlyNet: "1", monthlyVat: "2.01", monthlyGross: "3", oneTimeNet: "4", oneTimeVat: "5.01", oneTimeGross: "6" });
  assert.notEqual(result, draft); assert.notEqual(result.costItems, draft.costItems); assert.notEqual(result.costItems[0], draft.costItems[0]);
  assert.equal(result.geography, geography); assert.equal(result.fieldValues, fieldValues); assert.equal(result.title, draft.title);
  assert.equal(draft.costItems[0].monthlyNet, "1.000"); assert.equal(draft.areaSqm, "00080.1000");
});

test("blank stays unknown while explicit positive/negative zero becomes explicit zero", () => {
  assert.deepEqual(normalizeDirectPropertyNumericDraft({ price: "", areaSqm: "", rooms: " ", yearBuilt: "", publicPrice: "-0.000", rentPrice: "000.000" }), { price: "", areaSqm: "", rooms: "", yearBuilt: "", publicPrice: "0", rentPrice: "0" });
  assert.deepEqual(normalizeDirectPropertyNumericDraft({}), {});
});

test("nonzero excess precision is rejected for money, area, rooms, year and every cost amount", () => {
  for (const [field, value, scale] of [["price", "1.001", 2], ["areaSqm", "1.0010", 2], ["rooms", "1.010", 1], ["yearBuilt", "2000.01", 0]] as const) {
    assert.throws(() => normalizeDirectPropertyNumericDraft({ [field]: value }), (error: unknown) => error instanceof DirectPropertyNumericDraftError && error.code === "EXCESS_PRECISION" && error.field === field && error.scale === scale);
  }
  for (const field of ["monthlyNet", "monthlyVat", "monthlyGross", "oneTimeNet", "oneTimeVat", "oneTimeGross"]) {
    assert.throws(() => normalizeDirectPropertyNumericDraft({ costItems: [{ [field]: "1.001" }] }), (error: unknown) => error instanceof DirectPropertyNumericDraftError && error.code === "EXCESS_PRECISION" && error.field === `costItems.0.${field}`);
  }
});

test("exponents and locale/text grouping are clearly rejected at the native-number boundary only", () => {
  for (const value of ["1e3", "1E+3", "0.1e-2", "1e"]) {
    assert.throws(() => normalizeDirectPropertyNumericDraft({ price: value }), (error: unknown) => error instanceof DirectPropertyNumericDraftError && error.code === "UNSUPPORTED_EXPONENT");
  }
  for (const value of ["1.234,56", "1,5", "1 000", "EUR 1.00", "Infinity", "NaN", "1.", "+1"]) {
    assert.throws(() => normalizeDirectPropertyNumericDraft({ price: value }), (error: unknown) => error instanceof DirectPropertyNumericDraftError && error.code === "INVALID_FORMAT");
  }
  assert.throws(() => normalizeDirectPropertyNumericDraft({ price: "-1.00" }), (error: unknown) => error instanceof DirectPropertyNumericDraftError && error.code === "NEGATIVE_VALUE");
});

test("safe integer cents stay exact without converting EUR strings to Number", () => {
  for (const [raw, expected, cents] of [["90071992547409.910", "90071992547409.91", Number.MAX_SAFE_INTEGER], ["90071992547409.900", "90071992547409.9", Number.MAX_SAFE_INTEGER - 1], ["090071992547409.010", "90071992547409.01", Number.MAX_SAFE_INTEGER - 90]] as const) {
    const normalized = normalizeDirectPropertyNumericDraft({ price: raw });
    assert.equal(normalized.price, expected); assert.equal(parsePropertyEuroCents(normalized.price), cents);
  }
  assert.throws(() => normalizeDirectPropertyNumericDraft({ price: "90071992547409.92" }), (error: unknown) => error instanceof DirectPropertyNumericDraftError && error.code === "UNSAFE_CENTS");
});
