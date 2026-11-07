import "server-only";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import type { AppSession } from "./auth/session";
import { getRolePermissions } from "./auth/permissions";
import { getProductRoleCapabilities } from "./product-model";
import { queryAuthenticationRows } from "./db/tenant-client";
import {
  assertCrmFields, assertCrmUuid, assertExpectedVersion, assertProjectGrant,
  CrmCommandError, crmPayloadDigest, executeCrmCommand, withCrmRead,
  type TenantTransaction, type TenantTransactionOptions,
} from "./crm-command";
import {
  CrmMachineAuthError, getCrmMachineBearer, verifyCrmMachineToken,
  type CrmMachineAuthOptions,
} from "./crm-machine-auth";
import { readKnowledgeJson } from "./knowledge-center/http";
import { KnowledgeCenterError } from "./knowledge-center/policy";

export const autonomousAccessContract = "crm-autonomous-access-v1";
export const autonomousAccessPath = "/api/integrations/evelyn/access";
export const autonomousDelegationDomain = `${autonomousAccessContract}.POST.${autonomousAccessPath}`;
const grantSql = "select * from public.crm_lock_autonomous_access_grant($1::uuid,$2::uuid)";
const principalSql = "select * from public.crm_authenticate_autonomous_workload($1,$2,$3,$4,$5,$6::uuid,$7)";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const grantUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AccessRequest = {
  contractVersion: typeof autonomousAccessContract;
  operation: "Read" | "UpdateTask";
  correlationId: string;
  idempotencyKey: string;
  expectedVersion: number | null;
  patch: { title?: string };
};
type Grant = {
  id: string; workload_id: string; workspace_id: string; actor_user_id: string;
  project_id: string; source_id: string; entity: "Task" | "Project";
  department_id: string; agent_id: string; task_id: string; scopes: string[];
  delegation_public_key: string;
};
type Principal = { id: string; workspace_id: string; identity_id: string };
export type AutonomousAccessOptions = TenantTransactionOptions & { machineAuth?: CrmMachineAuthOptions };

function denied(code = "ACCESS_DENIED", status = 403): never {
  throw new CrmCommandError(code, "Autonomous CRM access is not granted", status);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) denied("INVALID_REQUEST", 400);
  return value as Record<string, unknown>;
}
function parseRequest(value: unknown): AccessRequest {
  const body = record(value);
  assertCrmFields(body, ["contractVersion", "operation", "correlationId", "idempotencyKey", "expectedVersion", "patch"]);
  if (body.contractVersion !== autonomousAccessContract || !["Read", "UpdateTask"].includes(String(body.operation)) ||
      !uuid.test(String(body.idempotencyKey))) denied("INVALID_REQUEST", 400);
  assertCrmUuid(body.correlationId);
  const patch = record(body.patch);
  if (body.operation === "Read") {
    if (body.expectedVersion !== null || Object.keys(patch).length) denied("INVALID_REQUEST", 400);
  } else {
    assertExpectedVersion(body.expectedVersion);
    if (Object.keys(patch).length !== 1 || typeof patch.title !== "string" || patch.title.trim() !== patch.title ||
        patch.title.length < 1 || patch.title.length > 200 || /[\p{Cc}\p{Cf}]/u.test(patch.title)) denied("INVALID_REQUEST", 400);
  }
  return body as AccessRequest;
}

function parseDelegation(value: string | null) {
  if (!value || value.length > 2048) denied("DELEGATION_REQUIRED", 401);
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !grantUuid.test(parts[1]!) ||
      !/^[A-Za-z0-9_-]+$/.test(parts[2]!) || !/^[A-Za-z0-9_-]{86}$/.test(parts[3]!)) denied("DELEGATION_INVALID", 401);
  return { grantId: parts[1]!, payload: parts[2]!, signature: parts[3]! };
}
function verifyDelegation(delegation: ReturnType<typeof parseDelegation>, grant: Grant, body: AccessRequest, now: Date) {
  let payload: Record<string, unknown>;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(grant.delegation_public_key, "base64url"), type: "spki", format: "der" });
    if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null,
      Buffer.from(`${autonomousDelegationDomain}.${delegation.grantId}.${delegation.payload}`), publicKey,
      Buffer.from(delegation.signature, "base64url"))) denied("DELEGATION_INVALID", 401);
    payload = record(JSON.parse(Buffer.from(delegation.payload, "base64url").toString("utf8")));
  } catch { denied("DELEGATION_INVALID", 401); }
  const seconds = Math.floor(now.valueOf() / 1000);
  if (Object.keys(payload).length !== 4 || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) ||
      Number(payload.issuedAt) > seconds + 30 || Number(payload.expiresAt) <= seconds ||
      Number(payload.expiresAt) <= Number(payload.issuedAt) || Number(payload.expiresAt) - Number(payload.issuedAt) > 300 ||
      !uuid.test(String(payload.nonce)) || payload.requestHash !== crmPayloadDigest(body)) denied("DELEGATION_INVALID", 401);
  return payload.nonce as string;
}
function grantDigest(grant: Grant) {
  return crmPayloadDigest({ id: grant.id, workloadId: grant.workload_id, workspaceId: grant.workspace_id,
    actorId: grant.actor_user_id, projectId: grant.project_id, sourceId: grant.source_id, entity: grant.entity,
    departmentId: grant.department_id, agentId: grant.agent_id, taskId: grant.task_id,
    scopes: grant.scopes, publicKey: grant.delegation_public_key });
}
async function projection(tx: TenantTransaction, grant: Grant) {
  const selected = grant.entity === "Task" ? "title,status,priority,version" : "name,type,status";
  const table = grant.entity === "Task" ? "tasks" : "projects";
  const projectColumn = grant.entity === "Task" ? "project_id" : "id";
  const row = await tx.queryOne<Record<string, unknown>>(`select ${selected},updated_at as "updatedAt" from ${table}
    where id=$1::uuid and workspace_id=$2::uuid and ${projectColumn}=$3::uuid
      and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales' for share`, [grant.source_id, grant.workspace_id, grant.project_id]);
  if (!row) denied();
  if (grant.entity === "Task") row.version = assertExpectedVersion(Number(row.version));
  return row;
}

/** OIDC authenticates the workload. A separate, stored real-data assignment and
 * its signing key authorize the exact department, agent, mission and resource. */
export async function handleAutonomousCrmAccess(request: Request, options: AutonomousAccessOptions = {}): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== autonomousAccessPath || url.search ||
        request.headers.has("cookie") || request.headers.has("origin")) denied("ACCESS_DENIED", 401);
    const token = getCrmMachineBearer(request.headers);
    if (!token) denied("ACCESS_DENIED", 401);
    const claims = await verifyCrmMachineToken(token, options.machineAuth);
    const principalParams = [claims.issuer, claims.audience, claims.projectId, claims.ownerId,
      claims.subject, claims.workspaceId, claims.environment];
    const principal = (await queryAuthenticationRows<Principal>(principalSql, principalParams, options))[0];
    if (!principal || principal.workspace_id !== claims.workspaceId) denied();
    const delegation = parseDelegation(request.headers.get("x-evelyn-delegation"));
    const body = parseRequest(await readKnowledgeJson(request,
      ["contractVersion", "operation", "correlationId", "idempotencyKey", "expectedVersion", "patch"], 8192));
    const grant = (await queryAuthenticationRows<Grant>(grantSql, [principal.id, delegation.grantId], options))[0];
    if (!grant || grant.workspace_id !== claims.workspaceId) denied();
    const nonce = verifyDelegation(delegation, grant, body, options.machineAuth?.now ?? new Date());
    const action = body.operation === "UpdateTask" ? "crm.tasks.write" : grant.entity === "Task" ? "crm.tasks.read" : "crm.projects.read";
    if (!grant.scopes.includes(action) || (body.operation === "UpdateTask" && grant.entity !== "Task")) denied();
    const session: AppSession = { authenticated: true, source: "database", userId: grant.actor_user_id,
      workspaceId: grant.workspace_id, workspaceName: "Registered internal delegation", name: "Registered CRM service agent",
      email: "delegated-crm-agent@service.invalid", role: "agent", productRole: "novalure_operator",
      permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("novalure_operator"),
      serviceIdentity: { identityId: principal.identity_id, role: claims.role, consumer: claims.consumer,
        environment: claims.environment, jtiHash: claims.jtiHash } };
    const result = await withCrmRead(session, async (tx, fresh) => {
      const current = await tx.queryOne<Grant>(grantSql, [principal.id, grant.id]);
      if (!current || grantDigest(current) !== grantDigest(grant)) denied();
      await assertProjectGrant(tx, fresh, grant.project_id, body.operation !== "Read");
      const revalidate = async () => {
        const effective = await tx.queryOne<Grant>(grantSql, [principal.id, grant.id]);
        if (!effective || grantDigest(effective) !== grantDigest(grant)) denied();
        const effectTime = options.machineAuth?.now ?? new Date();
        verifyDelegation(delegation, effective, body, effectTime);
        if (claims.expiresAt <= Math.floor(effectTime.valueOf() / 1000)) denied("ACCESS_DENIED", 401);
      };
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`autonomous-access:${grant.id}:${nonce}`]);
      // Lock waits must never extend transport authority past its lifetime.
      await revalidate();
      if (await tx.queryOne("select nonce from crm_autonomous_access_events where grant_id=$1 and nonce=$2", [grant.id, nonce])) denied("NONCE_REPLAY", 409);
      const attribution = { grantId: grant.id, departmentId: grant.department_id, agentId: grant.agent_id, taskId: grant.task_id };
      let data: Record<string, unknown>, auditReference: string = randomUUID(), replayed = false;
      if (body.operation === "Read") data = await projection(tx, grant);
      else {
        const command = await executeCrmCommand(fresh, { operation: "autonomous.task.title.update", resourceId: grant.source_id,
          projectId: grant.project_id, expectedVersion: body.expectedVersion!, idempotencyKey: body.idempotencyKey,
          correlationId: body.correlationId, capability: "pipeline:write", payload: { ...attribution, request: body } }, async commandTx => {
          const target = await commandTx.queryOne(`select id from tasks where id=$1::uuid and workspace_id=$2::uuid
            and project_id=$3::uuid and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales' for update`,
          [grant.source_id, grant.workspace_id, grant.project_id]);
          if (!target) denied();
          await revalidate();
          const changed = await commandTx.queryOne(`update tasks set title=$4,version=version+1,updated_at=now()
            where id=$1::uuid and workspace_id=$2::uuid and project_id=$3::uuid and version=$5
              and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales' returning id`,
          [grant.source_id, grant.workspace_id, grant.project_id, body.patch.title, body.expectedVersion]);
          if (!changed) denied("VERSION_CONFLICT", 409);
          return projection(commandTx, grant);
        }, options);
        data = command.data; auditReference = command.auditReference; replayed = command.replayed;
      }
      await revalidate();
      // Insert only after a successful read or committed-command result. The
      // nonce, attribution and effect share this transaction and roll back together.
      await tx.execute(`insert into crm_autonomous_access_events(grant_id,nonce,workspace_id,actor_user_id,department_id,
        agent_id,task_id,project_id,source_id,action,request_hash,oidc_jti_hash,audit_reference,outcome)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'SUCCESS')`,
      [grant.id, nonce, grant.workspace_id, grant.actor_user_id, grant.department_id, grant.agent_id, grant.task_id,
        grant.project_id, grant.source_id, action, crmPayloadDigest(body), claims.jtiHash, auditReference]);
      return { ...attribution, workspaceId: grant.workspace_id, projectId: grant.project_id, sourceId: grant.source_id,
        entity: grant.entity, data, auditReference, replayed };
    }, options);
    return Response.json({ contractVersion: autonomousAccessContract, correlationId: body.correlationId, ...result },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const known = error instanceof CrmCommandError || error instanceof CrmMachineAuthError;
    return Response.json({ contractVersion: autonomousAccessContract,
      code: error instanceof KnowledgeCenterError ? "INVALID_REQUEST" : known ? error.code : "ACCESS_UNAVAILABLE" },
    { status: error instanceof KnowledgeCenterError ? 400 : known ? error.status : 503,
      headers: { "Cache-Control": "private, no-store" } });
  }
}
