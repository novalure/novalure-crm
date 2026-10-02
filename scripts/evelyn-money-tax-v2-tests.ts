import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  approvalActionV2Hash,
  approvalActionV2InputSchema,
  approvalActionV2Schema,
  currencyDefinitionSchema,
  economicComponentV1Schema,
  financialSnapshotHash,
  financialSnapshotV1Schema,
  financialSourceProvenanceSchema,
  moneyFromDecimal,
  moneyV2Schema,
  normalizeApprovalActionV2,
  normalizeFinancialSnapshotV1,
  taxComponentV1Schema,
  taxPolicyReferenceSchema,
  taxSourceProvenanceSchema,
  v2ThresholdContext,
  versionedFinancialReferenceSchema,
  type ApprovalActionV2,
  type CompleteFinancialSnapshotV1,
  type FinancialSnapshotV1,
  type MoneyV2,
} from "../src/lib/evelyn-money-tax-v2";

const EVELYN_V2_COMMIT = "1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc";
const EVELYN_REPOSITORY = "C:\\Projects\\evelyn";
const EVELYN_CONTRACT_SOURCE = "src/approval-bridge/money-tax-v2.ts";
const GOLDEN_SNAPSHOT_HASH = "38f8d55c2596589418a2e0c77945bd593f59e1f2c6944b20f4e6a5bd2a17a878";
const GOLDEN_ACTION_HASH = "0af65619511af89dcd49588296207c2521538904d4b4877336bbdfe46cebac0b";
const INSTANT = "2026-09-18T12:00:00.000Z";

type MoneyTaxV2Module = typeof import("../src/lib/evelyn-money-tax-v2");
type SafeSchema = {
  safeParse(input: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: unknown[] } };
};

function git(...args: string[]): string {
  return execFileSync("git", ["-c", `safe.directory=${EVELYN_REPOSITORY}`, "-C", EVELYN_REPOSITORY, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertPinnedFile(file: string): void {
  const committedBlob = git("rev-parse", `${EVELYN_V2_COMMIT}:${file}`);
  const workingBlob = git("hash-object", file);
  assert.equal(
    workingBlob,
    committedBlob,
    `Local Evelyn source differs from ${EVELYN_V2_COMMIT}:${file}`,
  );
}

let evelynContractPromise: Promise<MoneyTaxV2Module> | undefined;
function loadEvelynContract(): Promise<MoneyTaxV2Module> {
  evelynContractPromise ??= (async () => {
    const repositoryRoot = git("rev-parse", "--show-toplevel");
    assert.equal(
      path.normalize(repositoryRoot).toLowerCase(),
      path.normalize(EVELYN_REPOSITORY).toLowerCase(),
      `Expected the Evelyn checkout at ${EVELYN_REPOSITORY}`,
    );
    assert.equal(
      git("rev-parse", "HEAD"),
      EVELYN_V2_COMMIT,
      `Local Evelyn HEAD must be exactly ${EVELYN_V2_COMMIT}`,
    );
    for (const file of [
      EVELYN_CONTRACT_SOURCE,
      "src/domain/integrity.ts",
      "package.json",
      "package-lock.json",
    ]) assertPinnedFile(file);

    const zodPackage = JSON.parse(readFileSync(
      path.join(EVELYN_REPOSITORY, "node_modules", "zod", "package.json"),
      "utf8",
    )) as { version?: unknown };
    assert.equal(zodPackage.version, "4.5.4", "Local Evelyn must execute with its pinned zod 4.5.4 runtime");

    return await import(pathToFileURL(path.join(EVELYN_REPOSITORY, EVELYN_CONTRACT_SOURCE)).href) as MoneyTaxV2Module;
  })();
  return evelynContractPromise;
}

function schemaOutcome(schema: SafeSchema, value: unknown): unknown {
  const result = schema.safeParse(value);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, issues: result.error.issues };
}

function goldenSnapshot(): CompleteFinancialSnapshotV1 {
  const id = (suffix: string) => `20000000-0000-4000-8000-000000000${suffix}`;
  const reference = (name: string, version: string, digit: string) => ({
    id: `SYNTHETIC:${name}`,
    version,
    contentHash: digit.repeat(64),
  });
  const money = (minorUnits: string): MoneyV2 => ({ minorUnits, currency: "EUR", minorUnitExponent: 2 });
  return {
    snapshotSchemaVersion: "financial-snapshot-v1",
    snapshotId: id("201"),
    businessVersion: 1,
    tenantId: id("203"),
    resourceId: id("205"),
    reviewState: "COMPLETE",
    effectiveAt: INSTANT,
    currency: "EUR",
    minorUnitExponent: 2,
    currencyDefinition: {
      standard: "ISO-4217",
      code: "EUR",
      minorUnitExponent: 2,
      registryReference: reference("currency-registry", "2026-09-18", "1"),
      verifiedAt: INSTANT,
    },
    jurisdiction: "SYNTHETIC:BUSINESS",
    components: [{
      componentId: "line-setup",
      kind: "LINE",
      net: money("2037000"),
      tax: money("10000"),
      gross: money("2047000"),
      pricingReference: reference("line-price", "1", "2"),
      taxComponents: [{
        componentId: "tax-setup",
        amount: money("10000"),
        policy: {
          reference: reference("tax-policy", "7", "3"),
          jurisdiction: "SYNTHETIC:TAX",
          sourceProvenance: {
            authority: "SYNTHETIC authority",
            sourceReference: "SYNTHETIC controlled source",
            jurisdiction: "SYNTHETIC:TAX",
            effectiveFrom: "2026-01-01T00:00:00.000Z",
            effectiveTo: null,
            policyVersion: "7",
            verifiedAt: INSTANT,
          },
        },
      }],
    }],
    totals: { net: money("2037000"), tax: money("10000"), gross: money("2047000") },
    roundingPolicy: reference("rounding", "4", "4"),
    pricingReference: reference("accepted-offer", "9", "5"),
    provenance: {
      sourceSystem: "SYNTHETIC CRM",
      sourceRecordId: id("206"),
      sourceVersion: "11",
      sourceHash: "6".repeat(64),
      recordedAt: INSTANT,
      recordedBy: id("207"),
    },
  };
}

function actionFor(financialSnapshot: FinancialSnapshotV1): ApprovalActionV2 {
  const id = (suffix: string) => `20000000-0000-4000-8000-000000000${suffix}`;
  return {
    actionContractVersion: "approval-action-v2",
    actionId: id("301"),
    workflowId: id("302"),
    tenantId: financialSnapshot.tenantId,
    requestingActorId: id("304"),
    correlationId: id("307"),
    actionType: "contract.send",
    resourceType: "Contract",
    resourceId: financialSnapshot.resourceId,
    actionVersion: 1,
    resourceVersion: financialSnapshot.businessVersion,
    payload: {
      recipient: { id: id("306"), email: "synthetic-buyer@example.invalid" },
      contract: { id: financialSnapshot.resourceId, version: 1, content: "SYNTHETIC deterministic V2 contract vector" },
      scope: { projectId: id("308"), description: "SYNTHETIC deterministic Preview-only scope" },
    },
    financialSnapshot,
    financialSnapshotHash: financialSnapshotHash(financialSnapshot),
    economicCommitment: { basis: "NET", amount: financialSnapshot.totals.net },
    environment: "preview",
    synthetic: true,
  };
}

function money(minorUnits: string, currency = "EUR", minorUnitExponent = 2): MoneyV2 {
  return { minorUnits, currency, minorUnitExponent };
}

function switchCurrency(
  source: CompleteFinancialSnapshotV1,
  currency: string,
  minorUnitExponent = 2,
): CompleteFinancialSnapshotV1 {
  const snapshot = structuredClone(source);
  snapshot.currency = currency;
  snapshot.minorUnitExponent = minorUnitExponent;
  snapshot.currencyDefinition.code = currency;
  snapshot.currencyDefinition.minorUnitExponent = minorUnitExponent;
  for (const component of snapshot.components) {
    for (const value of [component.net, component.tax, component.gross]) {
      value.currency = currency;
      value.minorUnitExponent = minorUnitExponent;
    }
    for (const tax of component.taxComponents) {
      tax.amount.currency = currency;
      tax.amount.minorUnitExponent = minorUnitExponent;
    }
  }
  for (const value of Object.values(snapshot.totals)) {
    value.currency = currency;
    value.minorUnitExponent = minorUnitExponent;
  }
  return snapshot;
}

function needsReview(source: CompleteFinancialSnapshotV1): FinancialSnapshotV1 {
  return financialSnapshotV1Schema.parse({
    ...structuredClone(source),
    reviewState: "NEEDS_REVIEW",
    effectiveAt: null,
    currencyDefinition: null,
    components: null,
    totals: { net: structuredClone(source.totals.net), tax: null, gross: null },
    roundingPolicy: null,
    missingFields: ["effectiveAt", "currencyDefinition", "components", "totals.tax", "totals.gross", "roundingPolicy"],
  });
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseObjectKeys(nested)]));
}

test("local Evelyn Money/Tax V2 executes from the exact reviewed commit and source", async () => {
  const evelyn = await loadEvelynContract();
  assert.equal(typeof evelyn.financialSnapshotHash, "function");
  assert.equal(typeof evelyn.approvalActionV2Hash, "function");
  assert.equal(typeof evelyn.normalizeFinancialSnapshotV1, "function");
  assert.equal(typeof evelyn.moneyFromDecimal, "function");
});

test("all public Money/Tax V2 schemas accept and reject the same representative values", async () => {
  const evelyn = await loadEvelynContract();
  const snapshot = goldenSnapshot();
  const component = snapshot.components[0];
  const taxComponent = component.taxComponents[0];
  const action = actionFor(snapshot);
  const actionInput = structuredClone(action) as Record<string, unknown>;
  delete actionInput.environment;
  delete actionInput.synthetic;
  const cases: Array<{ name: string; crm: SafeSchema; evelyn: SafeSchema; value: unknown }> = [
    { name: "MoneyV2", crm: moneyV2Schema, evelyn: evelyn.moneyV2Schema, value: snapshot.totals.net },
    { name: "VersionedFinancialReference", crm: versionedFinancialReferenceSchema, evelyn: evelyn.versionedFinancialReferenceSchema, value: snapshot.roundingPolicy },
    { name: "CurrencyDefinition", crm: currencyDefinitionSchema, evelyn: evelyn.currencyDefinitionSchema, value: snapshot.currencyDefinition },
    { name: "FinancialSourceProvenance", crm: financialSourceProvenanceSchema, evelyn: evelyn.financialSourceProvenanceSchema, value: snapshot.provenance },
    { name: "TaxSourceProvenance", crm: taxSourceProvenanceSchema, evelyn: evelyn.taxSourceProvenanceSchema, value: taxComponent.policy.sourceProvenance },
    { name: "TaxPolicyReference", crm: taxPolicyReferenceSchema, evelyn: evelyn.taxPolicyReferenceSchema, value: taxComponent.policy },
    { name: "TaxComponentV1", crm: taxComponentV1Schema, evelyn: evelyn.taxComponentV1Schema, value: taxComponent },
    { name: "EconomicComponentV1", crm: economicComponentV1Schema, evelyn: evelyn.economicComponentV1Schema, value: component },
    { name: "FinancialSnapshotV1", crm: financialSnapshotV1Schema, evelyn: evelyn.financialSnapshotV1Schema, value: snapshot },
    { name: "ApprovalActionV2Input", crm: approvalActionV2InputSchema, evelyn: evelyn.approvalActionV2InputSchema, value: actionInput },
    { name: "ApprovalActionV2", crm: approvalActionV2Schema, evelyn: evelyn.approvalActionV2Schema, value: action },
  ];

  for (const contract of cases) {
    const crmValid = schemaOutcome(contract.crm, contract.value);
    const evelynValid = schemaOutcome(contract.evelyn, contract.value);
    assert.deepEqual(crmValid, evelynValid, `${contract.name} normalized output differs`);
    assert.equal((crmValid as { success: boolean }).success, true, `${contract.name} representative fixture must be valid`);

    const invalid = {
      ...(structuredClone(contract.value) as Record<string, unknown>),
      unexpectedContractField: true,
    };
    const crmInvalid = schemaOutcome(contract.crm, invalid);
    const evelynInvalid = schemaOutcome(contract.evelyn, invalid);
    assert.deepEqual(crmInvalid, evelynInvalid, `${contract.name} rejection differs`);
    assert.equal((crmInvalid as { success: boolean }).success, false, `${contract.name} must remain strict`);
  }
});

test("CRM and local Evelyn Money/Tax V2 agree on golden normalization and hashes", async () => {
  const evelyn = await loadEvelynContract();
  const snapshot = goldenSnapshot();
  assert.equal(financialSnapshotHash(snapshot), GOLDEN_SNAPSHOT_HASH);
  assert.equal(evelyn.financialSnapshotHash(snapshot), GOLDEN_SNAPSHOT_HASH);
  assert.deepEqual(normalizeFinancialSnapshotV1(snapshot), evelyn.normalizeFinancialSnapshotV1(snapshot));
  assert.equal(approvalActionV2Hash(actionFor(snapshot)), GOLDEN_ACTION_HASH);
  assert.equal(evelyn.approvalActionV2Hash(actionFor(snapshot)), GOLDEN_ACTION_HASH);
  assert.deepEqual(normalizeApprovalActionV2(actionFor(snapshot)), evelyn.normalizeApprovalActionV2(actionFor(snapshot)));
  assert.equal(approvalActionV2Schema.safeParse(actionFor(snapshot)).success, true);
  assert.equal(evelyn.approvalActionV2Schema.safeParse(actionFor(snapshot)).success, true);
});

test("canonical snapshot hashing ignores object and identified-component input order in CRM and Evelyn", async () => {
  const evelyn = await loadEvelynContract();
  const left = goldenSnapshot();
  const primary = left.components[0];
  const secondTax = structuredClone(primary.taxComponents[0]);
  primary.taxComponents[0].componentId = "tax-z";
  primary.taxComponents[0].amount = money("4000");
  secondTax.componentId = "tax-a";
  secondTax.amount = money("6000");
  primary.taxComponents.push(secondTax);

  const zeroLine = structuredClone(primary);
  zeroLine.componentId = "line-a";
  zeroLine.net = money("0");
  zeroLine.tax = money("0");
  zeroLine.gross = money("0");
  zeroLine.taxComponents = [{ ...structuredClone(secondTax), componentId: "tax-zero", amount: money("0") }];
  left.components.unshift(zeroLine);

  const right = structuredClone(left);
  right.components.reverse();
  right.components.find(component => component.componentId === "line-setup")?.taxComponents.reverse();

  assert.equal(financialSnapshotV1Schema.safeParse(left).success, true);
  assert.equal(evelyn.financialSnapshotV1Schema.safeParse(left).success, true);
  assert.equal(financialSnapshotHash(left), financialSnapshotHash(right));
  assert.equal(financialSnapshotHash(left), financialSnapshotHash(reverseObjectKeys(left)));
  assert.equal(evelyn.financialSnapshotHash(left), financialSnapshotHash(left));
  assert.equal(evelyn.financialSnapshotHash(right), financialSnapshotHash(right));
  assert.equal(evelyn.financialSnapshotHash(reverseObjectKeys(left)), financialSnapshotHash(reverseObjectKeys(left)));
  assert.deepEqual(
    normalizeFinancialSnapshotV1(left).components?.map(component => component.componentId),
    ["line-a", "line-setup"],
  );
  assert.deepEqual(normalizeFinancialSnapshotV1(left), evelyn.normalizeFinancialSnapshotV1(left));
});

test("CRM and Evelyn reject the same floating-point authority and malformed MoneyV2 values", async () => {
  const evelyn = await loadEvelynContract();
  for (const minorUnits of [1, 1.1, "-0", "00", "01", "+1", "1.0", "1e2", "", "NaN", "Infinity", " 1"]) {
    const value = { ...money("1"), minorUnits };
    assert.equal(moneyV2Schema.safeParse(value).success, false);
    assert.deepEqual(schemaOutcome(moneyV2Schema, value), schemaOutcome(evelyn.moneyV2Schema, value));
  }
  for (const currency of ["eur", "EU", "EURO", "E1R", "", " EUR"]) {
    const value = money("1", currency);
    assert.equal(moneyV2Schema.safeParse(value).success, false);
    assert.deepEqual(schemaOutcome(moneyV2Schema, value), schemaOutcome(evelyn.moneyV2Schema, value));
  }
  for (const minorUnitExponent of [-1, 1.5, 10, "2"]) {
    const value = { ...money("1"), minorUnitExponent };
    assert.equal(moneyV2Schema.safeParse(value).success, false);
    assert.deepEqual(schemaOutcome(moneyV2Schema, value), schemaOutcome(evelyn.moneyV2Schema, value));
  }
  assert.equal(moneyV2Schema.safeParse(money("9".repeat(78))).success, true);
  assert.equal(moneyV2Schema.safeParse(money("9".repeat(79))).success, false);
  assert.deepEqual(
    schemaOutcome(moneyV2Schema, money("9".repeat(78))),
    schemaOutcome(evelyn.moneyV2Schema, money("9".repeat(78))),
  );
  assert.deepEqual(
    schemaOutcome(moneyV2Schema, money("9".repeat(79))),
    schemaOutcome(evelyn.moneyV2Schema, money("9".repeat(79))),
  );
});

test("CRM and Evelyn convert exact decimals identically and require rounding policy identically", async () => {
  const evelyn = await loadEvelynContract();
  const definition = goldenSnapshot().currencyDefinition;
  for (const decimal of ["0", "12.34", "12.3400", "-0.01", "999999999999999999999999999999.99"]) {
    assert.deepEqual(moneyFromDecimal(decimal, definition), evelyn.moneyFromDecimal(decimal, definition));
  }
  for (const decimal of ["12.345", "+1.00", "01.00", "1e2", " 1.00"]) {
    const errorMessage = (run: () => unknown) => {
      try { run(); return null; }
      catch (error) { return (error as Error).message; }
    };
    assert.equal(
      errorMessage(() => moneyFromDecimal(decimal, definition)),
      errorMessage(() => evelyn.moneyFromDecimal(decimal, definition)),
      `Decimal rejection differs for ${decimal}`,
    );
  }
});

test("CRM and Evelyn reconcile multiple tax components and reject contradictory authority identically", async () => {
  const evelyn = await loadEvelynContract();
  const snapshot = goldenSnapshot();
  const first = snapshot.components[0].taxComponents[0];
  const second = structuredClone(first);
  first.componentId = "tax-a";
  first.amount = money("4000");
  second.componentId = "tax-b";
  second.amount = money("6000");
  snapshot.components[0].taxComponents = [second, first];
  assert.equal(financialSnapshotV1Schema.safeParse(snapshot).success, true);
  assert.deepEqual(schemaOutcome(financialSnapshotV1Schema, snapshot), schemaOutcome(evelyn.financialSnapshotV1Schema, snapshot));

  const inconsistent = structuredClone(snapshot);
  inconsistent.components[0].taxComponents[0].amount = money("6001");
  assert.equal(financialSnapshotV1Schema.safeParse(inconsistent).success, false);
  assert.deepEqual(schemaOutcome(financialSnapshotV1Schema, inconsistent), schemaOutcome(evelyn.financialSnapshotV1Schema, inconsistent));
});

test("every material mutation changes the same CRM and Evelyn binding", async () => {
  const evelyn = await loadEvelynContract();
  const original = goldenSnapshot();
  const originalSnapshotHash = financialSnapshotHash(original);
  assert.equal(evelyn.financialSnapshotHash(original), originalSnapshotHash);
  const variants: CompleteFinancialSnapshotV1[] = [];

  const amountChanged = structuredClone(original);
  amountChanged.components[0].net = money("2037001");
  amountChanged.components[0].gross = money("2047001");
  amountChanged.totals.net = money("2037001");
  amountChanged.totals.gross = money("2047001");
  variants.push(amountChanged, switchCurrency(original, "USD"), switchCurrency(original, "EUR", 3));

  const taxPolicyChanged = structuredClone(original);
  taxPolicyChanged.components[0].taxComponents[0].policy.reference.version = "8";
  taxPolicyChanged.components[0].taxComponents[0].policy.sourceProvenance.policyVersion = "8";
  variants.push(taxPolicyChanged);

  const jurisdictionChanged = structuredClone(original);
  jurisdictionChanged.jurisdiction = "SYNTHETIC:OTHER";
  variants.push(jurisdictionChanged);

  const roundingChanged = structuredClone(original);
  roundingChanged.roundingPolicy.version = "5";
  variants.push(roundingChanged);

  const componentChanged = structuredClone(original);
  componentChanged.components[0].componentId = "line-renamed";
  variants.push(componentChanged);

  for (const variant of variants) {
    assert.equal(financialSnapshotV1Schema.safeParse(variant).success, true);
    assert.equal(evelyn.financialSnapshotV1Schema.safeParse(variant).success, true);
    assert.notEqual(financialSnapshotHash(variant), originalSnapshotHash);
    assert.equal(evelyn.financialSnapshotHash(variant), financialSnapshotHash(variant));
    assert.notEqual(approvalActionV2Hash(actionFor(variant)), GOLDEN_ACTION_HASH);
    assert.equal(evelyn.approvalActionV2Hash(actionFor(variant)), approvalActionV2Hash(actionFor(variant)));
  }

  const revisedAction = structuredClone(actionFor(original));
  revisedAction.actionVersion = 2;
  assert.notEqual(approvalActionV2Hash(revisedAction), GOLDEN_ACTION_HASH);
  assert.equal(evelyn.approvalActionV2Hash(revisedAction), approvalActionV2Hash(revisedAction));
});

test("CRM and Evelyn fail closed on the same NEEDS_REVIEW and unsupported threshold contexts", async () => {
  const evelyn = await loadEvelynContract();
  const cases: Array<{ action: ApprovalActionV2; expected: unknown }> = [{
    action: actionFor(needsReview(goldenSnapshot())), expected: {
      status: "NEEDS_REVIEW",
      basis: "NET",
    },
  }, {
    action: actionFor(switchCurrency(goldenSnapshot(), "USD")), expected: {
      status: "POLICY_REQUIRED",
      basis: "NET",
    },
  }, {
    action: actionFor(switchCurrency(goldenSnapshot(), "EUR", 3)), expected: {
      status: "POLICY_REQUIRED",
      basis: "NET",
    },
  }, {
    action: actionFor(goldenSnapshot()), expected: {
      status: "READY",
      basis: "NET",
      currency: "EUR",
      atLeast5000: true,
    },
  }];
  for (const value of cases) {
    assert.deepEqual(v2ThresholdContext(value.action), value.expected);
    assert.deepEqual(evelyn.v2ThresholdContext(value.action), value.expected);
    assert.deepEqual(v2ThresholdContext(value.action), evelyn.v2ThresholdContext(value.action));
  }
});

test("128 property/fuzz cases preserve identical CRM and Evelyn normalized values and hashes", async () => {
  const evelyn = await loadEvelynContract();
  let seed = 0x7a31;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  function shuffled(value: unknown): unknown {
    if (Array.isArray(value)) return [...value].reverse().map(shuffled);
    if (value === null || typeof value !== "object") return value;
    const entries = Object.entries(value);
    for (let index = entries.length - 1; index > 0; index -= 1) {
      const target = next() % (index + 1);
      [entries[index], entries[target]] = [entries[target], entries[index]];
    }
    return Object.fromEntries(entries.map(([key, nested]) => [key, shuffled(nested)]));
  }

  for (let iteration = 0; iteration < 128; iteration += 1) {
    const net = (BigInt(next()) * BigInt(10) ** BigInt(iteration % 30)).toString();
    const snapshot = goldenSnapshot();
    const line = snapshot.components[0];
    line.net = money(net);
    line.tax = money("0");
    line.gross = money(net);
    line.taxComponents[0].componentId = "tax-z";
    line.taxComponents[0].amount = money("0");
    line.taxComponents.push({ ...structuredClone(line.taxComponents[0]), componentId: "tax-a" });

    const zeroLine = structuredClone(line);
    zeroLine.componentId = "line-a";
    zeroLine.net = money("0");
    zeroLine.gross = money("0");
    zeroLine.taxComponents = [{ ...structuredClone(line.taxComponents[0]), componentId: "tax-zero" }];
    snapshot.components.push(zeroLine);
    snapshot.totals = { net: money(net), tax: money("0"), gross: money(net) };

    const normalized = normalizeFinancialSnapshotV1(snapshot);
    const evelynNormalized = evelyn.normalizeFinancialSnapshotV1(snapshot);
    const shuffledSnapshot = shuffled(snapshot);
    const roundTripped = JSON.parse(JSON.stringify(normalized));
    const action = actionFor(snapshot);
    const shuffledAction = shuffled(action);
    const snapshotHash = financialSnapshotHash(snapshot);
    const actionHash = approvalActionV2Hash(action);
    assert.deepEqual(normalized, evelynNormalized);
    assert.equal(financialSnapshotHash(shuffledSnapshot), snapshotHash);
    assert.equal(evelyn.financialSnapshotHash(shuffledSnapshot), snapshotHash);
    assert.equal(financialSnapshotHash(roundTripped), snapshotHash);
    assert.equal(evelyn.financialSnapshotHash(roundTripped), snapshotHash);
    assert.equal(evelyn.financialSnapshotHash(snapshot), snapshotHash);
    assert.equal(approvalActionV2Hash(shuffledAction), actionHash);
    assert.equal(evelyn.approvalActionV2Hash(shuffledAction), actionHash);
    assert.equal(evelyn.approvalActionV2Hash(action), actionHash);
  }
});
