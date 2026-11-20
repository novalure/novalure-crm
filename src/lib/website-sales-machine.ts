import {WebsiteSalesOperationsError} from "./website-sales-operations-contracts";
import {executeWebsiteSalesConversationCommand,readWebsiteSalesConversation,reconcileWebsiteSalesConversationCommand,websiteSalesConversationCommandInput,parseWebsiteSalesConversationCommand} from "./db/website-sales-conversation-repositories";
import { compactWebsiteSalesOperationsReceipt } from "./website-sales-operations-receipt";
import {websiteSalesConversationContract,type SalesConversationCommand} from "./website-sales-conversation-types";
import "server-only";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { ZodError } from "zod";
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
  websiteSalesIrelandCommandInput, websiteSalesIrelandContract, type WebsiteSalesIrelandCommand } from "./db/website-sales-ireland-repositories";
import { withWebsiteSalesMachineAuthority, type WebsiteSalesMachineAuthority } from "./website-sales-machine-authority";
import { executeWebsiteSalesStudioCommand, parseWebsiteSalesStudioCommand, readWebsiteSalesStudio,
  reconcileWebsiteSalesStudioCommand, websiteSalesStudioCommandInput } from "./db/website-sales-studio-repositories";
import { websiteSalesStudioContract, type WebsiteSalesStudioCommand } from "./website-sales-studio-types";
import { WebsiteStudioError } from "./website-sales-studio";
import { executeWebsiteSalesLifecycleCommand, parseWebsiteSalesLifecycleCommand, readWebsiteSalesLifecycle,
  reconcileWebsiteSalesLifecycleCommand, websiteSalesLifecycleCommandInput } from "./db/website-sales-lifecycle-repositories";
import {executeSalesOperationsCommand,readSalesOperations,reconcileSalesOperationsCommand,salesOperationsCommandInput,parseSalesOperationsCommand} from "./db/website-sales-operations-repositories";
import {websiteSalesOperationsContract,type SalesOperationsCommand,type SalesResourceGrant} from "./website-sales-operations-types";
import { websiteSalesLifecycleContract, type WebsiteSalesLifecycleCommand } from "./website-sales-lifecycle-types";

export const websiteSalesMachineContract = "website-sales-machine-v1";
export const websiteSalesMachinePath = "/api/integrations/evelyn/website-sales";
export const websiteSalesMachineDelegationDomain = `${websiteSalesMachineContract}.POST.${websiteSalesMachinePath}`;
export const websiteSalesMachineScopes = ["crm.website-sales.read", "crm.website-sales.register-location", "crm.website-sales.observe",
  "crm.website-sales.qualify", "crm.website-sales.prepare-draft", "crm.website-sales.stop", "crm.website-sales.reconcile",
  "crm.website-sales.studio.read", "crm.website-sales.studio.create-diagnosis", "crm.website-sales.studio.create-concept",
  "crm.website-sales.studio.accept-concept", "crm.website-sales.studio.build-demo", "crm.website-sales.lifecycle.read",
  "crm.website-sales.lifecycle.refresh-evidence", "crm.website-sales.lifecycle.ingest-reply", "crm.website-sales.lifecycle.create-handoff",
 "crm.website-sales.autonomy.read","crm.website-sales.autonomy.plan-portfolio","crm.website-sales.autonomy.claim-allocation","crm.website-sales.autonomy.settle-allocation","crm.website-sales.autonomy.propose-price","crm.website-sales.autonomy.apply-quote","crm.website-sales.autonomy.record-outcome","crm.website-sales.autonomy.propose-improvement","crm.website-sales.autonomy.promote-improvement",
 "crm.website-sales.conversation.read","crm.website-sales.conversation.record-topic","crm.website-sales.conversation.draft-answer","crm.website-sales.conversation.advance-conversation","crm.website-sales.conversation.stop-conversation"] as const;
export type WebsiteSalesMachineScope = typeof websiteSalesMachineScopes[number];
export type WebsiteSalesDelegationPayload = { issuedAt: number; expiresAt: number; nonce: string; requestHash: string };
export type WebsiteSalesMachineRead = { projectId: string; companyId: string; locationId: string; correlationId: string;view?:"operations"|"conversation"|"resource";resourceGrants?:SalesResourceGrant[] };
export type WebsiteSalesMachineRequest = { contractVersion: typeof websiteSalesMachineContract; target?: "workflow" | "studio" | "lifecycle" | "autonomy" } & (
  { operation: "execute"; request: WebsiteSalesIrelandCommand | WebsiteSalesStudioCommand | WebsiteSalesLifecycleCommand | SalesOperationsCommand | SalesConversationCommand } |
  { operation: "reconcile"; request: WebsiteSalesIrelandCommand | WebsiteSalesStudioCommand | WebsiteSalesLifecycleCommand | SalesOperationsCommand | SalesConversationCommand } |
  { operation: "read"; request: WebsiteSalesMachineRead });
export type WebsiteSalesMachineOptions = TenantTransactionOptions & { machineAuth?: CrmMachineAuthOptions };
type Grant = { id: string; workload_id: string; workspace_id: string; actor_user_id: string; project_id: string;
  company_id: string; location_id: string | null; department_id: "SALES"; agent_id: string; task_id: string;
  scopes: WebsiteSalesMachineScope[]; delegation_public_key: string };
type Principal = { id: string; workspace_id: string; identity_id: string };
const grantSql = "select * from public.crm_lock_website_sales_machine_grant($1::uuid,$2::uuid)";
const principalSql = "select * from public.crm_authenticate_website_sales_workload($1,$2,$3,$4,$5,$6::uuid,$7)";
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
  if (body.target !== undefined && !["workflow", "studio", "lifecycle", "autonomy"].includes(String(body.target))) denied("INVALID_REQUEST", 400);
  const request = object(body.request);
  if (body.operation === "read") {
    assertCrmFields(request, ["projectId", "companyId", "locationId", "correlationId", ...(body.target==="autonomy"?["resourceGrants","view"]:[])]);
    for (const name of ["projectId", "companyId", "locationId", "correlationId"]) assertCrmUuid(request[name], name);
  } else {
    if (request.contractVersion !== (body.target === "autonomy" ? (request.contractVersion===websiteSalesConversationContract?websiteSalesConversationContract:websiteSalesOperationsContract) : body.target === "studio" ? websiteSalesStudioContract : body.target === "lifecycle" ? websiteSalesLifecycleContract : websiteSalesIrelandContract)
      || !uuidV4.test(String(request.idempotencyKey))) denied("INVALID_REQUEST", 400);
    assertCrmUuid(request.correlationId, "correlationId");
    if (body.target === "studio") {
      if (["submit_qa", "create_preview", "revoke_preview"].includes(String(request.operation))) denied("STUDIO_STAFF_REQUIRED");
      parseWebsiteSalesStudioCommand(request);
    }
    if (body.target === "lifecycle") {
      if (["authorize_reply_classification", "record_customer_acceptance"].includes(String(request.operation))) denied("HUMAN_ATTESTATION_REQUIRED");
      parseWebsiteSalesLifecycleCommand(request);
    }
    if(body.target==="autonomy"){if(request.contractVersion===websiteSalesConversationContract)parseWebsiteSalesConversationCommand(request);else parseSalesOperationsCommand(request);}
    // The canonical repository validates the exact operation-specific command before transaction entry.
  }
  if(body.target==="autonomy"){
   if(body.operation==="read"&&request.view!==undefined&&!["operations","conversation","resource"].includes(String(request.view)))denied("INVALID_READ_VIEW",400);
   const refs=body.operation==="read"?request.resourceGrants:object(request.payload).resourceGrants;
   if(refs!==undefined){if(!Array.isArray(refs)||refs.length>49)denied("INVALID_RESOURCE_GRANTS",400);const seen=new Set<string>();for(const item of refs){const ref=object(item);assertCrmFields(ref,["companyId","locationId","grantId"]);for(const key of ["companyId","locationId","grantId"])assertCrmUuid(ref[key],key);const key=`${ref.companyId}:${ref.locationId}`;if(seen.has(key))denied("DUPLICATE_RESOURCE_GRANT",400);seen.add(key);}}
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
  scopes: grant.scopes, publicKey: grant.delegation_public_key }); }
function action(body: WebsiteSalesMachineRequest): WebsiteSalesMachineScope {
  if (body.operation === "read") return body.target === "autonomy" ? (body.request.view==="conversation"?"crm.website-sales.conversation.read":"crm.website-sales.autonomy.read") : body.target === "studio" ? "crm.website-sales.studio.read" : body.target === "lifecycle" ? "crm.website-sales.lifecycle.read" : "crm.website-sales.read";
  if (body.operation === "reconcile") return "crm.website-sales.reconcile";
  if(body.target==="autonomy"){
   if(body.request.contractVersion===websiteSalesConversationContract){const mapping={record_topic:"crm.website-sales.conversation.record-topic",draft_answer:"crm.website-sales.conversation.draft-answer",advance_conversation:"crm.website-sales.conversation.advance-conversation",stop_conversation:"crm.website-sales.conversation.stop-conversation"} as const;return mapping[body.request.operation as keyof typeof mapping]??denied("HUMAN_POLICY_AUTHORITY_REQUIRED");}
   const mapping={plan_portfolio:"crm.website-sales.autonomy.plan-portfolio",claim_allocation:"crm.website-sales.autonomy.claim-allocation",settle_allocation:"crm.website-sales.autonomy.settle-allocation",propose_price:"crm.website-sales.autonomy.propose-price",apply_quote:"crm.website-sales.autonomy.apply-quote",record_outcome:"crm.website-sales.autonomy.record-outcome",propose_improvement:"crm.website-sales.autonomy.propose-improvement",promote_improvement:"crm.website-sales.autonomy.promote-improvement"} as const;
   return mapping[body.request.operation as keyof typeof mapping]??denied("HUMAN_POLICY_AUTHORITY_REQUIRED");
  }
  if (body.target === "studio") {
    const studio = { create_diagnosis: "crm.website-sales.studio.create-diagnosis", create_concept: "crm.website-sales.studio.create-concept",
      accept_concept: "crm.website-sales.studio.accept-concept", build_demo: "crm.website-sales.studio.build-demo" } as const;
    return studio[body.request.operation as keyof typeof studio] ?? denied("STUDIO_STAFF_REQUIRED");
  }
  if (body.target === "lifecycle") {
    const lifecycle = { refresh_evidence: "crm.website-sales.lifecycle.refresh-evidence", ingest_reply: "crm.website-sales.lifecycle.ingest-reply", create_handoff: "crm.website-sales.lifecycle.create-handoff" } as const;
    return lifecycle[body.request.operation as keyof typeof lifecycle] ?? denied("HUMAN_ATTESTATION_REQUIRED");
  }
  const mapping: Record<WebsiteSalesIrelandCommand["operation"], WebsiteSalesMachineScope> = {
    register_location: "crm.website-sales.register-location", observe: "crm.website-sales.observe",
    qualify: "crm.website-sales.qualify", prepare_offer: "crm.website-sales.prepare-draft", stop: "crm.website-sales.stop",
  };
  return mapping[body.request.operation as WebsiteSalesIrelandCommand["operation"]] ?? denied("INVALID_REQUEST", 400);
}
function bind(grant: Grant, body: WebsiteSalesMachineRequest) {
  const request = body.request;
  if (grant.project_id !== request.projectId || grant.company_id !== request.companyId
    || grant.location_id !== (request.locationId ?? null)) denied("SALES_RESOURCE_DENIED");
  const required = action(body);
  if (!grant.scopes.includes(required)) denied("SALES_SCOPE_DENIED");
  // A reconciliation lookup still needs the original effect scope; it cannot reveal another grant's receipt.
  if (body.operation === "reconcile" && !grant.scopes.includes(action({ ...body, operation: "execute" }))) denied("SALES_SCOPE_DENIED");
}

/** Explicit Sales machine route only. OIDC authenticates; saved exact-resource delegation authorizes. */
export async function handleWebsiteSalesMachine(request: Request, options: WebsiteSalesMachineOptions = {}): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== websiteSalesMachinePath || url.search
      || request.headers.has("cookie") || request.headers.has("origin")) denied("SALES_ACCESS_DENIED", 401);
    const bearer = getCrmMachineBearer(request.headers);
    if (!bearer) denied("SALES_ACCESS_DENIED", 401);
    const claims = await verifyCrmMachineToken(bearer, options.machineAuth);
    const principal = (await queryAuthenticationRows<Principal>(principalSql,
      [claims.issuer, claims.audience, claims.projectId, claims.ownerId, claims.subject, claims.workspaceId, claims.environment], options))[0];
    if (!principal || principal.workspace_id !== claims.workspaceId) denied();
    const delegation = parseDelegation(request.headers.get("x-evelyn-delegation"));
    const body = parseRequest(await readKnowledgeJson(request, ["contractVersion", "target", "operation", "request"], 131072));
    const grant = (await queryAuthenticationRows<Grant>(grantSql, [principal.id, delegation.grantId], options))[0];
    if (!grant || grant.workspace_id !== claims.workspaceId) denied();
    bind(grant, body);
    const refs:SalesResourceGrant[]=body.target==="autonomy"?((body.operation==="read"?body.request.resourceGrants:body.request.payload.resourceGrants)??[]) as SalesResourceGrant[]:[];
    const resources:Grant[]=[];
    for(const ref of [...refs].sort((a,b)=>a.grantId.localeCompare(b.grantId))){
     const other=(await queryAuthenticationRows<Grant>(grantSql,[principal.id,ref.grantId],options))[0];
     if(!other||other.company_id!==ref.companyId||other.location_id!==ref.locationId||other.workspace_id!==grant.workspace_id||other.project_id!==grant.project_id||other.actor_user_id!==grant.actor_user_id||other.workload_id!==grant.workload_id||other.agent_id!==grant.agent_id||other.task_id!==grant.task_id||other.delegation_public_key!==grant.delegation_public_key)denied("SALES_RESOURCE_DENIED");
     bind(other,{...body,request:{...body.request,companyId:ref.companyId,locationId:ref.locationId}} as WebsiteSalesMachineRequest);resources.push(other);
    }
    const now = () => options.machineAuth?.now ?? new Date();
    const nonce = verifyDelegation(delegation, grant, body, now());
    const original = body.request;
    for (const [header, field] of [["x-correlation-id", "correlationId"], ["idempotency-key", "idempotencyKey"]] as const) {
      if (request.headers.has(header) && request.headers.get(header) !== (original as unknown as Record<string, unknown>)[field]) denied("METADATA_MISMATCH", 400);
    }
    const session: AppSession = { authenticated: true, source: "database", userId: grant.actor_user_id,
      workspaceId: grant.workspace_id, workspaceName: "Registered internal Sales delegation", name: "Registered Sales actor",
      email: "sales-agent@service.invalid", role: "agent", productRole: "novalure_sales",
      permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("novalure_sales"),
      serviceIdentity: { identityId: principal.identity_id, role: claims.role, consumer: claims.consumer,
        environment: claims.environment, jtiHash: claims.jtiHash } };
    const machine = { workloadId: principal.id, grantId: grant.id, departmentId: grant.department_id, agentId: grant.agent_id, taskId: grant.task_id };
    const authority: WebsiteSalesMachineAuthority = { ...machine, workspaceId: grant.workspace_id, actorId: grant.actor_user_id,
      identityId: principal.identity_id, scope: { projectId: grant.project_id, companyId: grant.company_id,
        ...(grant.location_id === null ? {} : { locationId: grant.location_id }) }, mode: body.operation, target: body.target ?? "workflow",
      operation: body.operation === "read" ? "read" : body.request.operation,...(body.target==="autonomy"?{resources:resources.map(g=>({companyId:g.company_id,locationId:g.location_id!,grantId:g.id,digest:grantDigest(g)}))}: {}) };
    return await withWebsiteSalesMachineAuthority(authority, async () => {
      const command = body.operation === "read" ? null : body.target === "autonomy" ? (body.request.contractVersion===websiteSalesConversationContract?websiteSalesConversationCommandInput(session,body.request as SalesConversationCommand):salesOperationsCommandInput(session,body.request as SalesOperationsCommand)) : body.target === "studio"
        ? websiteSalesStudioCommandInput(session, body.request as WebsiteSalesStudioCommand)
        : body.target === "lifecycle" ? websiteSalesLifecycleCommandInput(session, body.request as WebsiteSalesLifecycleCommand)
        : websiteSalesIrelandCommandInput(session, body.request as WebsiteSalesIrelandCommand);
      const access = async (tx: TenantTransaction, fresh: AppSession) => {
        const revalidate = async () => {
          const current = await tx.queryOne<Grant>(grantSql, [principal.id, grant.id]);
          if (!current || grantDigest(current) !== grantDigest(grant)) denied();
          bind(current, body);
          for(const originalResource of resources){const resource=await tx.queryOne<Grant>(grantSql,[principal.id,originalResource.id]);if(!resource||grantDigest(resource)!==grantDigest(originalResource))denied("SALES_RESOURCE_DENIED");bind(resource,{...body,request:{...body.request,companyId:resource.company_id,locationId:resource.location_id!}} as WebsiteSalesMachineRequest);}
          verifyDelegation(delegation, current, body, now());
          if (claims.expiresAt <= Math.floor(now().valueOf() / 1000)) denied("SALES_TOKEN_EXPIRED", 401);
        };
        await revalidate();
        await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`website-sales-machine:${grant.id}:${nonce}`]);
        await revalidate();
        if (await tx.queryOne("select nonce from crm_website_sales_machine_events where grant_id=$1 and nonce=$2", [grant.id, nonce])) denied("NONCE_REPLAY", 409);
        let result: Record<string, unknown>;
        if (body.operation === "execute") {
          result = body.target === "autonomy" ? (body.request.contractVersion===websiteSalesConversationContract?{...await executeWebsiteSalesConversationCommand(fresh,body.request as SalesConversationCommand,options),contractVersion:websiteSalesConversationContract,persisted:true}:compactWebsiteSalesOperationsReceipt(await executeSalesOperationsCommand(fresh,body.request as SalesOperationsCommand,options))) : body.target === "studio"
            ? { ...await executeWebsiteSalesStudioCommand(fresh, body.request as WebsiteSalesStudioCommand, options) }
            : body.target === "lifecycle" ? { ...await executeWebsiteSalesLifecycleCommand(fresh, body.request as WebsiteSalesLifecycleCommand, options), contractVersion: websiteSalesLifecycleContract, persisted: true }
            : { ...await runWebsiteSalesIrelandCommand(fresh, body.request as WebsiteSalesIrelandCommand, options), contractVersion: websiteSalesIrelandContract, persisted: true };
        } else if (body.operation === "reconcile") {
          if(body.target==="autonomy") {
            const reconciled = body.request.contractVersion===websiteSalesConversationContract?await reconcileWebsiteSalesConversationCommand(fresh,body.request as SalesConversationCommand,options):await reconcileSalesOperationsCommand(fresh,body.request as SalesOperationsCommand,options);
            result={...(body.request.contractVersion!==websiteSalesConversationContract && reconciled.status==="COMMITTED" ? compactWebsiteSalesOperationsReceipt(reconciled, true) : reconciled),contractVersion:websiteSalesMachineContract};
          }
          else if (body.target === "studio") {
            const receipt = await reconcileWebsiteSalesStudioCommand(fresh, body.request as WebsiteSalesStudioCommand, options);
            result = { ...receipt, contractVersion: websiteSalesMachineContract,
              ...(receipt.status === "COMMITTED" ? { currentData: await readWebsiteSalesStudio(fresh, {
                projectId: original.projectId, companyId: original.companyId, locationId: original.locationId!,
              }, options) } : {}) };
          } else if (body.target === "lifecycle") result = { ...await reconcileWebsiteSalesLifecycleCommand(fresh, body.request as WebsiteSalesLifecycleCommand, options), contractVersion: websiteSalesMachineContract };
          else result = { ...await reconcileWebsiteSalesIrelandCommand(fresh, body.request as WebsiteSalesIrelandCommand, options), contractVersion: websiteSalesMachineContract };
        } else {
          const scope = { projectId: body.request.projectId, companyId: body.request.companyId, locationId: body.request.locationId };
          result = body.target === "autonomy" ? (body.request.view==="conversation"?{contractVersion:websiteSalesConversationContract,data:await readWebsiteSalesConversation(fresh,scope,options)}:{contractVersion:websiteSalesOperationsContract,data:await readSalesOperations(fresh,scope,options,body.request.view==="resource")}) : body.target === "studio" ? { contractVersion: websiteSalesStudioContract, data: await readWebsiteSalesStudio(fresh, scope, options) }
            : body.target === "lifecycle" ? { contractVersion: websiteSalesLifecycleContract, data: await readWebsiteSalesLifecycle(fresh, scope, options) }
            : { contractVersion: websiteSalesIrelandContract, data: await getWebsiteSalesIrelandWorkflow(fresh, scope, options) };
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
        return { ...result, correlationId: original.correlationId, target: body.target ?? "workflow", machine, auditReference,
          requestHash: crmPayloadDigest(body), ...(body.operation === "read" ? {} : { idempotencyKey: body.request.idempotencyKey }),
          scope: { workspaceId: grant.workspace_id, projectId: grant.project_id, companyId: grant.company_id, locationId: grant.location_id } };
      };
      const result = command ? await withCrmCommandPreflight(session, command, access, options) : await withCrmRead(session, access, options);
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    });
  } catch (error) {
    const known = error instanceof CrmCommandError || error instanceof CrmMachineAuthError || error instanceof KnowledgeCenterError;
    const sqlCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return Response.json({ contractVersion: websiteSalesMachineContract, code: known || error instanceof WebsiteStudioError || error instanceof WebsiteSalesOperationsError ? error.code : error instanceof ZodError ? "INVALID_STUDIO_PAYLOAD" : sqlCode === "42501" ? "SALES_ACCESS_DENIED" : "SALES_ACCESS_UNAVAILABLE" },
      { status: known ? error.status : error instanceof ZodError ? 400 : error instanceof WebsiteStudioError || error instanceof WebsiteSalesOperationsError ? 409 : sqlCode === "42501" ? 403 : ["23505", "40001", "40P01"].includes(sqlCode) ? 409 : 503,
        headers: { "Cache-Control": "private, no-store" } });
  }
}
