import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFinancialPolicyApplicable,
  buildCompleteFinancialSnapshot,
  buildLegacyNeedsReviewSnapshot,
  canonicalFinancialPolicyContent,
  financialPolicyContentHash,
  FinancialSnapshotError,
  roundRationalMinorUnits,
  type FinancialPolicyPayload,
  type ResolvedFinancialPolicy,
} from "../src/lib/financial-snapshot";
import { financialSnapshotHash } from "../src/lib/evelyn-money-tax-v2";
import { MAX_CRM_JSON_BODY_BYTES, readBoundedCrmJson } from "../src/lib/crm-request-body";

const INSTANT = "2026-09-18T12:00:00.000Z";
const id = (value: number) => `30000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const contentHash = (digit: string) => digit.repeat(64);
const reference = (name: string, version = "1") => ({ id: `SYNTHETIC:${name}`, version, contentHash: contentHash("a") });

const commandError = (code: string, status: number) => (error: unknown) => Boolean(
  error && typeof error === "object" && "code" in error && "status" in error
    && error.code === code && error.status === status,
);

function resolvedPolicy(name: string, version: string, payload: FinancialPolicyPayload): ResolvedFinancialPolicy {
  return {
    reference: { id: `SYNTHETIC:${name}`, version, contentHash: financialPolicyContentHash(payload) },
    payload,
  } as ResolvedFinancialPolicy;
}

function currencyPolicy(code = "EUR", exponent = 2): ResolvedFinancialPolicy {
  return resolvedPolicy("currency", "2026-09-18", {
    policySchemaVersion: "crm-currency-policy-v1",
    kind: "CURRENCY",
    standard: "ISO-4217",
    code,
    minorUnitExponent: exponent,
    verifiedAt: INSTANT,
  });
}

function roundingPolicy(mode: "TRUNCATE" | "AWAY_FROM_ZERO" | "HALF_UP" | "HALF_EVEN" = "HALF_UP", exponent = 2): ResolvedFinancialPolicy {
  return resolvedPolicy("rounding", "4", {
    policySchemaVersion: "crm-rounding-policy-v1",
    kind: "ROUNDING",
    mode,
    currencyExponent: exponent,
    scope: "TAX_COMPONENT",
  });
}

test("bounded CRM JSON reader rejects declared and streamed overflow before unbounded buffering", async t => {
  await t.test("valid JSON remains available", async () => {
    const value = await readBoundedCrmJson(new Request("https://synthetic.invalid", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ synthetic: true }),
    }));
    assert.deepEqual(value, { synthetic: true });
  });

  await t.test("oversized Content-Length fails before a reader is acquired", async () => {
    let readerAcquired = false;
    const request = {
      headers: new Headers({
        "content-type": "application/json",
        "content-length": String(MAX_CRM_JSON_BODY_BYTES + 1),
      }),
      bodyUsed: false,
      body: { getReader() { readerAcquired = true; throw new Error("reader must not be acquired"); } },
    } as unknown as Request;
    await assert.rejects(readBoundedCrmJson(request), commandError("BODY_TOO_LARGE", 413));
    assert.equal(readerAcquired, false);
  });

  await t.test("stream overflow is cancelled immediately", async () => {
    const chunks = [new Uint8Array(MAX_CRM_JSON_BODY_BYTES), new Uint8Array(1)];
    let readIndex = 0;
    let cancelledWith: unknown;
    const request = {
      headers: new Headers({ "content-type": "application/json" }),
      bodyUsed: false,
      body: {
        getReader() {
          return {
            async read() {
              const value = chunks[readIndex++];
              return value ? { done: false as const, value } : { done: true as const, value: undefined };
            },
            async cancel(reason: unknown) { cancelledWith = reason; },
          };
        },
      },
    } as unknown as Request;
    await assert.rejects(readBoundedCrmJson(request), commandError("BODY_TOO_LARGE", 413));
    assert.equal(readIndex, 2);
    assert.equal(cancelledWith, "BODY_TOO_LARGE");
  });

  await t.test("invalid Content-Length is controlled", async () => {
    const request = new Request("https://synthetic.invalid", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "not-a-number" },
      body: "{}",
    });
    await assert.rejects(readBoundedCrmJson(request), commandError("INVALID_CONTENT_LENGTH", 400));
  });
});

function taxPolicy(
  name: string,
  jurisdiction: string,
  numerator: string,
  denominator: string,
  options: { version?: string; effectiveFrom?: string; effectiveTo?: string | null } = {},
): ResolvedFinancialPolicy {
  const version = options.version ?? "1";
  return resolvedPolicy(name, version, {
    policySchemaVersion: "crm-tax-policy-v1",
    kind: "TAX",
    jurisdiction,
    treatment: `SYNTHETIC:${name}:treatment`,
    category: `SYNTHETIC:${name}:category`,
    rate: { basis: "NET", numerator, denominator },
    sourceProvenance: {
      authority: "SYNTHETIC policy authority",
      sourceReference: `SYNTHETIC:${name}:source`,
      jurisdiction,
      effectiveFrom: options.effectiveFrom ?? "2026-01-01T00:00:00.000Z",
      effectiveTo: options.effectiveTo ?? null,
      policyVersion: version,
      verifiedAt: INSTANT,
    },
  });
}

function fixture() {
  const currency = currencyPolicy();
  const rounding = roundingPolicy();
  const primaryTax = taxPolicy("tax-primary", "AT:TAX", "1", "5");
  const surcharge = taxPolicy("tax-surcharge", "AT:SURCHARGE", "1", "10");
  const input = {
    snapshotId: id(1),
    businessVersion: 1,
    tenantId: id(2),
    resourceId: id(3),
    effectiveAt: INSTANT,
    jurisdiction: "AT:BUSINESS",
    currencyPolicy: { id: currency.reference.id, version: currency.reference.version },
    roundingPolicy: { id: rounding.reference.id, version: rounding.reference.version },
    pricingReference: reference("accepted-offer", "9"),
    provenance: {
      sourceSystem: "SYNTHETIC CRM",
      sourceRecordId: id(4),
      sourceVersion: "11",
      sourceHash: contentHash("6"),
      recordedAt: INSTANT,
      recordedBy: id(5),
    },
    lines: [{
      componentId: "line-z",
      kind: "LINE",
      netMinorUnits: "100",
      pricingReference: reference("line-price"),
      taxComponents: [
        { componentId: "tax-z", policy: { id: primaryTax.reference.id, version: primaryTax.reference.version }, jurisdiction: "AT:TAX" },
        { componentId: "tax-y", policy: { id: surcharge.reference.id, version: surcharge.reference.version }, jurisdiction: "AT:SURCHARGE" },
      ],
    }],
    policies: [currency, rounding, primaryTax, surcharge],
  };
  return { input, currency, rounding, primaryTax, surcharge };
}

function expectCode(operation: () => unknown, code: FinancialSnapshotError["code"]): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof FinancialSnapshotError);
    assert.equal(error.code, code);
    return true;
  });
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseObjectKeys(nested)]));
}

test("policy content hashing is canonical, domain separated and pinned", () => {
  const payload = currencyPolicy().payload;
  const canonical = canonicalFinancialPolicyContent(payload);
  assert.equal(canonical,
    "{\"hashContractVersion\":\"crm-financial-policy-content-hash-v1\",\"policy\":{\"code\":\"EUR\",\"kind\":\"CURRENCY\",\"minorUnitExponent\":2,\"policySchemaVersion\":\"crm-currency-policy-v1\",\"standard\":\"ISO-4217\",\"verifiedAt\":\"2026-09-18T12:00:00.000Z\"}}");
  assert.equal(financialPolicyContentHash(payload), "d343ef3595f49cdf5e312702c053371f4b22c0efd7fb0d7696a758530b2c6ee5");
  assert.equal(financialPolicyContentHash(reverseObjectKeys(payload)), financialPolicyContentHash(payload));
  assert.notEqual(financialPolicyContentHash({ ...payload, minorUnitExponent: 3 }), financialPolicyContentHash(payload));
});

test("BigInt rational rounding covers every mode, negative values and ties", () => {
  const cases = [
    ["5", "1", "2", "TRUNCATE", "2"],
    ["-5", "1", "2", "TRUNCATE", "-2"],
    ["5", "1", "2", "AWAY_FROM_ZERO", "3"],
    ["-5", "1", "2", "AWAY_FROM_ZERO", "-3"],
    ["5", "1", "2", "HALF_UP", "3"],
    ["-5", "1", "2", "HALF_UP", "-3"],
    ["5", "1", "2", "HALF_EVEN", "2"],
    ["-5", "1", "2", "HALF_EVEN", "-2"],
    ["7", "1", "2", "HALF_EVEN", "4"],
    ["-7", "1", "2", "HALF_EVEN", "-4"],
    ["4", "1", "3", "HALF_UP", "1"],
    ["5", "1", "3", "HALF_UP", "2"],
    ["100", "1", "5", "HALF_EVEN", "20"],
  ] as const;
  for (const [minorUnits, numerator, denominator, mode, expected] of cases) {
    assert.equal(roundRationalMinorUnits(minorUnits, numerator, denominator, mode), expected);
  }
  expectCode(() => roundRationalMinorUnits("1", "1", "0", "HALF_UP"), "INVALID_INPUT");
  expectCode(() => roundRationalMinorUnits("1.5", "1", "2", "HALF_UP"), "INVALID_INPUT");
});

test("complete builder computes multi-tax component and document totals from server net only", () => {
  const { input } = fixture();
  const built = buildCompleteFinancialSnapshot(input);
  assert.equal(built.snapshot.reviewState, "COMPLETE");
  assert.deepEqual(built.snapshot.components[0]?.taxComponents.map(component => [component.componentId, component.amount.minorUnits]), [
    ["tax-y", "10"],
    ["tax-z", "20"],
  ]);
  assert.deepEqual({
    net: built.snapshot.totals.net.minorUnits,
    tax: built.snapshot.totals.tax.minorUnits,
    gross: built.snapshot.totals.gross.minorUnits,
  }, { net: "100", tax: "30", gross: "130" });
  assert.equal(built.snapshotHash, financialSnapshotHash(built.snapshot));
  assert.ok(Object.isFrozen(built.snapshot));
  assert.ok(Object.isFrozen(built.snapshot.components));

  const forged = structuredClone(input) as typeof input & { totals?: unknown };
  forged.totals = { net: "1", tax: "0", gross: "1" };
  expectCode(() => buildCompleteFinancialSnapshot(forged), "INVALID_INPUT");
  const forgedLine = structuredClone(input) as typeof input;
  Object.assign(forgedLine.lines[0], { taxMinorUnits: "999", grossMinorUnits: "999" });
  expectCode(() => buildCompleteFinancialSnapshot(forgedLine), "INVALID_INPUT");
});

test("component identity, sign, jurisdiction and maximum-cardinality boundaries fail closed", () => {
  const duplicate = fixture().input;
  duplicate.lines.push(structuredClone(duplicate.lines[0]));
  expectCode(() => buildCompleteFinancialSnapshot(duplicate), "INVALID_SNAPSHOT");

  const negativeLine = fixture().input;
  negativeLine.lines[0].netMinorUnits = "-100";
  expectCode(() => buildCompleteFinancialSnapshot(negativeLine), "INVALID_SNAPSHOT");

  const positiveDiscount = fixture().input;
  positiveDiscount.lines[0].kind = "DISCOUNT";
  expectCode(() => buildCompleteFinancialSnapshot(positiveDiscount), "INVALID_SNAPSHOT");

  const missingJurisdiction = structuredClone(fixture().input) as unknown as Record<string, unknown>;
  Reflect.deleteProperty(missingJurisdiction, "jurisdiction");
  expectCode(() => buildCompleteFinancialSnapshot(missingJurisdiction), "INVALID_INPUT");

  const maximum = fixture().input;
  maximum.lines = Array.from({ length: 100 }, (_, index) => {
    const line = structuredClone(maximum.lines[0]);
    const suffix = String(index + 1).padStart(3, "0");
    line.componentId = `line-${suffix}`;
    line.taxComponents[0].componentId = `tax-primary-${suffix}`;
    line.taxComponents[1].componentId = `tax-surcharge-${suffix}`;
    return line;
  });
  const built = buildCompleteFinancialSnapshot(maximum);
  assert.equal(built.snapshot.components.length, 100);
  assert.deepEqual({
    net: built.snapshot.totals.net.minorUnits,
    tax: built.snapshot.totals.tax.minorUnits,
    gross: built.snapshot.totals.gross.minorUnits,
  }, { net: "10000", tax: "3000", gross: "13000" });

  const overMaximum = structuredClone(maximum);
  const extra = structuredClone(overMaximum.lines[0]);
  extra.componentId = "line-101";
  extra.taxComponents[0].componentId = "tax-primary-101";
  extra.taxComponents[1].componentId = "tax-surcharge-101";
  overMaximum.lines.push(extra);
  expectCode(() => buildCompleteFinancialSnapshot(overMaximum), "INVALID_INPUT");
});

test("policy resolution fails closed for unknown, kind, hash, version, jurisdiction, interval and exponent mismatches", () => {
  const unknown = fixture().input;
  unknown.lines[0].taxComponents[0].policy.id = "SYNTHETIC:unknown";
  expectCode(() => buildCompleteFinancialSnapshot(unknown), "UNKNOWN_POLICY");

  const wrongKind = fixture().input;
  wrongKind.lines[0].taxComponents[0].policy = { ...wrongKind.roundingPolicy };
  expectCode(() => buildCompleteFinancialSnapshot(wrongKind), "POLICY_KIND_MISMATCH");

  const badHash = fixture().input;
  const badHashTax = badHash.policies.find(policy => policy.payload.kind === "TAX");
  assert.ok(badHashTax);
  badHashTax.reference.contentHash = "0".repeat(64);
  expectCode(() => buildCompleteFinancialSnapshot(badHash), "POLICY_CONTENT_HASH_MISMATCH");

  const wrongVersion = fixture().input;
  const versionedTax = wrongVersion.policies.find(policy => policy.payload.kind === "TAX");
  assert.ok(versionedTax);
  versionedTax.reference.version = "2";
  wrongVersion.lines[0].taxComponents[0].policy.version = "2";
  expectCode(() => buildCompleteFinancialSnapshot(wrongVersion), "POLICY_VERSION_MISMATCH");

  const wrongJurisdiction = fixture().input;
  wrongJurisdiction.lines[0].taxComponents[0].jurisdiction = "AT:OTHER";
  expectCode(() => buildCompleteFinancialSnapshot(wrongJurisdiction), "POLICY_JURISDICTION_MISMATCH");

  const expiredFixture = fixture();
  const expired = taxPolicy("tax-primary", "AT:TAX", "1", "5", { effectiveTo: "2026-09-18T12:00:00.000Z" });
  expiredFixture.input.policies = expiredFixture.input.policies.map(policy =>
    policy.reference.id === expiredFixture.primaryTax.reference.id ? expired : policy);
  expectCode(() => buildCompleteFinancialSnapshot(expiredFixture.input), "POLICY_NOT_EFFECTIVE");

  const wrongExponentFixture = fixture();
  const exponentThree = roundingPolicy("HALF_UP", 3);
  wrongExponentFixture.input.policies = wrongExponentFixture.input.policies.map(policy =>
    policy.payload.kind === "ROUNDING" ? exponentThree : policy);
  expectCode(() => buildCompleteFinancialSnapshot(wrongExponentFixture.input), "CURRENCY_EXPONENT_MISMATCH");
});

test("policy applicability never derives jurisdiction from currency", () => {
  const tax = taxPolicy("tax-primary", "AT:TAX", "1", "5");
  assert.equal(assertFinancialPolicyApplicable(tax, {
    expectedKind: "TAX",
    jurisdiction: "AT:TAX",
    effectiveAt: INSTANT,
  }).payload.kind, "TAX");
  expectCode(() => assertFinancialPolicyApplicable(tax, {
    expectedKind: "TAX",
    jurisdiction: "DE:TAX",
    effectiveAt: INSTANT,
  }), "POLICY_JURISDICTION_MISMATCH");
});

test("78-digit minor units are preserved and computed overflow is denied", () => {
  const maximum = "9".repeat(78);
  const zeroFixture = fixture();
  const zeroTax = taxPolicy("tax-primary", "AT:TAX", "0", "1");
  zeroFixture.input.policies = zeroFixture.input.policies
    .filter(policy => policy.reference.id !== zeroFixture.surcharge.reference.id)
    .map(policy => policy.reference.id === zeroFixture.primaryTax.reference.id ? zeroTax : policy);
  zeroFixture.input.lines[0].netMinorUnits = maximum;
  zeroFixture.input.lines[0].taxComponents = [zeroFixture.input.lines[0].taxComponents[0]];
  const built = buildCompleteFinancialSnapshot(zeroFixture.input);
  assert.equal(built.snapshot.totals.net.minorUnits, maximum);
  assert.equal(built.snapshot.totals.tax.minorUnits, "0");
  assert.equal(built.snapshot.totals.gross.minorUnits, maximum);

  const overflowFixture = fixture();
  const fullTax = taxPolicy("tax-primary", "AT:TAX", "1", "1");
  overflowFixture.input.policies = overflowFixture.input.policies
    .filter(policy => policy.reference.id !== overflowFixture.surcharge.reference.id)
    .map(policy => policy.reference.id === overflowFixture.primaryTax.reference.id ? fullTax : policy);
  overflowFixture.input.lines[0].netMinorUnits = maximum;
  overflowFixture.input.lines[0].taxComponents = [overflowFixture.input.lines[0].taxComponents[0]];
  expectCode(() => buildCompleteFinancialSnapshot(overflowFixture.input), "MONEY_OUT_OF_RANGE");
});

test("policy, line and tax input order cannot alter the normalized snapshot hash", () => {
  const firstFixture = fixture();
  const secondLine = structuredClone(firstFixture.input.lines[0]);
  secondLine.componentId = "line-a";
  secondLine.netMinorUnits = "50";
  secondLine.taxComponents[0].componentId = "tax-b";
  secondLine.taxComponents[1].componentId = "tax-a";
  firstFixture.input.lines.push(secondLine);

  const reordered = structuredClone(firstFixture.input);
  reordered.lines.reverse();
  for (const line of reordered.lines) line.taxComponents.reverse();
  reordered.policies.reverse();

  const first = buildCompleteFinancialSnapshot(firstFixture.input);
  const second = buildCompleteFinancialSnapshot(reordered);
  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.deepEqual(first.snapshot.components.map(component => component.componentId), ["line-a", "line-z"]);
  assert.deepEqual(first.snapshot.components[0]?.taxComponents.map(component => component.componentId), ["tax-a", "tax-b"]);
});

test("legacy builder preserves only supplied evidence and declares every unknown dimension", () => {
  const identity = { snapshotId: id(10), businessVersion: 1, tenantId: id(11), resourceId: id(12) };
  const unknown = buildLegacyNeedsReviewSnapshot(identity);
  assert.equal(unknown.snapshot.reviewState, "NEEDS_REVIEW");
  assert.equal(unknown.snapshot.currency, null);
  assert.equal(unknown.snapshot.minorUnitExponent, null);
  assert.deepEqual(unknown.snapshot.totals, { net: null, tax: null, gross: null });
  for (const field of ["currency", "minorUnitExponent", "totals.net", "totals.tax", "totals.gross", "taxPolicy", "roundingPolicy"]) {
    assert.ok(unknown.snapshot.missingFields.includes(field as never));
  }

  const knownNet = buildLegacyNeedsReviewSnapshot({
    ...identity,
    snapshotId: id(13),
    knownNet: { minorUnits: "2037000", currency: "EUR", minorUnitExponent: 2 },
  });
  assert.deepEqual(knownNet.snapshot.totals.net, { minorUnits: "2037000", currency: "EUR", minorUnitExponent: 2 });
  assert.equal(knownNet.snapshot.currency, "EUR");
  assert.equal(knownNet.snapshot.minorUnitExponent, 2);
  assert.equal(knownNet.snapshot.totals.tax, null);
  assert.equal(knownNet.snapshot.totals.gross, null);
  assert.equal(knownNet.snapshot.missingFields.includes("currency"), false);
  assert.equal(knownNet.snapshot.missingFields.includes("totals.net"), false);
  assert.equal(knownNet.snapshotHash, financialSnapshotHash(knownNet.snapshot));

  const knownCurrencyOnly = buildLegacyNeedsReviewSnapshot({
    ...identity,
    snapshotId: id(14),
    knownCurrency: { currency: "USD", minorUnitExponent: 2 },
  });
  assert.equal(knownCurrencyOnly.snapshot.currency, "USD");
  assert.equal(knownCurrencyOnly.snapshot.totals.net, null);
  assert.ok(knownCurrencyOnly.snapshot.missingFields.includes("totals.net"));

  expectCode(() => buildLegacyNeedsReviewSnapshot({
    ...identity,
    snapshotId: id(15),
    knownNet: { minorUnits: "1", currency: "EUR", minorUnitExponent: 2 },
    knownCurrency: { currency: "USD", minorUnitExponent: 2 },
  }), "LEGACY_CURRENCY_MISMATCH");
});
