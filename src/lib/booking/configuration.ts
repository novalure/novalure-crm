import "server-only";
import type { AppSession } from "@/lib/auth/session";
import type { TenantTransaction, TenantTransactionOptions } from "@/lib/crm-command";
import { bookingAudit, bookingResourceLock, readRules, withBookingTransaction } from "./repository";
import { defaultBookingRules, validateBookingRules } from "./rules";
import { BookingError, type BookingKind, type BookingRules } from "./types";
import {
  defaultBookingTravelSettings,
  type BookingLocation,
  type BookingSetupKind,
  type BookingSetupLayer,
  type BookingSetupScope,
  type BookingSetupSection,
  type BookingTravelSettings,
} from "./setup-types";
import { BookingTemplateError, defaultBookingCommunication, validateBookingCommunication, type BookingCommunicationSettings } from "./templates";

export const bookingSetupKinds: BookingKind[] = ["phone", "teams", "meet", "office", "onsite"];
const travelFields = new Set(Object.keys(defaultBookingTravelSettings));
const copy = <T>(value: T): T => structuredClone(value);
type SetupRow = { userId: string | null; kind: BookingSetupKind; travel: Partial<BookingTravelSettings>; communication: Partial<BookingCommunicationSettings>; companyResets: Partial<Record<BookingSetupSection, string[]>>; revision: number };
type RuleRow = { userId: string | null; kind: BookingSetupKind; rules: Partial<BookingRules>; revision: number };
export type EffectiveBookingSetup = { rules: BookingRules; travel: BookingTravelSettings; communication: BookingCommunicationSettings };

function validateCommunication(value: unknown) {
  try { return validateBookingCommunication(value); }
  catch (error) { if (error instanceof BookingTemplateError) throw new BookingError(error.code); throw error; }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function text(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
}
const boundedInteger = (value: unknown, max: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

export function validateBookingTravelSettings(value: unknown): BookingTravelSettings {
  if (!isObject(value) || Object.keys(value).some(key => !travelFields.has(key))) throw new BookingError("INVALID_TRAVEL_SETTINGS");
  for (const key of ["enabled", "directTravel", "returnToEndLocation"] as const) if (typeof value[key] !== "boolean") throw new BookingError("INVALID_TRAVEL_SETTINGS");
  if (!boundedInteger(value.additionalBufferMinutes, 240) || value.maxDriveMinutes !== null && !boundedInteger(value.maxDriveMinutes, 720)) throw new BookingError("INVALID_TRAVEL_SETTINGS");
  if (!Array.isArray(value.locations) || value.locations.length > 30) throw new BookingError("INVALID_TRAVEL_LOCATIONS");
  const locations = value.locations as unknown[];
  const ids = new Set<string>();
  for (const location of locations) {
    if (!isObject(location) || Object.keys(location).some(key => !["id", "label", "address", "confirmed"].includes(key)) ||
      !text(location.id, 80) || !/^[a-zA-Z0-9_-]+$/.test(location.id) || ids.has(location.id) || !text(location.label, 100) ||
      !text(location.address, 500) || typeof location.confirmed !== "boolean") throw new BookingError("INVALID_TRAVEL_LOCATIONS");
    ids.add(location.id);
  }
  for (const key of ["startLocationId", "endLocationId", "onlineLocationId"] as const) {
    const id = value[key];
    if (id !== null && (!text(id, 80) || !ids.has(id))) throw new BookingError("INVALID_TRAVEL_LOCATION_REFERENCE");
  }
  if (value.enabled) {
    const confirmed = (id: unknown) => locations.some(location => (location as BookingLocation).id === id && (location as BookingLocation).confirmed);
    if (!confirmed(value.startLocationId) || !confirmed(value.onlineLocationId) || value.returnToEndLocation && !confirmed(value.endLocationId)) throw new BookingError("TRAVEL_LOCATION_REQUIRED");
  }
  return copy(value as BookingTravelSettings);
}

async function setupRows(tx: TenantTransaction, session: AppSession, kind: BookingSetupKind, workspaceOnly = false) {
  return tx.query<SetupRow>(`select user_id as "userId",kind,travel,communication,company_resets as "companyResets",revision::int from booking_setup_sets
    where workspace_id=$1::uuid and (user_id is null or (user_id=$2::uuid and not $4::boolean)) and kind in ('*',$3)
    order by (user_id is not null)::int,(kind<>'*')::int`, [session.workspaceId, session.userId, kind, workspaceOnly]);
}

function resolveSection<T extends object>(base: T, rows: Array<{ userId: string | null; kind: BookingSetupKind; value: Partial<T>; resets?: string[] }>, kind: BookingSetupKind, companyOnly = false): T {
  const applicable = rows.filter(row => row.kind === "*" || row.kind === kind).sort((a, b) => Number(a.userId !== null) - Number(b.userId !== null) || Number(a.kind !== "*") - Number(b.kind !== "*"));
  const company = applicable.filter(row => row.userId === null).reduce<T>((current, row) => ({ ...current, ...row.value }), copy(base));
  if (companyOnly) return company;
  const current = copy(company);
  for (const row of applicable.filter(row => row.userId !== null)) {
    for (const field of row.resets ?? []) if (Object.hasOwn(company, field)) {
      const key = field as keyof T;
      current[key] = copy(company[key]);
    }
    Object.assign(current, row.value);
  }
  return current;
}

/** Called inside the same tenant transaction as the authoritative booking rules. */
export async function readBookingSetup(tx: TenantTransaction, session: AppSession, kind: BookingSetupKind, workspaceOnly = false): Promise<EffectiveBookingSetup> {
  const rows = await setupRows(tx, session, kind, workspaceOnly);
  return {
    rules: await readRules(tx, session, kind, workspaceOnly),
    travel: resolveSection(defaultBookingTravelSettings, rows.map(row => ({ ...row, value: row.travel, resets: row.companyResets.travel })), kind, workspaceOnly),
    communication: resolveSection(defaultBookingCommunication, rows.map(row => ({ ...row, value: row.communication, resets: row.companyResets.communication })), kind, workspaceOnly),
  };
}

async function setupSnapshot(tx: TenantTransaction, session: AppSession) {
  const rules = await tx.query<RuleRow>(`select user_id as "userId",kind,rules,revision::int from booking_rule_sets
    where workspace_id=$1::uuid and (user_id is null or user_id=$2::uuid) order by (user_id is not null)::int,kind`, [session.workspaceId, session.userId]);
  const settings = await tx.query<SetupRow>(`select user_id as "userId",kind,travel,communication,company_resets as "companyResets",revision::int from booking_setup_sets
    where workspace_id=$1::uuid and (user_id is null or user_id=$2::uuid) order by (user_id is not null)::int,kind`, [session.workspaceId, session.userId]);
  const layers: Array<BookingSetupLayer & { ruleRevision: number; setupRevision: number }> = [];
  for (const scope of ["company", "employee"] as const) for (const kind of ["*", ...bookingSetupKinds] as const) {
    const userId = scope === "company" ? null : session.userId;
    const r = rules.find(row => row.userId === userId && row.kind === kind);
    const s = settings.find(row => row.userId === userId && row.kind === kind);
    if (!r && !s) continue;
    layers.push({ scope, kind, rules: r?.rules ?? {}, travel: s?.travel ?? {}, communication: s?.communication ?? {}, companyResets: s?.companyResets ?? {},
      revision: Math.max(r?.revision ?? 0, s?.revision ?? 0), ruleRevision: r?.revision ?? 0, setupRevision: s?.revision ?? 0 });
  }
  const effective = {} as Record<BookingKind, EffectiveBookingSetup>;
  const companyDefaults = {} as Record<BookingKind, EffectiveBookingSetup>;
  const merge = (kind: BookingSetupKind, companyOnly: boolean): EffectiveBookingSetup => {
    const identity = (layer: BookingSetupLayer) => ({ userId: layer.scope === "company" ? null : session.userId, kind: layer.kind });
    return {
      rules: resolveSection(defaultBookingRules, layers.map(layer => ({ ...identity(layer), value: layer.rules, resets: layer.companyResets.rules })), kind, companyOnly),
      travel: resolveSection(defaultBookingTravelSettings, layers.map(layer => ({ ...identity(layer), value: layer.travel, resets: layer.companyResets.travel })), kind, companyOnly),
      communication: resolveSection(defaultBookingCommunication, layers.map(layer => ({ ...identity(layer), value: layer.communication, resets: layer.companyResets.communication })), kind, companyOnly),
    };
  };
  for (const kind of bookingSetupKinds) {
    effective[kind] = merge(kind, false);
    companyDefaults[kind] = merge(kind, true);
  }
  return { layers, effective, companyDefaults, effectiveDefaults: merge("*", false), companyBaseDefaults: merge("*", true), canManageCompany: session.productPermissions.includes("workspace:admin") };
}

export async function getBookingSetup(session: AppSession, options: TenantTransactionOptions = {}) {
  return withBookingTransaction(session, setupSnapshot, options);
}

export type BookingSetupMutation = {
  scope: BookingSetupScope;
  kind: BookingSetupKind;
  section: BookingSetupSection;
  value?: Record<string, unknown>;
  fields?: string[];
  expectedRevision?: number;
};

export function validateBookingSetupMutation(input: unknown, reset = false): BookingSetupMutation {
  if (!isObject(input) || Object.keys(input).some(key => !["scope", "kind", "section", "value", "fields", "expectedRevision"].includes(key)) ||
    !["company", "employee"].includes(String(input.scope)) || !["*", ...bookingSetupKinds].includes(String(input.kind)) ||
    !["rules", "travel", "communication"].includes(String(input.section))) throw new BookingError("INVALID_BOOKING_SETUP");
  if (input.expectedRevision !== undefined && !boundedInteger(input.expectedRevision, 2_147_483_647)) throw new BookingError("INVALID_BOOKING_SETUP");
  if (!reset && (!isObject(input.value) || input.fields !== undefined)) throw new BookingError("INVALID_BOOKING_SETUP");
  if (reset && (input.value !== undefined || input.fields !== undefined && (!Array.isArray(input.fields) || input.fields.length > 25 || input.fields.some(field => !text(field, 80))))) throw new BookingError("INVALID_BOOKING_SETUP");
  return input as BookingSetupMutation;
}

export async function saveBookingSetup(session: AppSession, input: BookingSetupMutation, options: TenantTransactionOptions = {}, reset = false) {
  validateBookingSetupMutation(input, reset);
  return withBookingTransaction(session, async (tx, fresh) => {
    if (input.scope === "company" && !fresh.productPermissions.includes("workspace:admin")) throw new BookingError("BOOKING_FORBIDDEN", 403);
    // Company defaults are shared by all employee resources. Take the exclusive
    // workspace lock before the common shared-workspace/employee lock order.
    if (input.scope === "company") await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`booking-workspace:${fresh.workspaceId}`]);
    await bookingResourceLock(tx, fresh);
    const table = input.section === "rules" ? "booking_rule_sets" : "booking_setup_sets";
    const field = input.section;
    const userId = input.scope === "company" ? null : fresh.userId;
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`booking-setup:${fresh.workspaceId}:${userId ?? "company"}:${input.kind}`]);
    const existing = await tx.queryOne<{ id: string; value: Record<string, unknown>; revision: number }>(`select id,${field} as value,revision::int from ${table}
      where workspace_id=$1::uuid and user_id is not distinct from $2::uuid and kind=$3 for update`, [fresh.workspaceId, userId, input.kind]);
    if (input.expectedRevision !== undefined && input.expectedRevision !== (existing?.revision ?? 0)) throw new BookingError("BOOKING_SETUP_CHANGED", 409);
    const metadata = await tx.queryOne<{ companyResets: Partial<Record<BookingSetupSection, string[]>> }>(`select company_resets as "companyResets" from booking_setup_sets
      where workspace_id=$1::uuid and user_id is not distinct from $2::uuid and kind=$3 for update`, [fresh.workspaceId, userId, input.kind]);
    const companyResets = copy(metadata?.companyResets ?? {});
    const inherited = await readBookingSetup(tx, fresh, input.kind, input.scope === "company");
    const patch = input.value ?? {};
    let value = { ...(existing?.value ?? {}), ...patch };
    const allowed = field === "rules" ? Object.keys(inherited.rules) : field === "travel" ? [...travelFields] : Object.keys(defaultBookingCommunication);
    if (reset) {
      const fields = input.fields ?? allowed;
      for (const key of fields) {
        if (!allowed.includes(key)) throw new BookingError("INVALID_BOOKING_SETUP");
        delete value[key];
      }
      companyResets[field] = input.scope === "employee" ? [...new Set([...(companyResets[field] ?? []), ...fields])] : [];
    } else if (field === "rules") validateBookingRules(patch as Partial<BookingRules>);
    else if (field === "travel") {
      if (Object.keys(patch).some(key => !travelFields.has(key))) throw new BookingError("INVALID_TRAVEL_SETTINGS");
      validateBookingTravelSettings({ ...inherited.travel, ...value });
    } else {
      if (Object.keys(patch).some(key => !Object.hasOwn(defaultBookingCommunication, key))) throw new BookingError("INVALID_COMMUNICATION_SETTINGS");
      const validated = validateCommunication({ ...inherited.communication, ...value });
      value = Object.fromEntries(Object.keys(value).map(key => [key, validated[key as keyof BookingCommunicationSettings]]));
    }
    if (!reset) companyResets[field] = (companyResets[field] ?? []).filter(key => !Object.hasOwn(patch, key));
    const row = await tx.queryOne<{ id: string }>(`insert into ${table}(workspace_id,user_id,kind,${field}${field === "rules" ? "" : ",company_resets"}) values($1::uuid,$2::uuid,$3,$4::jsonb${field === "rules" ? "" : ",$5::jsonb"})
      on conflict(workspace_id,user_id,kind) do update set ${field}=excluded.${field}${field === "rules" ? "" : ",company_resets=excluded.company_resets"},revision=${table}.revision+1,updated_at=now() returning id`,
      [fresh.workspaceId, userId, input.kind, JSON.stringify(value), ...(field === "rules" ? [] : [JSON.stringify(companyResets)])]);
    if (field === "rules") await tx.execute(`insert into booking_setup_sets(workspace_id,user_id,kind,company_resets) values($1::uuid,$2::uuid,$3,$4::jsonb)
      on conflict(workspace_id,user_id,kind) do update set company_resets=excluded.company_resets,revision=booking_setup_sets.revision+1,updated_at=now()`, [fresh.workspaceId, userId, input.kind, JSON.stringify(companyResets)]);
    await bookingAudit(tx, fresh, reset ? "booking.setup_reset" : "booking.setup_updated", row!.id, { scope: input.scope, kind: input.kind, section: input.section });
    const snapshot = await setupSnapshot(tx, fresh);
    for (const config of [...Object.values(snapshot.effective), ...Object.values(snapshot.companyDefaults), snapshot.effectiveDefaults, snapshot.companyBaseDefaults]) {
      validateBookingTravelSettings(config.travel);
      validateCommunication(config.communication);
    }
    return snapshot;
  }, options);
}
