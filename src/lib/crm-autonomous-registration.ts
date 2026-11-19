import "server-only";
import { createPublicKey } from "node:crypto";
import { assertCrmUuid, crmPayloadDigest } from "./crm-command";
import { CRM_MACHINE_AUDIENCE, CRM_MACHINE_ENVIRONMENT, CRM_MACHINE_ISSUER,
  CRM_MACHINE_OWNER_ID, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_SUBJECT, CRM_MACHINE_WORKSPACE_ID } from "./crm-machine-auth";

export const autonomousCrmDepartments = [
  "EVELYN_CEO", "BUSINESS_DEVELOPMENT", "SALES", "MARKETING_ADS", "WEBSITE_STUDIO", "REAL_ESTATE_OPERATIONS",
  "PROJECT_MANAGEMENT", "IT_CRM", "SECRETARIAT_ADMINISTRATION", "SUPPORT", "FINANCE", "LEGAL_COMPLIANCE",
  "HR", "PROCUREMENT", "SOCIAL_MEDIA", "VOICE_TELEPHONE",
] as const;
export type AutonomousCrmRegistration = Readonly<{
  workloadId: string; workloadActorId: string; grantId: string; actorId: string;
  projectId: string; sourceId: string; departmentId: typeof autonomousCrmDepartments[number];
  agentId: string; taskId: string; entity: "Task" | "Project";
  scopes: readonly ("crm.tasks.read" | "crm.tasks.write" | "crm.projects.read")[];
  publicKey: string; authorityReference: string; expiresAt: string | null;
}>;
type BootstrapConnection = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

/** Host-only bootstrap using an existing protected migration-owner connection.
 * No HTTP route exposes this function. It receives public key material only.
 * Call only after the exact target, source and applicable deployment gates pass. */
export async function registerAutonomousCrmAccess(connection: BootstrapConnection, input: AutonomousCrmRegistration) {
  for (const id of [input.workloadId, input.workloadActorId, input.grantId, input.actorId, input.projectId, input.sourceId, input.taskId]) assertCrmUuid(id);
  const key = createPublicKey({ key: Buffer.from(input.publicKey, "base64url"), format: "der", type: "spki" });
  const allowedScopes = input.entity === "Task" ? ["crm.tasks.read", "crm.tasks.write"] : ["crm.projects.read"];
  if (!autonomousCrmDepartments.includes(input.departmentId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.agentId) ||
      !["Task", "Project"].includes(input.entity) || !input.scopes.length || input.scopes.some(scope => !allowedScopes.includes(scope)) ||
      key.asymmetricKeyType !== "ed25519" || input.publicKey.length !== 59 ||
      !input.authorityReference.trim() || input.authorityReference.length > 200 ||
      (input.expiresAt !== null && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()))) {
    throw new Error("AUTONOMOUS_REGISTRATION_INVALID");
  }
  await connection.query("begin");
  try {
    const owner = (await connection.query(`select bool_and(c.relowner=r.oid) as owns_registration,
      r.rolsuper,r.rolbypassrls,current_user as registrar from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
      where r.rolname=current_user and n.nspname='public' and c.relname in ('crm_autonomous_workloads','crm_autonomous_access_grants')
      group by r.rolsuper,r.rolbypassrls`)).rows[0];
    if (!owner?.owns_registration || owner.rolsuper || owner.rolbypassrls ||
        ["public", "novalure_app", "novalure_tenant_app"].includes(String(owner.registrar))) throw new Error("AUTONOMOUS_BOOTSTRAP_OWNER_REQUIRED");
    await connection.query(`insert into crm_autonomous_workloads(id,identity_id,workspace_id,actor_user_id,issuer,audience,
      project_id,owner_id,subject,environment,authority_reference)
      values($1,'EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY',$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(id) do nothing`,
    [input.workloadId, CRM_MACHINE_WORKSPACE_ID, input.workloadActorId, CRM_MACHINE_ISSUER, CRM_MACHINE_AUDIENCE,
      CRM_MACHINE_PROJECT_ID, CRM_MACHINE_OWNER_ID, CRM_MACHINE_SUBJECT, CRM_MACHINE_ENVIRONMENT, input.authorityReference]);
    const workload = (await connection.query(`select actor_user_id,workspace_id,authority_reference,disabled,kill_switch_active,revoked_at
      from crm_autonomous_workloads where id=$1`, [input.workloadId])).rows[0];
    if (!workload || workload.actor_user_id !== input.workloadActorId || workload.workspace_id !== CRM_MACHINE_WORKSPACE_ID ||
        workload.authority_reference !== input.authorityReference || workload.disabled || workload.kill_switch_active || workload.revoked_at) {
      throw new Error("AUTONOMOUS_WORKLOAD_CONFLICT");
    }
    await connection.query(`insert into crm_autonomous_access_grants(id,workload_id,workspace_id,actor_user_id,project_id,source_id,
      entity,department_id,agent_id,task_id,authority_class,authority_reference,delegation_public_key,scopes,not_before,expires_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REAL_INTERNAL_OPERATIONS',$11,$12,$13,clock_timestamp(),$14)
      on conflict(id) do nothing`, [input.grantId, input.workloadId, CRM_MACHINE_WORKSPACE_ID, input.actorId, input.projectId,
      input.sourceId, input.entity, input.departmentId, input.agentId, input.taskId, input.authorityReference,
      input.publicKey, [...input.scopes], input.expiresAt]);
    const grant = (await connection.query(`select actor_user_id,workload_id,workspace_id,project_id,source_id,entity,
      department_id,agent_id,task_id,authority_reference,delegation_public_key,scopes,expires_at,disabled,revoked_at
      from crm_autonomous_access_grants where id=$1`, [input.grantId])).rows[0];
    const expected = { actor_user_id: input.actorId, workload_id: input.workloadId, workspace_id: CRM_MACHINE_WORKSPACE_ID,
      project_id: input.projectId, source_id: input.sourceId, entity: input.entity, department_id: input.departmentId,
      agent_id: input.agentId, task_id: input.taskId, authority_reference: input.authorityReference,
      delegation_public_key: input.publicKey, scopes: [...input.scopes],
      expires_at: input.expiresAt === null ? null : new Date(input.expiresAt).toISOString(), disabled: false, revoked_at: null };
    const observed = { ...grant, expires_at: grant?.expires_at instanceof Date ? grant.expires_at.toISOString()
      : grant?.expires_at ? new Date(String(grant.expires_at)).toISOString() : null };
    if (!grant || crmPayloadDigest(observed) !== crmPayloadDigest(expected)) throw new Error("AUTONOMOUS_GRANT_CONFLICT");
    const bound = (await connection.query("select id from public.crm_lock_autonomous_access_grant($1,$2)", [input.workloadId, input.grantId])).rows[0];
    if (!bound) throw new Error("AUTONOMOUS_SCOPE_NOT_GRANTED");
    await connection.query("commit");
    return Object.freeze({ grantId: input.grantId, workloadId: input.workloadId, status: "REGISTERED" as const,
      departmentId: input.departmentId, agentId: input.agentId, taskId: input.taskId });
  } catch (error) {
    await connection.query("rollback");
    throw error;
  }
}
