import { createHash, randomUUID } from "node:crypto";

export const crm080SourceChecksum = "9f401db3b2d08cd4458c5a4b3ab0d114d76bdc2ae87e5a1528de3309b379174e";
export const crm080ProfileId = "qualifying-lead-contact-owner-reconciliation-080-v1";
const production = Object.freeze({ branchId: "br-snowy-fog-aldx77v8", databaseName: "neondb", projectId: "misty-cloud-70835427", runtimeRole: "novalure_app" });
const version = "080_crm_command_safety";
const reconcileSql = `with candidates as (
  select lead.id,lead.workspace_id,contact.owner_user_id
  from public.leads lead
  join public.contacts contact on contact.id=lead.contact_id and contact.workspace_id=lead.workspace_id
  join public.workspace_users owner on owner.id=contact.owner_user_id and owner.workspace_id=lead.workspace_id and owner.status='active'
  where lead.status='Qualifizieren' and lead.assigned_to_user_id is null
  for update of lead
), updated as (
  update public.leads lead set assigned_to_user_id=candidate.owner_user_id,updated_at=now()
  from candidates candidate where lead.id=candidate.id
  returning lead.id,lead.workspace_id,candidate.owner_user_id
)
insert into public.audit_logs(id,workspace_id,actor_user_id,action,entity_type,entity_id,before,after)
select gen_random_uuid(),workspace_id,null,'crm_u1_c06.lead_assignee_reconciled','lead',id,
  jsonb_build_object('assignedToUserId',null),
  jsonb_build_object('assignedToUserId',owner_user_id,'resolutionSource','active_contact_owner','reason','required_integrity_cutover')
from updated`;

const normalize = (value) => value.replace(/\r\n/g, "\n");
const hash = (value) => createHash("sha256").update(value).digest("hex");
function fail(message) { throw new Error(`CRM 080 compatibility refused: ${message}`); }

function attest(target, identity, profile) {
  if (!target || Object.keys(target).sort().join(",") !== "branchId,databaseName,projectId,runtimeRole") fail("exact explicit target required");
  if (identity.currentUser !== "neondb_owner" || identity.currentUser !== identity.sessionUser || identity.databaseName !== "neondb" || identity.projectId !== target.projectId || identity.branchId !== target.branchId) fail("connected owner fingerprint mismatch");
  if (profile === "production") {
    if (Object.keys(production).some((key) => target[key] !== production[key])) fail("pinned Neon Production fingerprint mismatch");
    return `production:${crm080ProfileId}`;
  }
  if (profile !== "rehearsal" || target.projectId !== production.projectId || target.branchId === production.branchId || target.databaseName !== production.databaseName || target.runtimeRole !== production.runtimeRole) fail("pinned Production-rehearsal fingerprint mismatch");
  return `production-rehearsal:${crm080ProfileId}`;
}

export async function applyCrm080Compatibility({ client, executionContext, executionProfile, sql, target }) {
  const source = normalize(sql);
  if (hash(source) !== crm080SourceChecksum) fail("historical source checksum mismatch");
  if (!executionContext || Object.keys(executionContext).sort().join(",") !== "headCommit,planDigest" || !/^[a-f0-9]{40}$/.test(executionContext.headCommit) || !/^[a-f0-9]{64}$/.test(executionContext.planDigest)) fail("exact runner commit and plan digest required");
  try { await client.query("savepoint crm_080_compat"); } catch { fail("caller transaction required"); }
  const identity = (await client.query(`select current_user as "currentUser",session_user as "sessionUser",current_database() as "databaseName",current_setting('neon.project_id',true) as "projectId",current_setting('neon.branch_id',true) as "branchId"`)).rows[0];
  const profileId = attest(target, identity, executionProfile);
  const invalid = await client.query(`select lead.id,
    contact.owner_user_id is not null and owner.id is not null as repairable
    from public.leads lead
    left join public.contacts contact on contact.id=lead.contact_id and contact.workspace_id=lead.workspace_id
    left join public.workspace_users owner on owner.id=contact.owner_user_id and owner.workspace_id=lead.workspace_id and owner.status='active'
    where lead.status='Qualifizieren' and lead.assigned_to_user_id is null
    order by lead.id`);
  if (invalid.rows.some((row) => row.repairable !== true)) fail("every legacy qualifying lead must have one active contact owner");
  await client.query(reconcileSql);
  // Flush deferred FK events before 080 performs ALTER TABLE on the same
  // relations; the entire sequence still commits or rolls back atomically.
  await client.query("set constraints all immediate");
  const remaining = await client.query("select count(*)::integer as count from public.leads where status='Qualifizieren' and assigned_to_user_id is null");
  if (remaining.rows[0]?.count !== 0) fail("lead reconciliation did not converge");
  await client.query({ query_timeout: 960_000, text: source });
  const evidence = { executionContext, reconciledLeadCount: invalid.rows.length, remainingViolations: 0 };
  const executedSqlChecksum = hash(`${reconcileSql}\n${source}`);
  await client.query("insert into public.novalure_migration_execution_receipts(id,source_version,source_checksum,executed_sql_checksum,profile_id,target,catalog_evidence) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)", [randomUUID(), version, crm080SourceChecksum, executedSqlChecksum, profileId, JSON.stringify(target), JSON.stringify(evidence)]);
  return Object.freeze({ evidence, executedSqlChecksum, profileId, sourceChecksum: crm080SourceChecksum });
}
