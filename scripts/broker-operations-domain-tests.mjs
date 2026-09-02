#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function transpiledDataUrl(path, replacements = new Map()) {
  let source = await readFile(new URL(path, import.meta.url), "utf8");
  for (const [specifier, replacement] of replacements) {
    source = source.replaceAll(`"${specifier}"`, JSON.stringify(replacement));
  }
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path,
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}

const contractsUrl = await transpiledDataUrl("../src/lib/broker-flow/contracts.ts");
const matching = await import(await transpiledDataUrl("../src/lib/broker-flow/matching.ts"));
const money = await import(await transpiledDataUrl(
  "../src/lib/broker-flow/money.ts",
  new Map([["./contracts", contractsUrl]]),
));
const states = await import(await transpiledDataUrl(
  "../src/lib/broker-flow/state-machines.ts",
  new Map([["./contracts", contractsUrl]]),
));
const provider = await import(await transpiledDataUrl("../src/lib/broker-flow/provider-policy.ts"));
const closingExport = await import(new URL("../src/lib/broker-flow/closing-export.ts", import.meta.url));

function profile(overrides = {}) {
  return {
    accessibility: "required",
    areaFromSqm: 70,
    areaToSqm: 100,
    budgetFromMinor: BigInt(30000000),
    budgetToMinor: BigInt(50000000),
    desiredLocation: null,
    equipment: ["balcony", "elevator"],
    exclusionCriteria: ["ground floor"],
    id: "11111111-1111-4111-8111-111111111111",
    intentType: "purchase",
    municipality: "Vienna",
    mustHaveCriteria: [],
    niceToHaveCriteria: [],
    objectType: "apartment",
    postalCode: "1010",
    radiusKm: null,
    region: "Vienna",
    roomsFrom: 3,
    roomsTo: 4,
    subObjectType: null,
    targetYieldBasisPoints: null,
    yearBuiltFrom: 1990,
    yearBuiltTo: 2030,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    accessibility: true,
    areaSqm: 84,
    availability: "available",
    equipment: ["balcony", "elevator"],
    id: "22222222-2222-4222-8222-222222222222",
    intentType: "purchase",
    municipality: "Vienna",
    objectType: "apartment",
    postalCode: "1010",
    priceMinor: BigInt(42000000),
    region: "Vienna",
    rooms: 3,
    searchableText: "quiet terrace sauna",
    subObjectType: "condominium",
    targetKind: "unit",
    yieldBasisPoints: null,
    yearBuilt: 2018,
    ...overrides,
  };
}

test("matching is deterministic, explainable and availability does not alter its criteria score", () => {
  const first = matching.evaluateBrokerMatch(profile(), candidate());
  const second = matching.evaluateBrokerMatch(profile(), candidate());
  assert.deepEqual(first, second);
  assert.equal(first.score, 100);
  assert.equal(first.eligible, true);
  assert.ok(first.matchedCriteria.length >= 8);
  assert.equal(first.violatedCriteria.length, 0);

  const unavailable = matching.evaluateBrokerMatch(profile(), candidate({ availability: "reserved_other" }));
  assert.equal(unavailable.score, first.score);
  assert.equal(unavailable.eligible, false);
  assert.equal(unavailable.availability, "reserved_other");
  assert.equal(matching.evaluateBrokerMatch(profile(), candidate({ availability: "reserved_same" })).eligible, true);
});

test("matching reports violated and exclusion criteria without false positives", () => {
  const mismatch = matching.evaluateBrokerMatch(profile(), candidate({
    areaSqm: 50,
    equipment: ["ground floor"],
    municipality: "Graz",
    postalCode: "8010",
    region: "Styria",
  }));
  assert.equal(mismatch.score, 0);
  assert.equal(mismatch.eligible, false);
  assert.ok(mismatch.violatedCriteria.some((criterion) => criterion.criterion === "location"));
  assert.ok(mismatch.violatedCriteria.some((criterion) => criterion.criterion === "exclusion"));
});

test("matching normalizes sale intent and compound desired locations", () => {
  const match = matching.evaluateBrokerMatch(
    profile({ desiredLocation: "Vienna 1010", municipality: null, postalCode: null, region: null }),
    candidate({ intentType: "sale" }),
  );
  assert.equal(match.eligible, true);
  assert.ok(match.matchedCriteria.some((criterion) => criterion.criterion === "intent"));
  assert.ok(match.matchedCriteria.some((criterion) => criterion.criterion === "location"));
});

test("percentage commission allocation is exact, deterministic and conserves minor units", () => {
  const splits = money.validateCommissionSplits({
    buyerCommissionMinor: BigInt(10001),
    sellerCommissionMinor: BigInt(20001),
  }, [
    { allocationType: "percentage", amountMinor: null, basisPoints: 3333, label: "A", side: "buyer", sourceSide: "buyer", userId: null },
    { allocationType: "percentage", amountMinor: null, basisPoints: 6667, label: "B", side: "buyer", sourceSide: "buyer", userId: null },
    { allocationType: "percentage", amountMinor: null, basisPoints: 10000, label: "C", side: "seller", sourceSide: "seller", userId: null },
  ]);
  assert.equal(splits.reduce((sum, split) => sum + split.computedAmountMinor, BigInt(0)), BigInt(30002));
  assert.deepEqual(splits.map((split) => split.computedAmountMinor.toString()), ["3333", "6668", "20001"]);
});

test("commission validation rejects non-exact percentages, absolute totals and money identities", () => {
  assert.throws(() => money.validateCommissionSplits({ buyerCommissionMinor: BigInt(100), sellerCommissionMinor: BigInt(0) }, [
    { allocationType: "percentage", amountMinor: null, basisPoints: 9999, label: "Agent", side: "buyer", sourceSide: "buyer", userId: null },
  ]), /10000 basis points/);
  assert.throws(() => money.validateCommissionSplits({ buyerCommissionMinor: BigInt(100), sellerCommissionMinor: BigInt(0) }, [
    { allocationType: "absolute", amountMinor: BigInt(99), basisPoints: null, label: "Agent", side: "buyer", sourceSide: "buyer", userId: null },
  ]), /buyer commission exactly/);
  assert.throws(() => money.validateClosingMoney({
    baseAmountMinor: BigInt(1_000),
    buyerCommissionMinor: BigInt(60),
    grossCommissionMinor: BigInt(100),
    netCommissionMinor: BigInt(80),
    sellerCommissionMinor: BigInt(40),
    taxMinor: BigInt(19),
  }), /Net commission plus tax/);
  assert.throws(() => money.validateClosingMoney({
    baseAmountMinor: BigInt(99),
    buyerCommissionMinor: BigInt(60),
    grossCommissionMinor: BigInt(100),
    netCommissionMinor: BigInt(80),
    sellerCommissionMinor: BigInt(40),
    taxMinor: BigInt(20),
  }), /cannot exceed/);
  assert.throws(() => money.parseMinorUnits(Number.MAX_SAFE_INTEGER + 1, "amount"), /exact/);
  assert.throws(() => money.parseCommissionSplits([{
    allocationType: "absolute",
    amountMinor: "100",
    side: "buyer",
  }], () => null), /userId or label/);
  assert.throws(() => money.parseCommissionSplits([{
    allocationType: "absolute",
    amountMinor: "100",
    label: "Referral",
    side: "referral",
  }], () => null), /sourceSide must identify/);
});

test("referrals are attributed to and reconciled within an explicit source side", () => {
  const parsed = money.parseCommissionSplits([
    { allocationType: "percentage", basisPoints: 7_500, label: "Buyer agent", side: "buyer" },
    { allocationType: "percentage", basisPoints: 2_500, label: "Referral", side: "referral", sourceSide: "buyer" },
    { allocationType: "percentage", basisPoints: 10_000, label: "Seller agent", side: "seller" },
  ], () => null);
  const validated = money.validateCommissionSplits({
    buyerCommissionMinor: BigInt(101),
    sellerCommissionMinor: BigInt(99),
  }, parsed);

  assert.deepEqual(validated.map((split) => ({
    computedAmountMinor: split.computedAmountMinor,
    side: split.side,
    sourceSide: split.sourceSide,
  })), [
    { computedAmountMinor: BigInt(76), side: "buyer", sourceSide: "buyer" },
    { computedAmountMinor: BigInt(25), side: "referral", sourceSide: "buyer" },
    { computedAmountMinor: BigInt(99), side: "seller", sourceSide: "seller" },
  ]);
});

test("state machines reject skips and terminal-state mutations", () => {
  assert.doesNotThrow(() => states.assertTransition(states.searchProfileTransitions, "draft", "active", "profile"));
  assert.throws(() => states.assertTransition(states.closingTransitions, "draft", "paid", "closing"), /cannot transition/);
  assert.throws(() => states.assertTransition(states.viewingTransitions, "completed", "planned", "viewing"), /cannot transition/);
  assert.throws(() => states.assertTransition(states.offerTransitions, "withdrawn", "draft", "offer"), /cannot transition/);
  assert.throws(() => states.assertInitialState("ready", "draft", "offer"), /must start/);
  assert.throws(() => states.assertMutableState("archived", ["archived"], "profile"), /immutable/);
});

test("must-have requirements are hard while nice-to-have criteria remain explainable", () => {
  const missingMust = matching.evaluateBrokerMatch(
    profile({ mustHaveCriteria: ["fireplace"], niceToHaveCriteria: ["pool"] }),
    candidate(),
  );
  assert.equal(missingMust.eligible, false);
  assert.ok(missingMust.violatedCriteria.some((criterion) => criterion.criterion === "must_have" && criterion.hard));
  assert.ok(missingMust.violatedCriteria.some((criterion) => criterion.criterion === "nice_to_have" && !criterion.hard));
});

test("radius matching fails closed while verified coordinates are unavailable", () => {
  const match = matching.evaluateBrokerMatch(profile({ radiusKm: 5 }), candidate());
  assert.equal(match.eligible, false);
  assert.ok(match.violatedCriteria.some((criterion) => criterion.criterion === "radius" && criterion.hard));
});

test("QA delivery is fail-closed even when the target and feature flag look configured", () => {
  assert.equal(provider.evaluateQaOfferDelivery("qa@novalure.eu", {}).code, "qa_delivery_disabled");
  assert.equal(provider.evaluateQaOfferDelivery("outside@example.com", {
    NOVALURE_BROKER_OFFER_QA_ENABLED: "true",
    NOVALURE_QA_EMAIL_ALLOWLIST: "qa@novalure.eu",
  }).code, "qa_target_not_allowed");
  const configured = provider.evaluateQaOfferDelivery("QA@novalure.eu", {
    NOVALURE_BROKER_OFFER_QA_ENABLED: "true",
    NOVALURE_QA_EMAIL_ALLOWLIST: "qa@novalure.eu",
  });
  assert.equal(configured.code, "provider_adapter_unavailable");
  assert.equal(configured.allowed, false);
});

test("closing CSV and PDF exports are generated server-side with safe spreadsheet cells", () => {
  const records = [{
    baseAmountMinor: "50000000",
    buyerCommissionMinor: "1800000",
    closingDate: "2026-09-02",
    commissionSplits: [{ allocationType: "percentage", basisPoints: 10_000, side: "buyer" }],
    contractDate: "2026-09-01",
    contractType: "purchase",
    currency: "EUR",
    grossCommissionMinor: "3600000",
    id: "=2+2",
    netCommissionMinor: "3000000",
    paymentStatus: "open",
    projectId: "11111111-1111-4111-8111-111111111111",
    sellerCommissionMinor: "1800000",
    status: "reviewed",
    taxMinor: "600000",
  }];
  const csv = closingExport.buildClosingCsv(records);
  assert.ok(csv.includes(`"'=2+2"`));
  assert.match(csv, /commission_splits_json/);

  const pdf = closingExport.buildClosingPdf(records, new Date("2026-09-02T12:00:00.000Z"));
  assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.byteLength > 3_000);
});
