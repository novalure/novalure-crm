import { createHash, randomUUID } from "node:crypto";

export const media062SourceChecksum = "e07103bc6eff0cf3e45154e591b15254ec3629497fcdb8acd5e75c94c8bd7e96";
export const media062ProfileId = "append-only-audit-redaction-062-v1";
const production = Object.freeze({
  branchId: "br-snowy-fog-aldx77v8",
  databaseName: "neondb",
  projectId: "misty-cloud-70835427",
  runtimeRole: "novalure_app",
});
const version = "062_private_media_contract_cutover";

function normalize(value) {
  return value.replace(/\r\n/g, "\n");
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function fail(message) {
  throw new Error(`Media 062 compatibility refused: ${message}`);
}

export function renderMedia062Compatibility(sql) {
  const source = normalize(sql);
  if (hash(source) !== media062SourceChecksum) fail("historical source checksum mismatch");
  const auditUpdate = `update audit_logs
set after = jsonb_set(
  after,
  '{mediaAsset}',
  (after->'mediaAsset')
    - 'publicToken'
    - 'publicUrl'
    - 'relativePath'
    - 'url'
    - 'workspaceId',
  false
)
where action = 'bot.document_send.attach_media_asset'
  and jsonb_typeof(after->'mediaAsset') = 'object';`;
  if (source.split(auditUpdate).length !== 2) fail("exact audit redaction statement not found once");
  const executedSql = source.replace(
    auditUpdate,
    `lock table public.audit_logs in access exclusive mode;
alter table public.audit_logs disable trigger audit_logs_append_only_guard;
${auditUpdate}
alter table public.audit_logs enable trigger audit_logs_append_only_guard;`,
  );
  return Object.freeze({
    executedSql,
    executedSqlChecksum: hash(executedSql),
    sourceChecksum: media062SourceChecksum,
  });
}

function attestTarget(target, identity, profile) {
  if (!target || Object.keys(target).sort().join(",") !== "branchId,databaseName,projectId,runtimeRole") fail("exact explicit target required");
  if (identity.currentUser !== "neondb_owner" || identity.currentUser !== identity.sessionUser || identity.databaseName !== "neondb") fail("owner database identity mismatch");
  if (identity.projectId !== target.projectId || identity.branchId !== target.branchId) fail("connected Neon fingerprint mismatch");
  if (profile === "production") {
    if (Object.keys(production).some((key) => target[key] !== production[key])) fail("pinned Neon Production fingerprint mismatch");
    return `production:${media062ProfileId}`;
  }
  if (profile !== "rehearsal" || target.projectId !== production.projectId || target.branchId === production.branchId || target.databaseName !== production.databaseName || target.runtimeRole !== production.runtimeRole) fail("pinned Production-rehearsal fingerprint mismatch");
  return `production-rehearsal:${media062ProfileId}`;
}

export async function applyMedia062Compatibility({ client, executionContext, executionProfile, sql, target }) {
  if (!executionContext || Object.keys(executionContext).sort().join(",") !== "headCommit,planDigest" || !/^[a-f0-9]{40}$/.test(executionContext.headCommit) || !/^[a-f0-9]{64}$/.test(executionContext.planDigest)) fail("exact runner commit and plan digest required");
  const prepared = renderMedia062Compatibility(sql);
  try {
    await client.query("savepoint media_062_compat");
  } catch {
    fail("caller transaction required");
  }
  const identityResult = await client.query(`select current_user as "currentUser",session_user as "sessionUser",current_database() as "databaseName",current_setting('neon.project_id',true) as "projectId",current_setting('neon.branch_id',true) as "branchId"`);
  const profileId = attestTarget(target, identityResult.rows[0], executionProfile);
  const ledger = await client.query("select version,checksum from public.novalure_schema_migrations where version in ('061_validate_and_activate_tenant_rls_pilot','062_private_media_contract_cutover') order by version");
  if (ledger.rows.some((row) => row.version === version)) fail("062 already applied");
  if (!ledger.rows.some((row) => row.version === "061_validate_and_activate_tenant_rls_pilot")) fail("checksummed 061 predecessor required");
  const trigger = await client.query("select tgenabled,pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid='public.audit_logs'::regclass and tgname='audit_logs_append_only_guard' and not tgisinternal");
  if (trigger.rows.length !== 1 || trigger.rows[0].tgenabled !== "O" || !/reject_audit_logs_mutation/i.test(trigger.rows[0].definition)) fail("exact enabled append-only audit trigger required");
  const before = await client.query(`select
    (select count(*)::integer from media_assets where is_public and public_token is not null and btrim(public_token)<>'') as "legacyTokens",
    (select count(*)::integer from media_assets where url is distinct from '/api/media/files/'||id::text) as "legacyUrls",
    (select count(*)::integer from bot_document_sends where metadata ?| array['asset','attachedMediaAssetPublicUrl','attachedMediaAssetUrl','documentUrl']) as "metadataRows",
    (select count(*)::integer from audit_logs where action='bot.document_send.attach_media_asset' and jsonb_typeof(after->'mediaAsset')='object' and (after->'mediaAsset' ?| array['publicToken','publicUrl','relativePath','url','workspaceId'])) as "auditRows"`);
  await client.query(prepared.executedSql);
  const after = await client.query(`select
    (select count(*)::integer from media_assets where public_token is not null or url is distinct from '/api/media/files/'||id::text) as "assetRows",
    (select count(*)::integer from bot_document_sends where metadata ?| array['asset','attachedMediaAssetPublicUrl','attachedMediaAssetUrl','documentUrl']) as "metadataRows",
    (select count(*)::integer from audit_logs where action='bot.document_send.attach_media_asset' and jsonb_typeof(after->'mediaAsset')='object' and (after->'mediaAsset' ?| array['publicToken','publicUrl','relativePath','url','workspaceId'])) as "auditRows",
    (select tgenabled from pg_trigger where tgrelid='public.audit_logs'::regclass and tgname='audit_logs_append_only_guard' and not tgisinternal) as "triggerEnabled"`);
  if (after.rows[0]?.assetRows !== 0 || after.rows[0]?.metadataRows !== 0 || after.rows[0]?.auditRows !== 0 || after.rows[0]?.triggerEnabled !== "O") fail("post-redaction contract failed");
  const evidence = { before: before.rows[0], after: after.rows[0], executionContext };
  await client.query("insert into public.novalure_migration_execution_receipts(id,source_version,source_checksum,executed_sql_checksum,profile_id,target,catalog_evidence) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)", [randomUUID(), version, prepared.sourceChecksum, prepared.executedSqlChecksum, profileId, JSON.stringify(target), JSON.stringify(evidence)]);
  return Object.freeze({ ...prepared, evidence, profileId });
}
