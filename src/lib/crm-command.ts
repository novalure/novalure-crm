import { createHash, randomUUID } from "node:crypto";
import type { AppSession } from "./auth/session";
import { getRolePermissions, isAppRole } from "./auth/permissions";
import { getProductRoleCapabilities, hasProductCapability, isProductRole, type ProductCapability } from "./product-model";
import { withTenantTransaction, type TenantTransaction, type TenantTransactionOptions } from "./db/tenant-client";
import { currentTenantTransaction, runWithTenantTransaction } from "./db/transaction-context";

export type { TenantTransaction, TenantTransactionOptions } from "./db/tenant-client";
export type CrmDataClassification = "CUSTOMER_TENANT" | "NOVALURE_INTERNAL";
export type CrmCommandInput = Readonly<{
  operation: string;
  resourceId?: string;
  projectId?: string;
  expectedVersion?: number;
  idempotencyKey: string;
  correlationId: string;
  payload: unknown;
  capability: ProductCapability;
}>;
export type CrmCommandContext = Readonly<{
  session: AppSession;
  workspaceId: string;
  actorId: string;
  commandId: string;
  auditReference: string;
  correlationId: string;
  projectId?: string;
  expectedVersion?: number;
  dataClassification: CrmDataClassification;
  purpose: "crm_sales";
}>;
export class CrmCommandError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "CrmCommandError";
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function assertCrmUuid(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new CrmCommandError("VALIDATION_ERROR", `Invalid ${label}`);
  return value;
}
export function assertExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CrmCommandError("VERSION_REQUIRED", "A positive integer expectedVersion is required", 409);
  }
  return value;
}
export function assertMoneyCents(value: unknown, label = "amountCents"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CrmCommandError("INVALID_MONEY", `${label} must be non-negative safe integer EUR cents`);
  }
  return value;
}
export function assertCrmFields(payload: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(payload).some((key) => !fields.includes(key))) throw new CrmCommandError("UNKNOWN_FIELD", "Unknown command field");
}
export function crmRequestMetadata(request: Request, payload: Record<string, unknown>) {
  const idempotencyKey = request.headers.get("idempotency-key") ?? payload.idempotencyKey;
  const correlationId = request.headers.get("x-correlation-id") ?? payload.correlationId;
  if (typeof idempotencyKey !== "string" || !uuidV4.test(idempotencyKey)) {
    throw new CrmCommandError("IDEMPOTENCY_REQUIRED", "A UUID v4 Idempotency-Key is required");
  }
  assertCrmUuid(correlationId, "correlationId");
  return { idempotencyKey, correlationId: correlationId as string };
}
export function crmCommandErrorResponse(error: unknown, correlationId?: string): Response {
  if (error instanceof CrmCommandError) return Response.json({ error: error.message, code: error.code, correlationId: correlationId ?? null, contractVersion: "1" }, { status: error.status });
  const sqlCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["23505", "40001", "40P01"].includes(sqlCode)) return Response.json({ error: "The record changed or the operation already exists", code: "CONFLICT", correlationId: correlationId ?? null, contractVersion: "1" }, { status: 409 });
  if (["23503", "23514", "22P02"].includes(sqlCode)) return Response.json({ error: "Invalid record relationship or value", code: "VALIDATION_ERROR", correlationId: correlationId ?? null, contractVersion: "1" }, { status: 400 });
  if (sqlCode === "42501") return Response.json({ error: "Access denied", code: "FORBIDDEN", correlationId: correlationId ?? null, contractVersion: "1" }, { status: 403 });
  return Response.json({ error: "CRM operation unavailable; retry with the same idempotency key", code: "CRM_UNAVAILABLE", correlationId: correlationId ?? null, contractVersion: "1" }, { status: 503 });
}

export function crmPayloadDigest(value: unknown): string {
  const seen = new WeakSet<object>();
  function canonical(item: unknown): unknown {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || !item || seen.has(item)) throw new CrmCommandError("INVALID_PAYLOAD", "Payload must contain finite JSON values");
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = item.map(canonical);
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new CrmCommandError("INVALID_PAYLOAD", "Payload must be plain JSON");
      result = Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]));
    }
    seen.delete(item);
    return result;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

async function currentMember(tx: TenantTransaction, session: AppSession) {
  if (!session.authenticated || session.source === "demo" || !uuid.test(session.workspaceId) || !uuid.test(session.userId)) {
    throw new CrmCommandError("UNAUTHENTICATED", "An authenticated persisted workspace identity is required", 401);
  }
  const member = await tx.queryOne<{ role: string; productRole: string; operatingModel: string; authIdentityId: string | null }>(`
    select role, product_role as "productRole", operating_model as "operatingModel", auth_identity_id as "authIdentityId"
    from crm_lock_active_member($2::uuid,$1::uuid)
  `, [session.userId, session.workspaceId]);
  if (!member || !isAppRole(member.role) || !isProductRole(member.productRole)) throw new CrmCommandError("FORBIDDEN", "Active workspace membership is required", 403);
  if (session.authIdentityId && member.authIdentityId !== session.authIdentityId) throw new CrmCommandError("IDENTITY_MISMATCH", "Membership is not bound to this identity", 403);
  if (session.authSessionId) {
    const active = await tx.queryOne<{ active: boolean }>(`select crm_lock_active_session($1::uuid,$2::uuid) as active`, [assertCrmUuid(session.authSessionId), assertCrmUuid(session.authIdentityId)]);
    if (!active?.active) throw new CrmCommandError("SESSION_REVOKED", "Session is expired or revoked", 401);
  }
  const dataClassification: CrmDataClassification = member.operatingModel === "novalure_internal" ? "NOVALURE_INTERNAL" : "CUSTOMER_TENANT";
  if (!["novalure_internal", "self_service_customer", "managed_by_novalure", "hybrid"].includes(member.operatingModel)) throw new CrmCommandError("DATA_CONTEXT_REQUIRED", "Workspace data classification is unresolved", 403);
  const resolved: AppSession = { ...session, role: member.role, productRole: member.productRole, permissions: getRolePermissions(member.role), productPermissions: getProductRoleCapabilities(member.productRole) };
  if (!resolved.permissions.includes("crm:read")) throw new CrmCommandError("FORBIDDEN", "CRM read permission is required", 403);
  if (dataClassification === "NOVALURE_INTERNAL" && !hasProductCapability(resolved.productRole, "novalure:internal")) throw new CrmCommandError("DATA_SCOPE_DENIED", "Internal data requires an internal membership", 403);
  return { session: resolved, dataClassification };
}

export async function assertProjectGrant(tx: TenantTransaction, session: AppSession, projectId: string, write = false) {
  assertCrmUuid(projectId, "projectId");
  // This checks the executing transaction actor, never an arbitrary recipient's rights.
  const allowed = await tx.queryOne<{ allowed: boolean }>(`select crm_lock_project_access($1::uuid,$2::uuid,$3::boolean) and nullif(current_setting('app.actor_id',true),'')::uuid=$4::uuid as allowed`, [session.workspaceId, projectId, write, session.userId]);
  if (!allowed?.allowed) throw new CrmCommandError("PROJECT_FORBIDDEN", "Project access is not granted", 403);
  const exists = await tx.queryOne(`select id from projects where id=$1::uuid and workspace_id=$2::uuid`, [projectId, session.workspaceId]);
  if (!exists) throw new CrmCommandError("PROJECT_FORBIDDEN", "Project access is not granted", 403);
}

export async function withCrmRead<T>(session: AppSession, callback: (tx: TenantTransaction, session: AppSession) => Promise<T>, options: TenantTransactionOptions = {}): Promise<T> {
  const scope = { actorId: session.userId, workspaceId: session.workspaceId };
  const active = currentTenantTransaction();
  if (active) {
    if (active.scope.actorId !== scope.actorId || active.scope.workspaceId !== scope.workspaceId) throw new CrmCommandError("TENANT_MISMATCH", "Nested scope differs", 403);
    const member = await currentMember(active.transaction, session);
    return callback(active.transaction, member.session);
  }
  return withTenantTransaction(scope, (tx) => runWithTenantTransaction(scope, tx, async () => {
    const member = await currentMember(tx, session);
    return callback(tx, member.session);
  }), options);
}

export async function executeCrmCommand<T>(session: AppSession, input: CrmCommandInput, callback: (tx: TenantTransaction, context: CrmCommandContext) => Promise<T>, options: TenantTransactionOptions = {}): Promise<{ data: T; replayed: boolean; auditReference: string; commandId: string }> {
  if (!/^[a-z][a-z0-9_.:-]{2,119}$/i.test(input.operation)) throw new CrmCommandError("INVALID_OPERATION", "Invalid command operation");
  if (!uuidV4.test(input.idempotencyKey)) throw new CrmCommandError("IDEMPOTENCY_REQUIRED", "A UUID v4 idempotency key is required");
  assertCrmUuid(input.correlationId, "correlationId");
  if (input.resourceId) assertCrmUuid(input.resourceId, "resourceId");
  if (input.projectId) assertCrmUuid(input.projectId, "projectId");
  if (input.expectedVersion !== undefined) assertExpectedVersion(input.expectedVersion);
  return withCrmRead(session, async (tx, freshSession) => {
    if (!freshSession.permissions.includes("crm:write") || !hasProductCapability(freshSession.productRole, input.capability)) throw new CrmCommandError("FORBIDDEN", "Command capability is not granted", 403);
    if (input.projectId) await assertProjectGrant(tx, freshSession, input.projectId, true);
    const { dataClassification } = await currentMember(tx, freshSession);
    const digest = crmPayloadDigest({ contractVersion: "1", actorId: session.userId, workspaceId: session.workspaceId, operation: input.operation, resourceId: input.resourceId, projectId: input.projectId, expectedVersion: input.expectedVersion, capability: input.capability, payload: input.payload, dataClassification, purpose: "crm_sales" });
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`crm-command:${session.workspaceId}:${input.idempotencyKey}`]);
    const existing = await tx.queryOne<{ requestHash: string; data: T; auditReference: string; commandId: string }>(`select request_hash as "requestHash", response as data, audit_reference as "auditReference", id as "commandId" from crm_command_receipts where workspace_id=$1::uuid and idempotency_key=$2`, [session.workspaceId, input.idempotencyKey]);
    if (existing) {
      if (existing.requestHash !== digest) throw new CrmCommandError("IDEMPOTENCY_CONFLICT", "The idempotency key belongs to a different command", 409);
      return { data: existing.data, replayed: true, auditReference: existing.auditReference, commandId: existing.commandId };
    }
    const context: CrmCommandContext = Object.freeze({ session: freshSession, actorId: session.userId, workspaceId: session.workspaceId, commandId: randomUUID(), auditReference: randomUUID(), correlationId: input.correlationId, projectId: input.projectId, expectedVersion: input.expectedVersion, dataClassification, purpose: "crm_sales" });
    const data = await callback(tx, context);
    if (data && typeof data === "object" && "persisted" in data && data.persisted === false) throw new CrmCommandError("COMMAND_REJECTED", "The CRM command was not persisted", 409);
    const encoded = JSON.stringify(data);
    if (encoded === undefined) throw new CrmCommandError("INVALID_RESULT", "Command must return a JSON result", 500);
    const entityId = input.resourceId ?? (data && typeof data === "object" && "id" in data && typeof data.id === "string" && uuid.test(data.id) ? data.id : null);
    await tx.execute(`insert into audit_logs(id,workspace_id,actor_user_id,project_id,action,entity_type,entity_id,after) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'crm_command',$6::uuid,$7::jsonb)`, [context.auditReference, context.workspaceId, context.actorId, input.projectId ?? null, input.operation, entityId, JSON.stringify({ commandId: context.commandId, correlationId: input.correlationId, requestHash: digest, expectedVersion: input.expectedVersion ?? null, dataClassification, purpose: context.purpose })]);
    await tx.execute(`insert into crm_command_receipts(id,workspace_id,project_id,actor_user_id,operation,resource_id,idempotency_key,request_hash,response,audit_reference,correlation_id,data_classification) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7,$8,$9::jsonb,$10::uuid,$11::uuid,$12)`, [context.commandId, context.workspaceId, input.projectId ?? null, context.actorId, input.operation, entityId, input.idempotencyKey, digest, encoded, context.auditReference, input.correlationId, dataClassification]);
    await tx.execute(`insert into crm_domain_events(workspace_id,project_id,actor_user_id,event_type,resource_id,command_id,audit_reference,correlation_id,payload,data_classification) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::jsonb,$10)`, [context.workspaceId, input.projectId ?? null, context.actorId, input.operation, entityId, context.commandId, context.auditReference, input.correlationId, JSON.stringify({ contractVersion: "1", operation: input.operation, expectedVersion: input.expectedVersion ?? null }), dataClassification]);
    return { data, replayed: false, auditReference: context.auditReference, commandId: context.commandId };
  }, options);
}

/** Future service vocabulary only: no token issuer, principal or external connection is enabled. */
export const CRM_SERVICE_SCOPES = Object.freeze(["crm.contacts.read", "crm.contacts.write", "crm.projects.read", "crm.projects.write", "crm.leads.read", "crm.leads.write", "crm.offers.read", "crm.offers.prepare", "crm.tasks.read", "crm.tasks.write", "crm.reservations.read", "crm.reservations.prepare", "crm.sales.read", "crm.communications.write"] as const);
export function assertCrmServiceContext(value: { scopes: readonly string[]; workspaceId: string; projectIds: readonly string[]; classification: string; purpose: string }) {
  assertCrmUuid(value.workspaceId, "workspaceId");
  if (!value.scopes.length || value.scopes.some((scope) => !(CRM_SERVICE_SCOPES as readonly string[]).includes(scope)) || !value.projectIds.length || value.projectIds.some((id) => !uuid.test(id)) || !["CUSTOMER_TENANT", "NOVALURE_INTERNAL"].includes(value.classification) || value.purpose !== "crm_sales") throw new CrmCommandError("SERVICE_SCOPE_DENIED", "Explicit narrow service context is required", 403);
  throw new CrmCommandError("SERVICE_INTEGRATION_DISABLED", "No service principal authentication is enabled", 403);
}
