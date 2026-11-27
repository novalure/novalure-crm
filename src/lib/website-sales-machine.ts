import "server-only";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import type { AppSession } from "./auth/session";
import { getRolePermissions } from "./auth/permissions";
import { getProductRoleCapabilities } from "./product-model";
import { queryAuthenticationRows } from "./db/tenant-client";
import { assertCrmFields, assertCrmUuid, crmPayloadDigest, CrmCommandError, withCrmCommandPreflight,
  withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "./crm-command";
import { CrmMachineAuthError, getCrmMachineBearer, verifyCrmMachineToken, type CrmMachineAuthOptions } from "./crm-machine-auth";
import { readKnowledgeJson } from "./knowledge-center/http";
import { KnowledgeCenterError } from "./knowledge-center/policy";
import { getWebsiteSalesIrelandWorkflow, reconcileWebsiteSalesIrelandCommand, runWebsiteSalesIrelandCommand,
  validateWebsiteSalesIrelandCommand, websiteSalesIrelandCommandInput, websiteSalesIrelandContract, type WebsiteSalesIrelandCommand } from "./db/website-sales-ireland-repositories";
import { withWebsiteSalesMachineAuthority, type WebsiteSalesMachineAuthority } from "./website-sales-machine-authority";
import {
  verifyWebsiteSalesPreviewToken, websiteSalesPreviewIdentity, websiteSalesPreviewReceiver, websiteSalesProductionIdentity,
} from "./website-sales-preview-auth";

export const websiteSalesMachineContract = "website-sales-machine-v1";
export const websiteSalesMachinePath = "/api/integrations/evelyn/website-sales";
export const websiteSalesMachineDelegationDomain = `${websiteSalesMachineContract}.POST.${websiteSalesMachinePath}`;
export const websiteSalesMachineScopes = ["crm.website-sales.read", "crm.website-sales.qualify", "crm.website-sales.reconcile"] as const;
export type WebsiteSalesMachineScope = typeof websiteSalesMachineScopes[number];
export type WebsiteSalesDelegationPayload = { issuedAt: number; expiresAt: number; nonce: string; requestHash: string };
export type WebsiteSalesMachineRead = { projectId: string; companyId: string; locationId: string; correlationId: string };
export type WebsiteSalesMachineRequest = { contractVersion: typeof websiteSalesMachineContract; target?: "workflow" } & (
  { operation: "execute"; request: WebsiteSalesIrelandCommand } |
  { operation: "reconcile"; request: WebsiteSalesIrelandCommand } |
  { operation: "read"; request: WebsiteSalesMachineRead });
export type WebsiteSalesMachineOptions = TenantTransactionOptions & { machineAuth?: CrmMachineAuthOptions };
type Grant = { id: string; workload_id: string; workspace_id: string; actor_user_id: string; project_id: string;
  company_id: string; location_id: string; department_id: "SALES"; agent_id: string; task_id: string;
  scopes: WebsiteSalesMachineScope[]; delegation_public_key: string; authority_reference: string; preview_source_grant_id: string | null };
type Principal = { id: string; workspace_id: string; identity_id: string };
const grantSql = "select * from public.crm_lock_website_sales_machine_grant($1::uuid,$2::uuid,$3,$4)";
const principalSql = "select * from public.crm_authenticate_website_sales_workload($1,$2,$3,$4,$5,$6::uuid,$7,$8,$9)";
const sourceWorkloadSql = "select id,workspace_id,identity_id from public.crm_authenticate_autonomous_workload($1,$2,$3,$4,$5,$6::uuid,$7)";
function isSourceWorkload(principal: Principal | null | undefined, workspaceId: string): principal is Principal {
  return principal?.identity_id === "EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY" && principal.workspace_id === workspaceId;
}
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function denied(code = "SALES_ACCESS_DENIED", status = 403): never { throw new CrmCommandError(code, code, status); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) denied("INVALID_REQUEST", 400);
  return value as Record<string, unknown>;
}
function parseRequest(value: unknown): WebsiteSalesMachineRequest {
  const body = object(value);
  assertCrmFields(body, ["contractVersion", "target", "operation", "request"]);
  if (body.contractVersion !== websiteSalesMachineContract || !["execute", "read", "reconcile"].includes(String(body.operation))) denied("INVALID_REQUEST", 400);
  if (body.target !== undefined && body.target !== "workflow") denied("SALES_OPERATION_NOT_GRANTED");
  const request = object(body.request);
  if (body.operation === "read") {
    assertCrmFields(request, ["projectId", "companyId", "locationId", "correlationId"]);
    for (const name of ["projectId", "companyId", "locationId", "correlationId"]) assertCrmUuid(request[name], name);
  } else {
    if (request.contractVersion !== websiteSalesIrelandContract || !uuidV4.test(String(request.idempotencyKey))) denied("INVALID_REQUEST", 400);
    assertCrmUuid(request.correlationId, "correlationId");
    if (request.operation !== "qualify") denied("SALES_OPERATION_NOT_GRANTED");
    validateWebsiteSalesIrelandCommand(request as WebsiteSalesIrelandCommand);
  }
  return body as WebsiteSalesMachineRequest;
}
function parseDelegation(value: string | null) {
  if (!value || value.length > 2048) denied("DELEGATION_REQUIRED", 401);
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)
    || !/^[A-Za-z0-9_-]{86}$/.test(parts[3]!)) denied("DELEGATION_INVALID", 401);
  assertCrmUuid(parts[1], "grantId");
  return { grantId: parts[1]!, payload: parts[2]!, signature: parts[3]! };
}
function verifyDelegation(delegation: ReturnType<typeof parseDelegation>, grant: Grant, body: WebsiteSalesMachineRequest, now: Date) {
  let payload: Record<string, unknown>;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(grant.delegation_public_key, "base64url"), type: "spki", format: "der" });
    if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null,
      Buffer.from(`${websiteSalesMachineDelegationDomain}.${delegation.grantId}.${delegation.payload}`), publicKey,
      Buffer.from(delegation.signature, "base64url"))) denied("DELEGATION_INVALID", 401);
    payload = object(JSON.parse(Buffer.from(delegation.payload, "base64url").toString("utf8")));
  } catch { denied("DELEGATION_INVALID", 401); }
  const seconds = Math.floor(now.valueOf() / 1000);
  if (Object.keys(payload).length !== 4 || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
    || Number(payload.issuedAt) > seconds + 30 || Number(payload.expiresAt) <= seconds
    || Number(payload.expiresAt) <= Number(payload.issuedAt) || Number(payload.expiresAt) - Number(payload.issuedAt) > 300
    || !uuidV4.test(String(payload.nonce)) || payload.requestHash !== crmPayloadDigest(body)) denied("DELEGATION_INVALID", 401);
  return String(payload.nonce);
}
function grantDigest(grant: Grant) { return crmPayloadDigest({ id: grant.id, workloadId: grant.workload_id,
  workspaceId: grant.workspace_id, actorId: grant.actor_user_id, projectId: grant.project_id, companyId: grant.company_id,
  locationId: grant.location_id, departmentId: grant.department_id, agentId: grant.agent_id, taskId: grant.task_id,
  scopes: grant.scopes, publicKey: grant.delegation_public_key, authorityReference: grant.authority_reference,
  previewSourceGrantId: grant.preview_source_grant_id }); }
function action(body: WebsiteSalesMachineRequest): WebsiteSalesMachineScope {
  if (body.operation === "read") return "crm.website-sales.read";
  return body.operation === "reconcile" ? "crm.website-sales.reconcile" : "crm.website-sales.qualify";
}
function bind(grant: Grant, body: WebsiteSalesMachineRequest) {
  const request = body.request;
  if (grant.project_id !== request.projectId || grant.company_id !== request.companyId ||
    !grant.location_id || grant.location_id !== request.locationId) denied("SALES_RESOURCE_DENIED");
  if (!grant.scopes.includes(action(body)) ||
    (body.operation === "reconcile" && !grant.scopes.includes("crm.website-sales.qualify"))) denied("SALES_SCOPE_DENIED");
}

/** Explicit Sales machine route only. OIDC authenticates; saved exact-resource delegation authorizes. */
export async function handleWebsiteSalesMachine(request: Request, options: WebsiteSalesMachineOptions = {}): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== websiteSalesMachinePath || url.search
      || request.headers.has("cookie") || request.headers.has("origin")) denied("SALES_ACCESS_DENIED", 401);
    const bearer = getCrmMachineBearer(request.headers);
    if (!bearer) denied("SALES_ACCESS_DENIED", 401);
    const machineAuth = options.machineAuth ?? {};
    const env = machineAuth.env ?? process.env;
    const preview = env.VERCEL_ENV === "preview" ? websiteSalesPreviewReceiver(url, env) : null;
    const claims = preview ? await verifyWebsiteSalesPreviewToken(bearer, machineAuth) : await verifyCrmMachineToken(bearer, machineAuth);
    const delegation = parseDelegation(request.headers.get("x-evelyn-delegation"));
    const body = parseRequest(await readKnowledgeJson(request, ["contractVersion", "target", "operation", "request"], 131072));
    const identityBinding = [claims.issuer, claims.audience, claims.projectId, claims.ownerId, claims.subject, claims.workspaceId, claims.environment];
    const receiverBinding = [preview?.deploymentId ?? null, preview?.revision ?? null];
    const effectiveIdentity = preview ? websiteSalesPreviewIdentity : websiteSalesProductionIdentity;
    const principal = (await queryAuthenticationRows<Principal>(principalSql, [...identityBinding, ...receiverBinding], options))[0];
    if (!principal || principal.workspace_id !== claims.workspaceId || principal.identity_id !== effectiveIdentity) denied();
    const grantBinding = [principal.id, delegation.grantId, ...receiverBinding];
    const grant = (await queryAuthenticationRows<Grant>(grantSql, grantBinding, options))[0];
    if (!grant || grant.workspace_id !== claims.workspaceId) denied();
    bind(grant, body);
    const now = () => machineAuth.now ?? new Date();
    const nonce = verifyDelegation(delegation, grant, body, now());
    const original = body.request;
    for (const [header, field] of [["x-correlation-id", "correlationId"], ["idempotency-key", "idempotencyKey"]] as const) {
      if (request.headers.has(header) && request.headers.get(header) !== (original as unknown as Record<string, unknown>)[field]) denied("METADATA_MISMATCH", 400);
    }
    let sourceWorkloadId: string | undefined;
    if (body.operation === "execute" && !preview) {
      const source = (await queryAuthenticationRows<Principal>(sourceWorkloadSql, identityBinding, options))[0];
      if (!isSourceWorkload(source, claims.workspaceId)) denied("STUDIO_SOURCE_WORKLOAD_REQUIRED");
      sourceWorkloadId = source.id;
    }
    const session: AppSession = { authenticated: true, source: "database", userId: grant.actor_user_id,
      workspaceId: grant.workspace_id, workspaceName: "Registered internal Sales delegation", name: "Registered Sales actor",
      email: "sales-agent@service.invalid", role: "agent", productRole: "novalure_sales",
      permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("novalure_sales"),
      serviceIdentity: claims.environment === "preview"
        ? { identityId: websiteSalesPreviewIdentity, role: claims.role, consumer: claims.consumer, environment: claims.environment, jtiHash: claims.jtiHash }
        : { identityId: websiteSalesProductionIdentity, role: claims.role, consumer: claims.consumer, environment: claims.environment, jtiHash: claims.jtiHash } };
    const machine = { workloadId: principal.id, grantId: grant.id, departmentId: grant.department_id, agentId: grant.agent_id, taskId: grant.task_id };
    const authority: WebsiteSalesMachineAuthority = { ...machine, workspaceId: grant.workspace_id, actorId: grant.actor_user_id,
      identityId: principal.identity_id, scope: { projectId: grant.project_id, companyId: grant.company_id,
        locationId: grant.location_id }, mode: body.operation,
      ...(sourceWorkloadId ? { studioSource: { workloadId: sourceWorkloadId } } : {}),
      ...(preview && grant.preview_source_grant_id ? { studioSource: { preview, sourceGrantId: grant.preview_source_grant_id } } : {}),
      operation: body.operation === "read" ? "read" : body.request.operation };
    return await withWebsiteSalesMachineAuthority(authority, async () => {
      const command = body.operation === "read" ? null : websiteSalesIrelandCommandInput(session, body.request);
      const access = async (tx: TenantTransaction, fresh: AppSession) => {
        const revalidate = async () => {
          const current = await tx.queryOne<Grant>(grantSql, grantBinding);
          if (!current || grantDigest(current) !== grantDigest(grant)) denied();
          bind(current, body); verifyDelegation(delegation, current, body, now());
          if (sourceWorkloadId) {
            const source = await tx.queryOne<Principal>(sourceWorkloadSql, identityBinding);
            if (!isSourceWorkload(source, claims.workspaceId) || source.id !== sourceWorkloadId) denied("STUDIO_SOURCE_WORKLOAD_REQUIRED");
          }
          if (claims.expiresAt <= Math.floor(now().valueOf() / 1000)) denied("SALES_TOKEN_EXPIRED", 401);
        };
        await revalidate();
        await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`website-sales-machine:${grant.id}:${nonce}`]);
        await revalidate();
        if (await tx.queryOne("select nonce from crm_website_sales_machine_events where grant_id=$1 and nonce=$2", [grant.id, nonce])) denied("NONCE_REPLAY", 409);
        let result: Record<string, unknown>;
        if (body.operation === "execute") {
          result = { ...await runWebsiteSalesIrelandCommand(fresh, body.request, options), contractVersion: websiteSalesIrelandContract, persisted: true };
        } else if (body.operation === "reconcile") {
          result = { ...await reconcileWebsiteSalesIrelandCommand(fresh, body.request, options), contractVersion: websiteSalesMachineContract };
        } else {
          result = { contractVersion: websiteSalesIrelandContract, data: await getWebsiteSalesIrelandWorkflow(fresh, body.request, options) };
        }
        // Any authority/TTL change after a lock wait rolls the entire business transaction back.
        await revalidate();
        const auditReference = typeof result.auditReference === "string" ? result.auditReference : randomUUID();
        await tx.execute(`insert into crm_website_sales_machine_events(grant_id,nonce,workspace_id,actor_user_id,project_id,company_id,location_id,
          department_id,agent_id,task_id,action,request_hash,oidc_jti_hash,audit_reference,outcome)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [grant.id, nonce, grant.workspace_id, grant.actor_user_id, grant.project_id, grant.company_id, grant.location_id,
          grant.department_id, grant.agent_id, grant.task_id, action(body), crmPayloadDigest(body), claims.jtiHash, auditReference,
          result.status === "NOT_FOUND" ? "NOT_FOUND" : "SUCCESS"]);
        return { ...result, target: "workflow", correlationId: original.correlationId, machine, auditReference,
          requestHash: crmPayloadDigest(body), ...(body.operation === "read" ? {} : { idempotencyKey: body.request.idempotencyKey }),
          scope: { workspaceId: grant.workspace_id, projectId: grant.project_id, companyId: grant.company_id, locationId: grant.location_id } };
      };
      const result = command ? await withCrmCommandPreflight(session, command, access, options) : await withCrmRead(session, access, options);
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    });
  } catch (error) {
    const known = error instanceof CrmCommandError || error instanceof CrmMachineAuthError || error instanceof KnowledgeCenterError;
    const sqlCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return Response.json({ contractVersion: websiteSalesMachineContract, code: known ? error.code : sqlCode === "42501" ? "SALES_ACCESS_DENIED" : "SALES_ACCESS_UNAVAILABLE" },
      { status: known ? error.status : sqlCode === "42501" ? 403 : ["23505", "40001", "40P01"].includes(sqlCode) ? 409 : 503,
        headers: { "Cache-Control": "private, no-store" } });
  }
}
