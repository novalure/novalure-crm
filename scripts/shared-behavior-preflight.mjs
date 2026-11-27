#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertSharedBehaviorMigrationSources } from "./lib/shared-behavior-migration-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const predecessor = [
  "091_production_runtime_forced_rls_cutover", "092_crm_production_machine_identity",
  "093_crm_machine_internal_context", "101_knowledge_center",
  "108_knowledge_connected_assistant_quota", "114_customer_workspace_provisioning",
];
const staged = ["shared_behavior_foundation", "shared_behavior_package2", "shared_behavior_package3", "shared_behavior_personal_runtime"];
const digest = path => createHash("sha256").update(readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n")).digest("hex");
const quote = text => "'" + text.replaceAll("'", "''") + "'";
const hashes = Object.fromEntries(staged.map(name => [name, digest("migrations/staged/" + name + ".sql")]));
const sourceContract = assertSharedBehaviorMigrationSources({ cwd: root });
const expected = predecessor.map(version => "(" + quote(version) + "," + quote(digest("migrations/" + version + ".sql")) + ")").join(",");
const sql = `with expected(version,checksum) as (values ${expected})
select jsonb_build_object('observedAtUtc',clock_timestamp(),'projectId',current_setting('neon.project_id',true),
'branchId',current_setting('neon.branch_id',true),'database',current_database(),
'checks',jsonb_build_object(
 'exactTarget',current_database()='neondb' and current_setting('neon.project_id',true)='misty-cloud-70835427'
  and current_setting('neon.branch_id',true)='br-snowy-fog-aldx77v8',
 'actual114Ledger',(select max(version)='114_customer_workspace_provisioning' and count(*)=68 from public.novalure_schema_migrations),
 'predecessorChecksums',not exists(select 1 from expected e left join public.novalure_schema_migrations m using(version) where m.checksum is distinct from e.checksum),
 'migrationNumbersFree',not exists(select 1 from public.novalure_schema_migrations where version ~ '^(115|116|117|118)_'),
 'packagesNotApplied',not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
  and c.relname=any(array['behavior_learning_signals','behavior_releases','behavior_release_head','behavior_candidates',
  'behavior_evaluations','behavior_publication_events','behavior_runtime_bindings','behavior_personal_workload_bindings'])),
 'requiredForcedRls',(select count(*)=5 and bool_and(c.relrowsecurity and c.relforcerowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname=any(array['bots','knowledge_areas','knowledge_sources','knowledge_area_grants','knowledge_source_versions'])),
 'safeRuntimeRoles',(select count(*)=2 and bool_and(not rolsuper and not rolbypassrls and not rolcreatedb and not rolcreaterole and not rolreplication)
  from pg_roles where rolname in ('novalure_app','novalure_tenant_app')),
 'newRolesAbsent',not exists(select 1 from pg_roles where rolname in ('novalure_behavior_publisher','novalure_behavior_resolver')),
 'memberCompositeKey',exists(select 1 from pg_index where indrelid='public.workspace_users'::regclass and indisunique and indisvalid and indpred is null and indexprs is null and pg_get_indexdef(indexrelid) like '% (workspace_id, id)'),
 'botCompositeKey',exists(select 1 from pg_index where indrelid='public.bots'::regclass and indisunique and indisvalid and indpred is null and indexprs is null and pg_get_indexdef(indexrelid) like '% (id, workspace_id)')
)) as preflight;`;
if (process.argv[2] === "--sql" && process.argv.length === 3) {
  console.log(sql);
} else if (process.argv[2] === "--verify-readback" && process.argv.length === 4) {
  const value = JSON.parse(readFileSync(resolve(process.argv[3]), "utf8"));
  const row = Array.isArray(value) && value.length === 1 ? value[0].preflight : null;
  const checks = row?.checks;
  const names = ["exactTarget","actual114Ledger","predecessorChecksums","migrationNumbersFree","packagesNotApplied","requiredForcedRls","safeRuntimeRoles","newRolesAbsent","memberCompositeKey","botCompositeKey"];
  const pass = checks && Object.keys(checks).length === names.length && names.every(name => checks[name] === true);
  console.log(JSON.stringify({ status: pass ? "PASS_PRE_MIGRATION_ONLY" : "FAIL_CLOSED", sourceHashes: hashes,
    registeredSourceVersions: sourceContract.versions, observedAtUtc: row?.observedAtUtc ?? null, checks: checks ?? null,
    proves: "read-only actual predecessor metadata; no upgrade, deployment, auth, workload or activation proof" }, null, 2));
  if (!pass) process.exitCode = 1;
} else {
  throw new Error("Use --sql or --verify-readback <metadata-json>; no database credential is accepted");
}
