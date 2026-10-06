/**
 * Compatibility copy pinned to novalure/evelyn
 * 1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc:
 * src/approval-bridge/money-tax-v2.ts.
 *
 * Keep the schemas, normalization rules and hash domains byte-compatible with
 * that source. Only Evelyn's integrity import is implemented locally.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(object[key])).join(',') + '}';
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

const id = z.uuid().transform(value => value.toLowerCase());
const version = z.number().int().positive().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const referenceText = z.string().min(1).max(200).regex(/^\S(?:[^\u0000-\u001f\u007f]*\S)?$/u);
const componentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const jurisdiction = z.string().regex(/^[A-Z0-9][A-Z0-9._:-]{0,79}$/);
const currencyCode = z.string().regex(/^[A-Z]{3}$/);
const exponent = z.number().int().min(0).max(9);
const minorUnitsPattern = /^(?:0|-?[1-9][0-9]{0,77})$/;
const canonicalInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'Expected a real, canonical UTC millisecond timestamp');

/** The bound is an input/CPU limit, not a monetary business limit. JSON and PG
 * JSONB preserve these strings; projections to numeric must not pass through JS Number. */
export const moneyV2Schema = z.strictObject({
  minorUnits: z.string().max(79).regex(minorUnitsPattern),
  currency: currencyCode,
  minorUnitExponent: exponent,
});
export type MoneyV2 = z.infer<typeof moneyV2Schema>;

export const versionedFinancialReferenceSchema = z.strictObject({
  id: referenceText, version: referenceText, contentHash: hash,
});
export type VersionedFinancialReference = z.infer<typeof versionedFinancialReferenceSchema>;

/** Code syntax is not ISO membership proof. Only the authorized business
 * system's controlled registry attestation supplies code/exponent authority.
 * No Intl lookup, country inference, live registry lookup or mutable default. */
export const currencyDefinitionSchema = z.strictObject({
  standard: z.literal('ISO-4217'), code: currencyCode, minorUnitExponent: exponent,
  registryReference: versionedFinancialReferenceSchema, verifiedAt: canonicalInstant,
});

export const financialSourceProvenanceSchema = z.strictObject({
  sourceSystem: referenceText, sourceRecordId: referenceText,
  sourceVersion: referenceText, sourceHash: hash,
  recordedAt: canonicalInstant, recordedBy: referenceText,
});

export const taxSourceProvenanceSchema = z.strictObject({
  authority: referenceText, sourceReference: referenceText, jurisdiction,
  effectiveFrom: canonicalInstant, effectiveTo: canonicalInstant.nullable(),
  policyVersion: referenceText, verifiedAt: canonicalInstant,
}).refine(value => value.effectiveTo === null || value.effectiveFrom < value.effectiveTo,
  'Policy validity is a nonempty half-open interval');

export const taxPolicyReferenceSchema = z.strictObject({
  reference: versionedFinancialReferenceSchema, jurisdiction,
  sourceProvenance: taxSourceProvenanceSchema,
}).refine(value => value.jurisdiction === value.sourceProvenance.jurisdiction
  && value.reference.version === value.sourceProvenance.policyVersion,
  'Tax reference and provenance must identify the same jurisdiction/version');

export const taxComponentV1Schema = z.strictObject({
  componentId, amount: moneyV2Schema, policy: taxPolicyReferenceSchema,
});
export const economicComponentV1Schema = z.strictObject({
  componentId, kind: z.enum(['LINE', 'DISCOUNT', 'ADJUSTMENT']),
  net: moneyV2Schema, tax: moneyV2Schema, gross: moneyV2Schema,
  taxComponents: z.array(taxComponentV1Schema).min(1).max(100),
  pricingReference: versionedFinancialReferenceSchema,
});
const totalsSchema = z.strictObject({ net: moneyV2Schema, tax: moneyV2Schema, gross: moneyV2Schema });
const nullableTotalsSchema = z.strictObject({
  net: moneyV2Schema.nullable(), tax: moneyV2Schema.nullable(), gross: moneyV2Schema.nullable(),
});
const nullableComponentSchema = z.strictObject({
  componentId, kind: z.enum(['LINE', 'DISCOUNT', 'ADJUSTMENT']),
  net: moneyV2Schema.nullable(), tax: moneyV2Schema.nullable(), gross: moneyV2Schema.nullable(),
  taxComponents: z.array(taxComponentV1Schema).min(1).max(100).nullable(),
  pricingReference: versionedFinancialReferenceSchema.nullable(),
});
const snapshotIdentity = {
  snapshotSchemaVersion: z.literal('financial-snapshot-v1'), snapshotId: id,
  businessVersion: version, tenantId: id, resourceId: id,
};
const completeSnapshot = z.strictObject({
  ...snapshotIdentity, reviewState: z.literal('COMPLETE'), effectiveAt: canonicalInstant,
  currency: currencyCode, minorUnitExponent: exponent, currencyDefinition: currencyDefinitionSchema,
  jurisdiction, components: z.array(economicComponentV1Schema).min(1).max(100), totals: totalsSchema,
  roundingPolicy: versionedFinancialReferenceSchema, pricingReference: versionedFinancialReferenceSchema,
  provenance: financialSourceProvenanceSchema,
});
const missingField = z.enum(['effectiveAt', 'currency', 'minorUnitExponent', 'currencyDefinition', 'jurisdiction',
  'components', 'totals.net', 'totals.tax', 'totals.gross', 'taxPolicy', 'roundingPolicy', 'pricingReference', 'provenance']);
const legacySnapshot = z.strictObject({
  ...snapshotIdentity, reviewState: z.literal('NEEDS_REVIEW'), effectiveAt: canonicalInstant.nullable(),
  currency: currencyCode.nullable(), minorUnitExponent: exponent.nullable(), currencyDefinition: currencyDefinitionSchema.nullable(),
  jurisdiction: jurisdiction.nullable(), components: z.array(nullableComponentSchema).min(1).max(100).nullable(),
  totals: nullableTotalsSchema, roundingPolicy: versionedFinancialReferenceSchema.nullable(),
  pricingReference: versionedFinancialReferenceSchema.nullable(), provenance: financialSourceProvenanceSchema.nullable(),
  missingFields: z.array(missingField).min(1).max(14),
});

function amount(value: MoneyV2): bigint { return BigInt(value.minorUnits); }
function sameMoney(left: MoneyV2, right: MoneyV2): boolean {
  return left.currency === right.currency && left.minorUnitExponent === right.minorUnitExponent && left.minorUnits === right.minorUnits;
}
function binary(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sortedComponents<T extends { componentId: string; taxComponents: { componentId: string }[] | null }>(components: T[]): T[] {
  return components.map(component => ({ ...component, taxComponents: component.taxComponents === null ? null
    : [...component.taxComponents].sort((left, right) => binary(left.componentId, right.componentId)) }))
    .sort((left, right) => binary(left.componentId, right.componentId));
}

/** No tax or rounding calculation: reconcile already resolved integer amounts.
 * IDs are unique throughout a snapshot; components are identity-keyed sets.
 * LINE amounts are nonnegative; DISCOUNT amounts nonpositive; ADJUSTMENT is signed. */
export const financialSnapshotV1Schema = z.discriminatedUnion('reviewState', [completeSnapshot, legacySnapshot])
  .superRefine((snapshot, context) => {
    const issue = (message: string) => context.addIssue({ code: 'custom', message });
    // Zod continues refinements after nonfatal string-format issues. Do not feed
    // malformed or unbounded strings into BigInt; the leaf schema already denies them.
    const moneyValues = [...Object.values(snapshot.totals), ...(snapshot.components ?? []).flatMap(component =>
      [component.net, component.tax, component.gross, ...(component.taxComponents ?? []).map(tax => tax.amount)])];
    if (moneyValues.some(value => value !== null && !minorUnitsPattern.test(value.minorUnits))) return;
    if (snapshot.currencyDefinition && (snapshot.currency !== snapshot.currencyDefinition.code
      || snapshot.minorUnitExponent !== snapshot.currencyDefinition.minorUnitExponent)) issue('CURRENCY_DEFINITION_MISMATCH');
    const checkCurrency = (value: MoneyV2 | null) => {
      if (value && ((snapshot.currency !== null && value.currency !== snapshot.currency)
        || (snapshot.minorUnitExponent !== null && value.minorUnitExponent !== snapshot.minorUnitExponent))) issue('MONEY_CURRENCY_MISMATCH');
    };
    for (const value of Object.values(snapshot.totals)) checkCurrency(value);
    const ids = new Set<string>();
    for (const component of snapshot.components ?? []) {
      if (ids.has(component.componentId)) issue('DUPLICATE_COMPONENT_ID');
      ids.add(component.componentId);
      for (const value of [component.net, component.tax, component.gross, ...(component.taxComponents ?? []).map(tax => tax.amount)]) {
        checkCurrency(value);
        if (value && component.kind === 'LINE' && amount(value) < BigInt(0)) issue('NEGATIVE_LINE_AMOUNT');
        if (value && component.kind === 'DISCOUNT' && amount(value) > BigInt(0)) issue('POSITIVE_DISCOUNT_AMOUNT');
      }
      for (const tax of component.taxComponents ?? []) {
        if (ids.has(tax.componentId)) issue('DUPLICATE_TAX_COMPONENT_ID');
        ids.add(tax.componentId);
        const provenance = tax.policy.sourceProvenance;
        if (snapshot.effectiveAt !== null && (snapshot.effectiveAt < provenance.effectiveFrom
          || (provenance.effectiveTo !== null && snapshot.effectiveAt >= provenance.effectiveTo))) issue('TAX_POLICY_NOT_EFFECTIVE');
      }
    }
    if (snapshot.reviewState === 'NEEDS_REVIEW') {
      if (new Set(snapshot.missingFields).size !== snapshot.missingFields.length) issue('DUPLICATE_MISSING_FIELD');
      // Null dimensions must be declared; explicit NEEDS_REVIEW can never authorize
      // an action even when a human has preserved additional partial evidence.
      for (const field of ['effectiveAt', 'currency', 'minorUnitExponent', 'currencyDefinition', 'jurisdiction',
        'components', 'roundingPolicy', 'pricingReference', 'provenance'] as const) {
        if (snapshot[field] === null && !snapshot.missingFields.includes(field)) issue('UNDECLARED_MISSING_FIELD');
      }
      for (const field of ['net', 'tax', 'gross'] as const) {
        if (snapshot.totals[field] === null && !snapshot.missingFields.includes(`totals.${field}`)) issue('UNDECLARED_MISSING_FIELD');
      }
      return;
    }
    for (const component of snapshot.components) {
      if (amount(component.net) + amount(component.tax) !== amount(component.gross)) issue('COMPONENT_TOTAL_MISMATCH');
      if (component.taxComponents.reduce((sum, tax) => sum + amount(tax.amount), BigInt(0)) !== amount(component.tax)) issue('TAX_COMPONENT_TOTAL_MISMATCH');
    }
    for (const field of ['net', 'tax', 'gross'] as const) {
      if (snapshot.components.reduce((sum, component) => sum + amount(component[field]), BigInt(0)) !== amount(snapshot.totals[field])) issue('SNAPSHOT_TOTAL_MISMATCH');
      if (amount(snapshot.totals[field]) < BigInt(0)) issue('NEGATIVE_CONTRACT_TOTAL');
    }
    if (amount(snapshot.totals.net) + amount(snapshot.totals.tax) !== amount(snapshot.totals.gross)) issue('SNAPSHOT_EQUATION_MISMATCH');
  }).transform(snapshot => ({ ...snapshot,
    components: snapshot.components === null ? null : sortedComponents(snapshot.components),
    ...(snapshot.reviewState === 'NEEDS_REVIEW' ? { missingFields: [...snapshot.missingFields].sort(binary) } : {}),
  } as typeof snapshot));
export type FinancialSnapshotV1 = z.infer<typeof financialSnapshotV1Schema>;
export type CompleteFinancialSnapshotV1 = Extract<FinancialSnapshotV1, { reviewState: 'COMPLETE' }>;

export function normalizeFinancialSnapshotV1(input: unknown): FinancialSnapshotV1 {
  return immutable(financialSnapshotV1Schema.parse(input));
}
export function financialSnapshotHash(input: unknown): string {
  return digest({ hashContractVersion: 'financial-snapshot-hash-v1', snapshot: normalizeFinancialSnapshotV1(input) });
}

/** Exact decimal input adapter only. Extra nonzero fractional digits are denied;
 * redundant fractional zeroes can be discarded without rounding. The caller
 * supplies the controlled currency definition; no defaults or money Numbers. */
export function moneyFromDecimal(decimal: string, rawDefinition: z.infer<typeof currencyDefinitionSchema>): MoneyV2 {
  const definition = currencyDefinitionSchema.parse(rawDefinition);
  if (typeof decimal !== 'string' || decimal.length > 100 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(decimal)) throw new Error('INVALID_DECIMAL_MONEY');
  const negative = decimal.startsWith('-'), unsigned = negative ? decimal.slice(1) : decimal;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const scale = definition.minorUnitExponent;
  if (fraction.slice(scale).replace(/0/g, '')) throw new Error('ROUNDING_POLICY_REQUIRED');
  const magnitude = BigInt(whole + fraction.slice(0, scale).padEnd(scale, '0'));
  return immutable(moneyV2Schema.parse({ minorUnits: (negative ? -magnitude : magnitude).toString(),
    currency: definition.code, minorUnitExponent: scale }));
}

const approvalActionV2Base = z.strictObject({
  actionContractVersion: z.literal('approval-action-v2'),
  actionId: id, workflowId: id, tenantId: id, requestingActorId: id, correlationId: id,
  actionType: z.literal('contract.send'), resourceType: z.literal('Contract'), resourceId: id,
  actionVersion: version, resourceVersion: version,
  payload: z.strictObject({
    recipient: z.strictObject({ id, email: z.email().max(254) }),
    contract: z.strictObject({ id, version, content: z.string().min(1).max(20_000) }),
    scope: z.strictObject({ projectId: id, description: z.string().min(1).max(5_000) }),
  }),
  financialSnapshot: financialSnapshotV1Schema,
  financialSnapshotHash: hash,
  economicCommitment: z.strictObject({ basis: z.literal('NET'), amount: moneyV2Schema.nullable() }),
});
function refineAction(action: z.infer<typeof approvalActionV2Base>, context: z.RefinementCtx): void {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  // A nested format/refinement error is already attached to the action. Keep
  // safeParse nonthrowing instead of re-entering a throwing hash parser.
  const parsedSnapshot = financialSnapshotV1Schema.safeParse(action.financialSnapshot);
  if (!parsedSnapshot.success) return;
  const snapshot = parsedSnapshot.data;
  if (snapshot.tenantId !== action.tenantId || snapshot.resourceId !== action.resourceId
    || snapshot.businessVersion !== action.resourceVersion) issue('FINANCIAL_RESOURCE_BINDING_MISMATCH');
  if (action.financialSnapshotHash !== digest({ hashContractVersion: 'financial-snapshot-hash-v1', snapshot })) issue('FINANCIAL_SNAPSHOT_HASH_MISMATCH');
  if (snapshot.totals.net === null ? action.economicCommitment.amount !== null
    : action.economicCommitment.amount === null || !sameMoney(action.economicCommitment.amount, snapshot.totals.net)) issue('ECONOMIC_COMMITMENT_MISMATCH');
}
export const approvalActionV2InputSchema = approvalActionV2Base.superRefine(refineAction);
export type ApprovalActionV2Input = z.infer<typeof approvalActionV2InputSchema>;
export const approvalActionV2Schema = approvalActionV2Base.extend({
  environment: z.literal('preview'), synthetic: z.literal(true),
}).superRefine(refineAction);
export type ApprovalActionV2 = z.infer<typeof approvalActionV2Schema>;
export function normalizeApprovalActionV2(input: unknown): ApprovalActionV2 {
  return immutable(approvalActionV2Schema.parse(input));
}
export function approvalActionV2Hash(input: unknown): string {
  return digest({ hashContractVersion: 'approval-action-hash-v2', action: normalizeApprovalActionV2(input) });
}

export type V2ThresholdContext = Readonly<
  | { status: 'NEEDS_REVIEW'; basis: 'NET' }
  | { status: 'POLICY_REQUIRED'; basis: 'NET' }
  | { status: 'READY'; basis: 'NET'; currency: 'EUR'; atLeast5000: boolean }
>;
/** This is readiness/threshold comparison, not an approval or tax decision.
 * Shared approval evidence still determines the existing 0/1 steps below EUR5000. */
export function v2ThresholdContext(input: unknown): V2ThresholdContext {
  const action = normalizeApprovalActionV2(input);
  if (action.financialSnapshot.reviewState === 'NEEDS_REVIEW') return Object.freeze({ status: 'NEEDS_REVIEW', basis: 'NET' });
  const net = action.financialSnapshot.totals.net;
  if (net.currency !== 'EUR' || net.minorUnitExponent !== 2) return Object.freeze({ status: 'POLICY_REQUIRED', basis: 'NET' });
  return Object.freeze({ status: 'READY', basis: 'NET', currency: 'EUR', atLeast5000: amount(net) >= BigInt(500_000) });
}
