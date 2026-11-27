import "server-only";
import { createPublicKey } from "node:crypto";
import { assertCrmUuid, crmPayloadDigest } from "./crm-command";
import { CRM_MACHINE_AUDIENCE, CRM_MACHINE_ENVIRONMENT, CRM_MACHINE_ISSUER,
  CRM_MACHINE_OWNER_ID, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_SUBJECT, CRM_MACHINE_WORKSPACE_ID } from "./crm-machine-auth";
import { CRM_PERSONAL_SOURCE } from "./crm-autonomous-personal-auth";
import departmentPolicy from "../../config/crm-department-access-policy.json";
import { autonomousModuleContract, autonomousModuleEntities, autonomousModuleFields, autonomousModuleWriteFields,
  autonomousModuleOperations, autonomousModuleScope, type AutonomousModuleEntity } from "./crm-autonomous-module-contract";
import { autonomousModuleLeadTypes } from "./crm-autonomous-module-contract";

export const autonomousCrmDepartments = [
  "EVELYN_CEO", "BUSINESS_DEVELOPMENT", "SALES", "MARKETING_ADS", "WEBSITE_STUDIO", "REAL_ESTATE_OPERATIONS",
  "PROJECT_MANAGEMENT", "IT_CRM", "SECRETARIAT_ADMINISTRATION", "SUPPORT", "FINANCE", "LEGAL_COMPLIANCE",
  "HR", "PROCUREMENT", "SOCIAL_MEDIA", "VOICE_TELEPHONE",
] as const;
export type AutonomousCrmRegistration = Readonly<{
  workloadId: string; workloadActorId: string; grantId: string; actorId: string;
  projectId: string; sourceId: string; departmentId: typeof autonomousCrmDepartments[number];
  agentId: string; taskId: string; entity: AutonomousModuleEntity;
  scopes: readonly string[];
  publicKey: string; authorityReference: string; expiresAt: string | null;
  sourceProfile?: "PRODUCTION" | "FRANZ_PERSONAL";
  module?: Readonly<{ contractVersion: typeof autonomousModuleContract; readFields: readonly string[]; writeFields: readonly string[];
    relatedResources: Readonly<Record<string,string>>; lifecycleMode: "EXISTING" | "CREATE";
    delegationKind?: "DEPARTMENT"|"SUBAGENT";parentGrantId?:string|null }>;
}>;
type BootstrapConnection = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

function validateRegistration(input: AutonomousCrmRegistration) {
  if (input.sourceProfile !== undefined && !["PRODUCTION", "FRANZ_PERSONAL"].includes(input.sourceProfile)) throw new Error("AUTONOMOUS_REGISTRATION_INVALID");
  const source = input.sourceProfile === "FRANZ_PERSONAL" ? CRM_PERSONAL_SOURCE : {
    identityId: "EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY", environment: CRM_MACHINE_ENVIRONMENT,
    subject: CRM_MACHINE_SUBJECT, customEnvironmentId: null,
  };
  for (const id of [input.workloadId, input.workloadActorId, input.grantId, input.actorId, input.projectId, input.sourceId, input.taskId]) assertCrmUuid(id);
  const key = createPublicKey({ key: Buffer.from(input.publicKey, "base64url"), format: "der", type: "spki" });
  const moduleConfig = input.module;
  const allowedScopes = moduleConfig ? autonomousModuleOperations.map(op=>autonomousModuleScope(input.entity,op))
    : input.entity === "Task" ? ["crm.tasks.read", "crm.tasks.write"] : ["crm.projects.read"];
  if (!autonomousCrmDepartments.includes(input.departmentId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.agentId) ||
      !(moduleConfig ? autonomousModuleEntities : ["Task", "Project"]).includes(input.entity) || !input.scopes.length || input.scopes.some(scope => !allowedScopes.includes(scope)) ||
      key.asymmetricKeyType !== "ed25519" || input.publicKey.length !== 59 ||
      !input.authorityReference.trim() || input.authorityReference.length > 200 ||
      (input.expiresAt !== null && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()))) {
    throw new Error("AUTONOMOUS_REGISTRATION_INVALID");
  }
  if(moduleConfig){
    const departmentRules=(departmentPolicy.departments as Record<string,Array<{entity:string;operation:string;fields:string[]}>>)[input.departmentId]?.filter(r=>r.entity===input.entity)??[];
    const readFields=departmentRules.find(r=>r.operation==="Read")?.fields??[];
    const writeFields=departmentRules.filter(r=>r.operation!=="Read"&&r.operation!=="DescribeAssignment").flatMap(r=>r.fields);
    if(moduleConfig.contractVersion!==autonomousModuleContract||!["EXISTING","CREATE"].includes(moduleConfig.lifecycleMode)||
      moduleConfig.readFields.length>40||moduleConfig.writeFields.length>40||new Set(moduleConfig.readFields).size!==moduleConfig.readFields.length||new Set(moduleConfig.writeFields).size!==moduleConfig.writeFields.length||
      moduleConfig.readFields.some(f=>!autonomousModuleFields[input.entity].includes(f))||moduleConfig.writeFields.some(f=>!autonomousModuleWriteFields[input.entity].includes(f))||
      Object.keys(moduleConfig.relatedResources).some(k=>!["contactId","leadId","organizationId","unitId","dealId","reservationId"].includes(k))||
      !departmentRules.length||moduleConfig.readFields.some(f=>!readFields.includes(f))||moduleConfig.writeFields.some(f=>!writeFields.includes(f)))throw new Error("AUTONOMOUS_REGISTRATION_INVALID");
    for(const id of Object.values(moduleConfig.relatedResources))assertCrmUuid(id);
    const kind=moduleConfig.delegationKind??"DEPARTMENT",parent=moduleConfig.parentGrantId??null;
    if(kind==="SUBAGENT"?!parent:kind!=="DEPARTMENT"||parent!==null)throw new Error("AUTONOMOUS_REGISTRATION_INVALID");
    if(parent)assertCrmUuid(parent);
  }
  return { source, moduleConfig };
}

function requiresTypedSource(input: AutonomousCrmRegistration) {
  return input.module?.lifecycleMode === "EXISTING" && (input.entity === "BuyerLead" || input.entity === "Qualification");
}
// This capability never crosses the host-only module boundary. It can only be
// minted after the same real connection has locked the current source row.
const sourceLocked = Symbol("autonomous-typed-source-locked");

async function registerInTransaction(connection: BootstrapConnection, input: AutonomousCrmRegistration,
  validation: ReturnType<typeof validateRegistration>, sourceAdmission?: symbol) {
    if (requiresTypedSource(input) && sourceAdmission !== sourceLocked) throw new Error("AUTONOMOUS_TYPED_SOURCE_READER_REQUIRED");
    const { source, moduleConfig } = validation;
    const owner = (await connection.query(`select count(*)=2 and bool_and(c.relowner=r.oid) as owns_registration,
      r.rolsuper,r.rolbypassrls,current_user as registrar from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
      where r.rolname=current_user and n.nspname='public' and c.relname in ('crm_autonomous_workloads','crm_autonomous_access_grants')
      group by r.rolsuper,r.rolbypassrls`)).rows[0];
    if (!owner?.owns_registration || owner.rolsuper || owner.rolbypassrls ||
        ["public", "novalure_app", "novalure_tenant_app"].includes(String(owner.registrar))) throw new Error("AUTONOMOUS_BOOTSTRAP_OWNER_REQUIRED");
    if (input.sourceProfile === "FRANZ_PERSONAL") await connection.query(`insert into crm_autonomous_workloads
      (id,identity_id,workspace_id,actor_user_id,issuer,audience,project_id,owner_id,subject,environment,custom_environment_id,authority_reference)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(id) do nothing`,
    [input.workloadId, source.identityId, CRM_MACHINE_WORKSPACE_ID, input.workloadActorId, CRM_MACHINE_ISSUER,
      CRM_MACHINE_AUDIENCE, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_OWNER_ID, source.subject, source.environment,
      source.customEnvironmentId, input.authorityReference]);
    else await connection.query(`insert into crm_autonomous_workloads(id,identity_id,workspace_id,actor_user_id,issuer,audience,
      project_id,owner_id,subject,environment,authority_reference)
      values($1,'EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY',$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(id) do nothing`,
    [input.workloadId, CRM_MACHINE_WORKSPACE_ID, input.workloadActorId, CRM_MACHINE_ISSUER, CRM_MACHINE_AUDIENCE,
      CRM_MACHINE_PROJECT_ID, CRM_MACHINE_OWNER_ID, CRM_MACHINE_SUBJECT, CRM_MACHINE_ENVIRONMENT, input.authorityReference]);
    const workload = (await connection.query(`select actor_user_id,workspace_id,authority_reference,disabled,kill_switch_active,revoked_at,
      identity_id,issuer,audience,project_id,owner_id,subject,environment,to_jsonb(w)->>'custom_environment_id' as custom_environment_id
      from crm_autonomous_workloads w where id=$1`, [input.workloadId])).rows[0];
    if (!workload || workload.actor_user_id !== input.workloadActorId || workload.workspace_id !== CRM_MACHINE_WORKSPACE_ID ||
        workload.authority_reference !== input.authorityReference || workload.disabled || workload.kill_switch_active || workload.revoked_at ||
        workload.identity_id !== source.identityId || workload.issuer !== CRM_MACHINE_ISSUER || workload.audience !== CRM_MACHINE_AUDIENCE ||
        workload.project_id !== CRM_MACHINE_PROJECT_ID || workload.owner_id !== CRM_MACHINE_OWNER_ID || workload.subject !== source.subject ||
        workload.environment !== source.environment || workload.custom_environment_id !== source.customEnvironmentId) {
      throw new Error("AUTONOMOUS_WORKLOAD_CONFLICT");
    }
    const moduleColumns = moduleConfig ? ",contract_version,read_fields,write_fields,related_resources,lifecycle_mode,parent_grant_id,delegation_kind" : "";
    const moduleValues = moduleConfig ? ",$15,$16,$17,$18::jsonb,$19,$20::uuid,$21" : "";
    const registrationValues: unknown[] = [input.grantId,input.workloadId,CRM_MACHINE_WORKSPACE_ID,input.actorId,input.projectId,
      input.sourceId,input.entity,input.departmentId,input.agentId,input.taskId,input.authorityReference,input.publicKey,[...input.scopes],input.expiresAt];
    if(moduleConfig)registrationValues.push(moduleConfig.contractVersion,[...moduleConfig.readFields],[...moduleConfig.writeFields],JSON.stringify(moduleConfig.relatedResources),moduleConfig.lifecycleMode,moduleConfig.parentGrantId??null,moduleConfig.delegationKind??"DEPARTMENT");
    await connection.query(`insert into crm_autonomous_access_grants(id,workload_id,workspace_id,actor_user_id,project_id,source_id,
      entity,department_id,agent_id,task_id,authority_class,authority_reference,delegation_public_key,scopes,not_before,expires_at${moduleColumns})
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REAL_INTERNAL_OPERATIONS',$11,$12,$13,clock_timestamp(),$14${moduleValues})
      on conflict(id) do nothing`,registrationValues);
    const grant = (await connection.query(`select actor_user_id,workload_id,workspace_id,project_id,source_id,entity,
      department_id,agent_id,task_id,authority_reference,delegation_public_key,scopes,expires_at,disabled,revoked_at${moduleConfig?",contract_version,read_fields,write_fields,related_resources,lifecycle_mode,parent_grant_id,delegation_kind":""}
      from crm_autonomous_access_grants where id=$1`, [input.grantId])).rows[0];
    const expected = { actor_user_id: input.actorId, workload_id: input.workloadId, workspace_id: CRM_MACHINE_WORKSPACE_ID,
      project_id: input.projectId, source_id: input.sourceId, entity: input.entity, department_id: input.departmentId,
      agent_id: input.agentId, task_id: input.taskId, authority_reference: input.authorityReference,
      delegation_public_key: input.publicKey, scopes: [...input.scopes],
      expires_at: input.expiresAt === null ? null : new Date(input.expiresAt).toISOString(), disabled: false, revoked_at: null,
      ...(moduleConfig?{contract_version:moduleConfig.contractVersion,read_fields:[...moduleConfig.readFields],write_fields:[...moduleConfig.writeFields],related_resources:moduleConfig.relatedResources,lifecycle_mode:moduleConfig.lifecycleMode,parent_grant_id:moduleConfig.parentGrantId??null,delegation_kind:moduleConfig.delegationKind??"DEPARTMENT"}:{}) };
    const observed = { ...grant, expires_at: grant?.expires_at instanceof Date ? grant.expires_at.toISOString()
      : grant?.expires_at ? new Date(String(grant.expires_at)).toISOString() : null };
    if (!grant || crmPayloadDigest(observed) !== crmPayloadDigest(expected)) throw new Error("AUTONOMOUS_GRANT_CONFLICT");
    const bound = (await connection.query("select id from public.crm_lock_autonomous_access_grant($1,$2)", [input.workloadId, input.grantId])).rows[0];
    if (!bound) throw new Error("AUTONOMOUS_SCOPE_NOT_GRANTED");
    return Object.freeze({ grantId: input.grantId, workloadId: input.workloadId, status: "REGISTERED" as const,
      departmentId: input.departmentId, agentId: input.agentId, taskId: input.taskId });
}

/** Metadata-only bootstrap. Existing typed leads require the actual operator
 * reader below; a caller-supplied assertion or proof cannot authorize them. */
export async function registerAutonomousCrmAccess(connection: BootstrapConnection, request: AutonomousCrmRegistration) {
  const input = structuredClone(request);
  const validation = validateRegistration(input);
  if (requiresTypedSource(input)) throw new Error("AUTONOMOUS_TYPED_SOURCE_READER_REQUIRED");
  await connection.query("begin");
  try {
    const receipt = await registerInTransaction(connection, input, validation);
    await connection.query("commit");
    return receipt;
  } catch (error) {
    await connection.query("rollback");
    throw error;
  }
}

/** Host-only typed registration on the existing original source-owner client.
 * Owns one transaction: read/SHARE-lock as the real original owner, then switch
 * locally to the actual non-BYPASS registry owner. No new grants or helper SQL.
 * Call on a dedicated, idle operator connection, never inside another BEGIN. */
export async function registerAutonomousCrmAccessFromOperator(connection: BootstrapConnection, request: AutonomousCrmRegistration) {
  const input = structuredClone(request);
  const validation = validateRegistration(input);
  if (!requiresTypedSource(input)) throw new Error("AUTONOMOUS_TYPED_SOURCE_REQUIRED");
  await connection.query("begin");
  try {
    const operator = (await connection.query(`select current_user as actor,session_user as session_actor,
      c.relowner=r.oid as owns_source from pg_roles r cross join pg_class c
      where r.rolname=current_user and c.oid='public.leads'::regclass`)).rows[0];
    if (!operator?.owns_source || operator.actor !== operator.session_actor ||
        ["public", "novalure_app", "novalure_tenant_app"].includes(String(operator.actor))) {
      throw new Error("AUTONOMOUS_SOURCE_OPERATOR_REQUIRED");
    }
    const types = autonomousModuleLeadTypes[input.entity as keyof typeof autonomousModuleLeadTypes];
    const lead = (await connection.query(`select id,type from public.leads where id=$1::uuid
      and workspace_id=$2::uuid and project_id=$3::uuid and data_classification='NOVALURE_INTERNAL'
      and data_purpose='crm_sales' and type=any($4::text[]) for share`,
    [input.sourceId, CRM_MACHINE_WORKSPACE_ID, input.projectId, [...types]])).rows[0];
    if (!lead) throw new Error("AUTONOMOUS_SOURCE_TYPE_DENIED");
    const owners = (await connection.query(`select r.rolname as registrar,count(*)::integer as owned_tables,
      r.rolsuper,r.rolbypassrls from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_roles r on r.oid=c.relowner where n.nspname='public'
      and c.relname in('crm_autonomous_workloads','crm_autonomous_access_grants')
      group by r.oid,r.rolname,r.rolsuper,r.rolbypassrls`)).rows;
    const owner = owners[0];
    if (owners.length !== 1 || owner?.owned_tables !== 2 || owner.rolsuper || owner.rolbypassrls ||
        !/^[a-z_][a-z0-9_]{0,62}$/.test(String(owner.registrar)) ||
        ["public", "novalure_app", "novalure_tenant_app"].includes(String(owner.registrar))) {
      throw new Error("AUTONOMOUS_BOOTSTRAP_OWNER_REQUIRED");
    }
    const role = (await connection.query("select pg_has_role(session_user,$1::name,'SET') as allowed", [owner.registrar])).rows[0];
    if (role?.allowed !== true) throw new Error("AUTONOMOUS_REGISTRAR_ROLE_UNAVAILABLE");
    await connection.query(`set local role "${owner.registrar}"`);
    const receipt = await registerInTransaction(connection, input, validation, sourceLocked);
    await connection.query("commit");
    return receipt;
  } catch (error) {
    await connection.query("rollback");
    throw error;
  }
}
