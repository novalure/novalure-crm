import "server-only";
import { createPublicKey } from "node:crypto";
import { assertCrmUuid, crmPayloadDigest } from "./crm-command";
import { CRM_MACHINE_AUDIENCE, CRM_MACHINE_ENVIRONMENT, CRM_MACHINE_ISSUER, CRM_MACHINE_OWNER_ID,
  CRM_MACHINE_PROJECT_ID, CRM_MACHINE_SUBJECT, CRM_MACHINE_WORKSPACE_ID } from "./crm-machine-auth";
import { websiteSalesMachineScopes, type WebsiteSalesMachineScope } from "./website-sales-machine";

export type WebsiteSalesMachineRegistration = Readonly<{
  workloadId: string; workloadActorId: string; grantId: string; actorId: string; projectId: string;
  companyId: string; locationId: string | null; departmentId: "SALES"; agentId: string; taskId: string;
  scopes: readonly WebsiteSalesMachineScope[]; publicKey: string; authorityReference: string; expiresAt: string | null;
}>;
type BootstrapConnection = { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

/** No HTTP provisioner. The protected deployment owner registers public keys and exact resources
 * only after target/revision gates; this function never creates a member, project or business record. */
export async function registerWebsiteSalesMachineAccess(connection: BootstrapConnection, input: WebsiteSalesMachineRegistration) {
  for (const id of [input.workloadId, input.workloadActorId, input.grantId, input.actorId, input.projectId, input.companyId, input.taskId]) assertCrmUuid(id);
  if (input.locationId !== null) assertCrmUuid(input.locationId);
  const key = createPublicKey({ key: Buffer.from(input.publicKey, "base64url"), format: "der", type: "spki" });
  if (input.departmentId !== "SALES" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.agentId)
    || key.asymmetricKeyType !== "ed25519" || input.publicKey.length !== 59 || !input.scopes.length
    || new Set(input.scopes).size !== input.scopes.length || input.scopes.some(scope => !websiteSalesMachineScopes.includes(scope))
    || input.locationId === null && input.scopes.some(scope => !["crm.website-sales.register-location", "crm.website-sales.reconcile"].includes(scope))
    || input.locationId !== null && input.scopes.includes("crm.website-sales.register-location")
    || !input.authorityReference.trim() || input.authorityReference.length > 200
    || input.expiresAt !== null && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())) throw new Error("SALES_REGISTRATION_INVALID");
  await connection.query("begin");
  try {
    const owner = (await connection.query(`select count(*)::int as relations,bool_and(c.relowner=r.oid) as owns_registration,
      r.rolsuper,r.rolbypassrls,current_user as registrar from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
      where r.rolname=current_user and n.nspname='public' and c.relname in ('crm_website_sales_machine_workloads','crm_website_sales_machine_grants')
      group by r.rolsuper,r.rolbypassrls`)).rows[0];
    if (owner?.relations !== 2 || !owner.owns_registration || owner.rolsuper || owner.rolbypassrls
      || ["public", "novalure_app", "novalure_tenant_app"].includes(String(owner.registrar))) throw new Error("SALES_BOOTSTRAP_OWNER_REQUIRED");
    await connection.query(`insert into crm_website_sales_machine_workloads(id,identity_id,workspace_id,actor_user_id,issuer,audience,
      project_id,owner_id,subject,environment,authority_reference)
      values($1,'EVELYN_WEBSITE_SALES_INTERNAL_IDENTITY',$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(id) do nothing`,
    [input.workloadId, CRM_MACHINE_WORKSPACE_ID, input.workloadActorId, CRM_MACHINE_ISSUER, CRM_MACHINE_AUDIENCE,
      CRM_MACHINE_PROJECT_ID, CRM_MACHINE_OWNER_ID, CRM_MACHINE_SUBJECT, CRM_MACHINE_ENVIRONMENT, input.authorityReference]);
    const workload = (await connection.query(`select actor_user_id,workspace_id,authority_reference,disabled,kill_switch_active,revoked_at
      from crm_website_sales_machine_workloads where id=$1`, [input.workloadId])).rows[0];
    if (!workload || workload.actor_user_id !== input.workloadActorId || workload.workspace_id !== CRM_MACHINE_WORKSPACE_ID
      || workload.authority_reference !== input.authorityReference || workload.disabled || workload.kill_switch_active || workload.revoked_at) throw new Error("SALES_WORKLOAD_CONFLICT");
    await connection.query(`insert into crm_website_sales_machine_grants(id,workload_id,workspace_id,actor_user_id,project_id,company_id,location_id,
      department_id,agent_id,task_id,authority_reference,delegation_public_key,scopes,not_before,expires_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp(),$14) on conflict(id) do nothing`,
    [input.grantId, input.workloadId, CRM_MACHINE_WORKSPACE_ID, input.actorId, input.projectId, input.companyId, input.locationId,
      input.departmentId, input.agentId, input.taskId, input.authorityReference, input.publicKey, [...input.scopes], input.expiresAt]);
    const saved = (await connection.query(`select workload_id,workspace_id,actor_user_id,project_id,company_id,location_id,department_id,
      agent_id,task_id,authority_reference,delegation_public_key,scopes,expires_at,disabled,revoked_at
      from crm_website_sales_machine_grants where id=$1`, [input.grantId])).rows[0];
    const expected = { workload_id: input.workloadId, workspace_id: CRM_MACHINE_WORKSPACE_ID, actor_user_id: input.actorId,
      project_id: input.projectId, company_id: input.companyId, location_id: input.locationId, department_id: input.departmentId,
      agent_id: input.agentId, task_id: input.taskId, authority_reference: input.authorityReference,
      delegation_public_key: input.publicKey, scopes: [...input.scopes],
      expires_at: input.expiresAt === null ? null : new Date(input.expiresAt).toISOString(), disabled: false, revoked_at: null };
    const observed = { ...saved, expires_at: saved?.expires_at instanceof Date ? saved.expires_at.toISOString() : saved?.expires_at ? new Date(String(saved.expires_at)).toISOString() : null };
    if (!saved || crmPayloadDigest(observed) !== crmPayloadDigest(expected)) throw new Error("SALES_GRANT_CONFLICT");
    if (!(await connection.query("select id from public.crm_lock_website_sales_machine_grant($1,$2)", [input.workloadId, input.grantId])).rows[0]) throw new Error("SALES_SCOPE_NOT_GRANTED");
    await connection.query("commit");
    return Object.freeze({ status: "REGISTERED" as const, workloadId: input.workloadId, grantId: input.grantId,
      projectId: input.projectId, companyId: input.companyId, locationId: input.locationId });
  } catch (error) { await connection.query("rollback"); throw error; }
}
