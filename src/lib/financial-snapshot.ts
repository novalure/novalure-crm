import { createHash } from "node:crypto";
import { z } from "zod";
import {
  financialSnapshotHash,
  financialSourceProvenanceSchema,
  moneyV2Schema,
  normalizeFinancialSnapshotV1,
  taxSourceProvenanceSchema,
  versionedFinancialReferenceSchema,
  type CompleteFinancialSnapshotV1,
  type FinancialSnapshotV1,
  type MoneyV2,
} from "./evelyn-money-tax-v2";

const referenceText = z.string().min(1).max(200).regex(/^\S(?:[^\u0000-\u001f\u007f]*\S)?$/u);
const componentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const jurisdiction = z.string().regex(/^[A-Z0-9][A-Z0-9._:-]{0,79}$/);
const currencyCode = z.string().regex(/^[A-Z]{3}$/);
const currencyExponent = z.number().int().min(0).max(9);
const canonicalMinorUnits = z.string().max(79).regex(/^(?:0|-?[1-9][0-9]{0,77})$/);
const unsignedInteger = z.string().max(78).regex(/^(?:0|[1-9][0-9]{0,77})$/);
const positiveInteger = z.string().max(78).regex(/^[1-9][0-9]{0,77}$/);
const canonicalInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    "Expected a real, canonical UTC millisecond timestamp");
const positiveVersion = z.number().int().positive().safe();
const uuid = z.uuid().transform(value => value.toLowerCase());

export const FINANCIAL_POLICY_HASH_CONTRACT_VERSION = "crm-financial-policy-content-hash-v1" as const;

export const currencyPolicyPayloadSchema = z.strictObject({
  policySchemaVersion: z.literal("crm-currency-policy-v1"),
  kind: z.literal("CURRENCY"),
  standard: z.literal("ISO-4217"),
  code: currencyCode,
  minorUnitExponent: currencyExponent,
  verifiedAt: canonicalInstant,
});

export const taxPolicyPayloadSchema = z.strictObject({
  policySchemaVersion: z.literal("crm-tax-policy-v1"),
  kind: z.literal("TAX"),
  jurisdiction,
  treatment: referenceText,
  category: referenceText,
  rate: z.strictObject({
    basis: z.literal("NET"),
    numerator: unsignedInteger,
    denominator: positiveInteger,
  }),
  sourceProvenance: taxSourceProvenanceSchema,
}).refine(value => value.jurisdiction === value.sourceProvenance.jurisdiction,
  "Tax policy and provenance must identify the same jurisdiction");

export const roundingModeSchema = z.enum(["TRUNCATE", "AWAY_FROM_ZERO", "HALF_UP", "HALF_EVEN"]);
export type RoundingMode = z.infer<typeof roundingModeSchema>;

export const roundingPolicyPayloadSchema = z.strictObject({
  policySchemaVersion: z.literal("crm-rounding-policy-v1"),
  kind: z.literal("ROUNDING"),
  mode: roundingModeSchema,
  currencyExponent,
  scope: z.literal("TAX_COMPONENT"),
});

export const financialPolicyPayloadSchema = z.discriminatedUnion("kind", [
  currencyPolicyPayloadSchema,
  taxPolicyPayloadSchema,
  roundingPolicyPayloadSchema,
]);
export type FinancialPolicyPayload = z.infer<typeof financialPolicyPayloadSchema>;
export type CurrencyPolicyPayload = z.infer<typeof currencyPolicyPayloadSchema>;
export type TaxPolicyPayload = z.infer<typeof taxPolicyPayloadSchema>;
export type RoundingPolicyPayload = z.infer<typeof roundingPolicyPayloadSchema>;

export const resolvedCurrencyPolicySchema = z.strictObject({
  reference: versionedFinancialReferenceSchema,
  payload: currencyPolicyPayloadSchema,
});
export const resolvedTaxPolicySchema = z.strictObject({
  reference: versionedFinancialReferenceSchema,
  payload: taxPolicyPayloadSchema,
});
export const resolvedRoundingPolicySchema = z.strictObject({
  reference: versionedFinancialReferenceSchema,
  payload: roundingPolicyPayloadSchema,
});
export const resolvedFinancialPolicySchema = z.union([
  resolvedCurrencyPolicySchema,
  resolvedTaxPolicySchema,
  resolvedRoundingPolicySchema,
]);
export type ResolvedCurrencyPolicy = z.infer<typeof resolvedCurrencyPolicySchema>;
export type ResolvedTaxPolicy = z.infer<typeof resolvedTaxPolicySchema>;
export type ResolvedRoundingPolicy = z.infer<typeof resolvedRoundingPolicySchema>;
export type ResolvedFinancialPolicy = z.infer<typeof resolvedFinancialPolicySchema>;
export type FinancialPolicyKind = FinancialPolicyPayload["kind"];

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

export function canonicalFinancialPolicyContent(input: unknown): string {
  const policy = financialPolicyPayloadSchema.parse(input);
  return canonical({ hashContractVersion: FINANCIAL_POLICY_HASH_CONTRACT_VERSION, policy });
}

export function financialPolicyContentHash(input: unknown): string {
  return createHash("sha256").update(canonicalFinancialPolicyContent(input)).digest("hex");
}

export type FinancialSnapshotErrorCode =
  | "INVALID_INPUT"
  | "UNKNOWN_POLICY"
  | "DUPLICATE_POLICY_REFERENCE"
  | "POLICY_KIND_MISMATCH"
  | "POLICY_CONTENT_HASH_MISMATCH"
  | "POLICY_VERSION_MISMATCH"
  | "POLICY_CONTEXT_REQUIRED"
  | "POLICY_JURISDICTION_MISMATCH"
  | "POLICY_NOT_EFFECTIVE"
  | "CURRENCY_EXPONENT_MISMATCH"
  | "MONEY_OUT_OF_RANGE"
  | "LEGACY_CURRENCY_MISMATCH"
  | "INVALID_SNAPSHOT";

export class FinancialSnapshotError extends Error {
  readonly code: FinancialSnapshotErrorCode;

  constructor(code: FinancialSnapshotErrorCode) {
    super(code);
    this.name = "FinancialSnapshotError";
    this.code = code;
  }
}

function fail(code: FinancialSnapshotErrorCode): never {
  throw new FinancialSnapshotError(code);
}

const policySelectorSchema = z.strictObject({ id: referenceText, version: referenceText });
export type FinancialPolicySelector = z.infer<typeof policySelectorSchema>;

const policyApplicabilityContextSchema = z.strictObject({
  expectedKind: z.enum(["CURRENCY", "TAX", "ROUNDING"]),
  jurisdiction: jurisdiction.optional(),
  effectiveAt: canonicalInstant.optional(),
  currencyExponent: currencyExponent.optional(),
});
export type FinancialPolicyApplicabilityContext = z.infer<typeof policyApplicabilityContextSchema>;

/** Validate stored content before using its reference as financial authority. */
export function assertFinancialPolicyApplicable(
  rawRecord: unknown,
  rawContext: unknown,
): ResolvedFinancialPolicy {
  const parsedRecord = resolvedFinancialPolicySchema.safeParse(rawRecord);
  const parsedContext = policyApplicabilityContextSchema.safeParse(rawContext);
  if (!parsedRecord.success || !parsedContext.success) return fail("INVALID_INPUT");
  const record = parsedRecord.data;
  const context = parsedContext.data;
  if (record.payload.kind !== context.expectedKind) return fail("POLICY_KIND_MISMATCH");
  if (record.reference.contentHash !== financialPolicyContentHash(record.payload)) {
    return fail("POLICY_CONTENT_HASH_MISMATCH");
  }
  if (record.payload.kind === "TAX") {
    if (record.reference.version !== record.payload.sourceProvenance.policyVersion) {
      return fail("POLICY_VERSION_MISMATCH");
    }
    if (context.jurisdiction === undefined || context.effectiveAt === undefined) {
      return fail("POLICY_CONTEXT_REQUIRED");
    }
    if (record.payload.jurisdiction !== context.jurisdiction) {
      return fail("POLICY_JURISDICTION_MISMATCH");
    }
    const provenance = record.payload.sourceProvenance;
    if (context.effectiveAt < provenance.effectiveFrom
      || (provenance.effectiveTo !== null && context.effectiveAt >= provenance.effectiveTo)) {
      return fail("POLICY_NOT_EFFECTIVE");
    }
  }
  if (record.payload.kind === "ROUNDING") {
    if (context.currencyExponent === undefined) return fail("POLICY_CONTEXT_REQUIRED");
    if (record.payload.currencyExponent !== context.currencyExponent) return fail("CURRENCY_EXPONENT_MISMATCH");
  }
  if (record.payload.kind === "CURRENCY" && context.currencyExponent !== undefined
    && record.payload.minorUnitExponent !== context.currencyExponent) {
    return fail("CURRENCY_EXPONENT_MISMATCH");
  }
  return record;
}

function resolvePolicy(
  records: readonly ResolvedFinancialPolicy[],
  selector: FinancialPolicySelector,
  context: FinancialPolicyApplicabilityContext,
): ResolvedFinancialPolicy {
  const matches = records.filter(record => record.reference.id === selector.id && record.reference.version === selector.version);
  if (matches.length === 0) return fail("UNKNOWN_POLICY");
  if (matches.length !== 1) return fail("DUPLICATE_POLICY_REFERENCE");
  return assertFinancialPolicyApplicable(matches[0], context);
}

/** Exact integer rounding of `minorUnits * numerator / denominator`. */
export function roundRationalMinorUnits(
  rawMinorUnits: string,
  rawNumerator: string,
  rawDenominator: string,
  rawMode: RoundingMode,
): string {
  const parsed = z.tuple([canonicalMinorUnits, unsignedInteger, positiveInteger, roundingModeSchema])
    .safeParse([rawMinorUnits, rawNumerator, rawDenominator, rawMode]);
  if (!parsed.success) return fail("INVALID_INPUT");
  const [minorUnits, numerator, denominator, mode] = parsed.data;
  const product = BigInt(minorUnits) * BigInt(numerator);
  const divisor = BigInt(denominator);
  const quotient = product / divisor;
  const remainder = product % divisor;
  if (remainder === BigInt(0) || mode === "TRUNCATE") return quotient.toString();
  const sign = product < BigInt(0) ? BigInt(-1) : BigInt(1);
  if (mode === "AWAY_FROM_ZERO") return (quotient + sign).toString();
  const absoluteRemainder = remainder < BigInt(0) ? -remainder : remainder;
  const comparison = absoluteRemainder * BigInt(2) - divisor;
  if (comparison < BigInt(0)) return quotient.toString();
  if (comparison > BigInt(0) || mode === "HALF_UP") return (quotient + sign).toString();
  const absoluteQuotient = quotient < BigInt(0) ? -quotient : quotient;
  return absoluteQuotient % BigInt(2) === BigInt(0) ? quotient.toString() : (quotient + sign).toString();
}

const taxApplicationSchema = z.strictObject({
  componentId,
  policy: policySelectorSchema,
  jurisdiction,
});

const authoritativeLineSchema = z.strictObject({
  componentId,
  kind: z.enum(["LINE", "DISCOUNT", "ADJUSTMENT"]),
  netMinorUnits: canonicalMinorUnits,
  pricingReference: versionedFinancialReferenceSchema,
  taxComponents: z.array(taxApplicationSchema).min(1).max(100),
});
export type AuthoritativeFinancialLine = z.infer<typeof authoritativeLineSchema>;

export const completeFinancialSnapshotInputSchema = z.strictObject({
  snapshotId: uuid,
  businessVersion: positiveVersion,
  tenantId: uuid,
  resourceId: uuid,
  effectiveAt: canonicalInstant,
  jurisdiction,
  currencyPolicy: policySelectorSchema,
  roundingPolicy: policySelectorSchema,
  pricingReference: versionedFinancialReferenceSchema,
  provenance: financialSourceProvenanceSchema,
  lines: z.array(authoritativeLineSchema).min(1).max(100),
  policies: z.array(resolvedFinancialPolicySchema).min(3).max(500),
});
export type CompleteFinancialSnapshotInput = z.infer<typeof completeFinancialSnapshotInputSchema>;

export type BuiltCompleteFinancialSnapshot = Readonly<{
  snapshot: CompleteFinancialSnapshotV1;
  snapshotHash: string;
}>;

function exactMoney(minorUnits: string, currency: string, minorUnitExponent: number): MoneyV2 {
  const parsed = moneyV2Schema.safeParse({ minorUnits, currency, minorUnitExponent });
  if (!parsed.success) return fail("MONEY_OUT_OF_RANGE");
  return parsed.data;
}

/** Build authority from server lines and already resolved, hash-verified policy records. */
export function buildCompleteFinancialSnapshot(rawInput: unknown): BuiltCompleteFinancialSnapshot {
  const parsedInput = completeFinancialSnapshotInputSchema.safeParse(rawInput);
  if (!parsedInput.success) return fail("INVALID_INPUT");
  const input = parsedInput.data;

  const currencyRecord = resolvePolicy(input.policies, input.currencyPolicy, { expectedKind: "CURRENCY" });
  if (currencyRecord.payload.kind !== "CURRENCY") return fail("POLICY_KIND_MISMATCH");
  const currency = currencyRecord.payload.code;
  const exponent = currencyRecord.payload.minorUnitExponent;

  const roundingRecord = resolvePolicy(input.policies, input.roundingPolicy, {
    expectedKind: "ROUNDING",
    currencyExponent: exponent,
  });
  if (roundingRecord.payload.kind !== "ROUNDING") return fail("POLICY_KIND_MISMATCH");
  const roundingMode = roundingRecord.payload.mode;

  const components = input.lines.map(line => {
    const net = exactMoney(line.netMinorUnits, currency, exponent);
    const taxes = line.taxComponents.map(application => {
      const record = resolvePolicy(input.policies, application.policy, {
        expectedKind: "TAX",
        jurisdiction: application.jurisdiction,
        effectiveAt: input.effectiveAt,
      });
      if (record.payload.kind !== "TAX") return fail("POLICY_KIND_MISMATCH");
      const taxMinorUnits = roundRationalMinorUnits(
        line.netMinorUnits,
        record.payload.rate.numerator,
        record.payload.rate.denominator,
        roundingMode,
      );
      return {
        componentId: application.componentId,
        amount: exactMoney(taxMinorUnits, currency, exponent),
        policy: {
          reference: record.reference,
          jurisdiction: record.payload.jurisdiction,
          sourceProvenance: record.payload.sourceProvenance,
        },
      };
    });
    const taxMinorUnits = taxes.reduce((sum, tax) => sum + BigInt(tax.amount.minorUnits), BigInt(0)).toString();
    const grossMinorUnits = (BigInt(line.netMinorUnits) + BigInt(taxMinorUnits)).toString();
    return {
      componentId: line.componentId,
      kind: line.kind,
      net,
      tax: exactMoney(taxMinorUnits, currency, exponent),
      gross: exactMoney(grossMinorUnits, currency, exponent),
      taxComponents: taxes,
      pricingReference: line.pricingReference,
    };
  });

  const totalMinorUnits = (field: "net" | "tax" | "gross") => components
    .reduce((sum, component) => sum + BigInt(component[field].minorUnits), BigInt(0)).toString();
  const rawSnapshot = {
    snapshotSchemaVersion: "financial-snapshot-v1" as const,
    snapshotId: input.snapshotId,
    businessVersion: input.businessVersion,
    tenantId: input.tenantId,
    resourceId: input.resourceId,
    reviewState: "COMPLETE" as const,
    effectiveAt: input.effectiveAt,
    currency,
    minorUnitExponent: exponent,
    currencyDefinition: {
      standard: currencyRecord.payload.standard,
      code: currency,
      minorUnitExponent: exponent,
      registryReference: currencyRecord.reference,
      verifiedAt: currencyRecord.payload.verifiedAt,
    },
    jurisdiction: input.jurisdiction,
    components,
    totals: {
      net: exactMoney(totalMinorUnits("net"), currency, exponent),
      tax: exactMoney(totalMinorUnits("tax"), currency, exponent),
      gross: exactMoney(totalMinorUnits("gross"), currency, exponent),
    },
    roundingPolicy: roundingRecord.reference,
    pricingReference: input.pricingReference,
    provenance: input.provenance,
  };

  let snapshot: FinancialSnapshotV1;
  try {
    snapshot = normalizeFinancialSnapshotV1(rawSnapshot);
  } catch {
    return fail("INVALID_SNAPSHOT");
  }
  if (snapshot.reviewState !== "COMPLETE") return fail("INVALID_SNAPSHOT");
  return Object.freeze({ snapshot, snapshotHash: financialSnapshotHash(snapshot) });
}

const legacyCurrencySchema = z.strictObject({
  currency: currencyCode,
  minorUnitExponent: currencyExponent,
});

export const legacyFinancialSnapshotInputSchema = z.strictObject({
  snapshotId: uuid,
  businessVersion: positiveVersion,
  tenantId: uuid,
  resourceId: uuid,
  knownNet: moneyV2Schema.nullable().optional(),
  knownCurrency: legacyCurrencySchema.nullable().optional(),
});
export type LegacyFinancialSnapshotInput = z.infer<typeof legacyFinancialSnapshotInputSchema>;
export type BuiltLegacyFinancialSnapshot = Readonly<{
  snapshot: Extract<FinancialSnapshotV1, { reviewState: "NEEDS_REVIEW" }>;
  snapshotHash: string;
}>;

/** Preserve only supplied legacy evidence; never infer tax, gross, policies or currency. */
export function buildLegacyNeedsReviewSnapshot(rawInput: unknown): BuiltLegacyFinancialSnapshot {
  const parsedInput = legacyFinancialSnapshotInputSchema.safeParse(rawInput);
  if (!parsedInput.success) return fail("INVALID_INPUT");
  const input = parsedInput.data;
  const knownNet = input.knownNet ?? null;
  const suppliedCurrency = input.knownCurrency ?? null;
  if (knownNet !== null && suppliedCurrency !== null
    && (knownNet.currency !== suppliedCurrency.currency
      || knownNet.minorUnitExponent !== suppliedCurrency.minorUnitExponent)) {
    return fail("LEGACY_CURRENCY_MISMATCH");
  }
  const currency = suppliedCurrency?.currency ?? knownNet?.currency ?? null;
  const minorUnitExponent = suppliedCurrency?.minorUnitExponent ?? knownNet?.minorUnitExponent ?? null;
  const missingFields = [
    "effectiveAt",
    ...(currency === null ? ["currency"] : []),
    ...(minorUnitExponent === null ? ["minorUnitExponent"] : []),
    "currencyDefinition",
    "jurisdiction",
    "components",
    ...(knownNet === null ? ["totals.net"] : []),
    "totals.tax",
    "totals.gross",
    "taxPolicy",
    "roundingPolicy",
    "pricingReference",
    "provenance",
  ];
  let snapshot: FinancialSnapshotV1;
  try {
    snapshot = normalizeFinancialSnapshotV1({
      snapshotSchemaVersion: "financial-snapshot-v1",
      snapshotId: input.snapshotId,
      businessVersion: input.businessVersion,
      tenantId: input.tenantId,
      resourceId: input.resourceId,
      reviewState: "NEEDS_REVIEW",
      effectiveAt: null,
      currency,
      minorUnitExponent,
      currencyDefinition: null,
      jurisdiction: null,
      components: null,
      totals: { net: knownNet, tax: null, gross: null },
      roundingPolicy: null,
      pricingReference: null,
      provenance: null,
      missingFields,
    });
  } catch {
    return fail("INVALID_SNAPSHOT");
  }
  if (snapshot.reviewState !== "NEEDS_REVIEW") return fail("INVALID_SNAPSHOT");
  return Object.freeze({ snapshot, snapshotHash: financialSnapshotHash(snapshot) });
}
