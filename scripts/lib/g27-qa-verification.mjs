import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

// This helper is intentionally unusable on any existing branch or Production.
const target = Object.freeze({ project: "super-block-59791927", branch: "br-summer-breeze-awuzinct", databases: ["qa_g27_20260923", "qa_g27_restore_20260923", "qa_g27_recovery_20260924"], runtime: "g27_qa_20260923" });
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';

async function assertTarget(client) {
  const { rows: [row] } = await client.query("select current_database() as database, current_setting('neon.project_id',true) as project, current_setting('neon.branch_id',true) as branch");
  assert.ok(target.databases.includes(row.database), "G27 refuses an unowned database");
  assert.equal(row.project, target.project, "G27 refuses a different project");
  assert.equal(row.branch, target.branch, "G27 refuses a different branch");
}
async function transaction(pool, scope, callback, { commit = false, readOnly = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? "begin isolation level repeatable read read only" : "begin");
    await client.query("set local search_path=pg_catalog,public");
    await client.query("set local timezone='UTC'");
    await assertTarget(client);
    await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [scope?.workspace ?? "", scope?.actor ?? ""]);
    const result = await callback(client);
    await client.query(commit ? "commit" : "rollback");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}
async function expectSqlFailure(pool, scope, sql, parameters, codes) {
  let caught;
  try {
    await transaction(pool, scope, async client => {
      await client.query(sql, parameters);
      await client.query("set constraints all immediate");
    });
  } catch (error) { caught = error; }
  assert.ok(caught && codes.includes(caught.code), "Expected PostgreSQL denial " + codes.join("/") + "; received " + (caught?.code ?? "successful execution"));
}

/** Commits only explicitly synthetic fixtures, after the exact remote QA target guard. */
export async function seedG27Fixture(admin) {
  const ids = Object.fromEntries(["workspace", "foreignWorkspace", "owner", "agent", "foreignOwner", "project", "hiddenProject", "foreignProject", "organization", "contact", "hiddenContact", "foreignContact", "task", "unit", "lead", "audit", "receipt"].map(key => [key, randomUUID()]));
  await transaction(admin, null, async client => {
    assert.equal((await client.query("select count(*)::int as n from workspaces where id<>'8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101' or name<>'Novalure Growth' or slug is distinct from 'novalure-growth' or setup_state->>'createdByMigration' is distinct from '030_novalure_growth_workspace'")).rows[0].n, 0, "Seed permits only the unchanged migration-030 workspace");
    assert.equal((await client.query("select count(*)::int as n from workspaces")).rows[0].n, 1, "The original migration-030 workspace must remain present");
    const originalProjects = (await client.query("select id,workspace_id,name,type,status,default_pipeline_id from projects")).rows;
    assert.deepEqual(originalProjects, [{ id: "f7d83c6b-d08d-4d73-b822-1f1c0b4733d2", workspace_id: "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101", name: "Novalure Eigenakquise", type: "internal_growth", status: "Aktiv", default_pipeline_id: "a5cf82f8-c6f4-4517-a0f6-9d9f17601830" }], "Only the original migration-030 project may precede the fixture");
    const originalAudit = (await client.query("select workspace_id,actor_user_id,action,entity_type,entity_id,before,after from audit_logs")).rows;
    assert.deepEqual(originalAudit, [{ workspace_id: "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101", actor_user_id: null, action: "workspace.seeded", entity_type: "workspace", entity_id: "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101", before: null, after: { migration: "030_novalure_growth_workspace", workspace: "Novalure Growth", profiles: ["novalureGrowth", "novalureServiceOps", "novalureAdmin"] } }], "The original append-only migration-030 audit must remain unchanged");
    for (const table of ["workspace_users", "contacts", "leads", "tasks", "property_units"]) assert.equal((await client.query("select count(*)::int as n from public." + identifier(table))).rows[0].n, 0, "Seed requires fresh business tables");
    await client.query("insert into workspaces(id,name,operating_model,setup_state) values($1,'SYNTHETIC G27 tenant A','managed_by_novalure','{\"syntheticQa\":true}'),($2,'SYNTHETIC G27 tenant B','managed_by_novalure','{\"syntheticQa\":true}')", [ids.workspace, ids.foreignWorkspace]);
    await client.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$4,'SYNTHETIC owner','g27-owner@example.invalid','owner','customer_owner'),($2,$4,'SYNTHETIC agent','g27-agent@example.invalid','agent','project_sales_member'),($3,$5,'SYNTHETIC foreign owner','g27-foreign@example.invalid','owner','customer_owner')", [ids.owner, ids.agent, ids.foreignOwner, ids.workspace, ids.foreignWorkspace]);
    await client.query("insert into projects(id,workspace_id,name,type) values($1,$4,'SYNTHETIC granted project','Bauträger'),($2,$4,'SYNTHETIC hidden project','Bauträger'),($3,$5,'SYNTHETIC foreign project','Bauträger')", [ids.project, ids.hiddenProject, ids.foreignProject, ids.workspace, ids.foreignWorkspace]);
    await client.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [ids.workspace, ids.project, ids.agent]);
    await client.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC developer','Bauträger')", [ids.organization, ids.workspace, ids.project]);
    await client.query("insert into contacts(id,workspace_id,project_id,name,role) values($1,$4,$6,'SYNTHETIC buyer','Käufer'),($2,$4,$7,'SYNTHETIC hidden buyer','Käufer'),($3,$5,$8,'SYNTHETIC foreign buyer','Käufer')", [ids.contact, ids.hiddenContact, ids.foreignContact, ids.workspace, ids.foreignWorkspace, ids.project, ids.hiddenProject, ids.foreignProject]);
    await client.query("insert into leads(id,workspace_id,project_id,contact_id,type,buyer_profile) values($1,$2,$3,$4,'Käufer','{}')", [ids.lead, ids.workspace, ids.project, ids.contact]);
    await client.query("insert into tasks(id,workspace_id,project_id,contact_id,title) values($1,$2,$3,$4,'SYNTHETIC G27 task')", [ids.task, ids.workspace, ids.project, ids.contact]);
    await client.query("insert into property_units(id,workspace_id,project_id,unit_number,status,price_cents) values($1,$2,$3,'SYNTHETIC-G27-01','available',35000000)", [ids.unit, ids.workspace, ids.project]);
    await client.query("insert into audit_logs(id,workspace_id,actor_user_id,project_id,action,entity_type,entity_id,after) values($1,$2,$3,$4,'SYNTHETIC_G27_SEED','contact',$5,'{\"synthetic\":true}')", [ids.audit, ids.workspace, ids.owner, ids.project, ids.contact]);
    await client.query("insert into crm_command_receipts(id,workspace_id,project_id,actor_user_id,operation,resource_id,idempotency_key,request_hash,response,audit_reference,correlation_id,data_classification) values($1,$2,$3,$4,'SYNTHETIC_G27_SEED',$5,$6,$7,'{\"synthetic\":true}',$8,$9,'CUSTOMER_TENANT')", [ids.receipt, ids.workspace, ids.project, ids.owner, ids.contact, randomUUID(), hash("SYNTHETIC G27 fixture command"), ids.audit, randomUUID()]);
  }, { commit: true });
  return Object.freeze(ids);
}

/** Every mutation probe rolls back. Results contain check names, never row payloads or credentials. */
export async function verifyG27Security({ admin, runtime, ids }) {
  const checks = [];
  const agent = { workspace: ids.workspace, actor: ids.agent };
  const owner = { workspace: ids.workspace, actor: ids.owner };
  const check = async (name, fn) => {
    try { await fn(); checks.push({ name, status: "PASS" }); }
    catch (error) { throw new Error("G27 check failed: " + name + "; " + (error.code ?? error.message), { cause: error }); }
  };
  await check("runtime_is_safe_nonowner_without_schema_create_or_privileged_role_path", () => transaction(runtime, null, async client => {
    const { rows: [role] } = await client.query("select rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname=current_user");
    assert.deepEqual(role, { rolname: target.runtime, rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    assert.equal((await client.query("select count(*)::int as n from pg_class where relnamespace='public'::regnamespace and relowner=(select oid from pg_roles where rolname=current_user)")).rows[0].n, 0);
    assert.equal((await client.query("select has_schema_privilege(current_user,'public','CREATE') as allowed")).rows[0].allowed, false);
    assert.equal((await client.query("select count(*)::int as n from pg_roles where (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls) and (pg_has_role(current_user,oid,'USAGE') or pg_has_role(current_user,oid,'SET'))")).rows[0].n, 0);
    assert.equal((await client.query("select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid=m.roleid where m.member=(select oid from pg_roles where rolname=current_user) and r.rolname='novalure_tenant_app' and m.inherit_option and not m.admin_option")).rows[0].n, 1);
  }));
  for (const table of ["projects", "contacts", "leads", "tasks", "property_units", "crm_command_receipts"]) {
    await check("default_context_denies_" + table, () => transaction(runtime, null, async client => assert.equal((await client.query("select count(*)::int as n from public." + identifier(table))).rows[0].n, 0)));
  }
  await check("agent_reads_only_granted_project_and_contact", () => transaction(runtime, agent, async client => {
    assert.deepEqual((await client.query("select id from projects order by id")).rows.map(row => row.id), [ids.project]);
    assert.deepEqual((await client.query("select id from contacts order by id")).rows.map(row => row.id), [ids.contact]);
  }));
  await check("owner_reads_own_projects_but_not_foreign_tenant", () => transaction(runtime, owner, async client => {
    assert.deepEqual((await client.query("select id from projects order by id")).rows.map(row => row.id).sort(), [ids.project, ids.hiddenProject].sort());
  }));
  await check("foreign_actor_cannot_read_claimed_workspace", () => transaction(runtime, { workspace: ids.workspace, actor: ids.foreignOwner }, async client => assert.equal((await client.query("select count(*)::int as n from contacts")).rows[0].n, 0)));
  await check("hidden_and_foreign_updates_affect_zero_rows", () => transaction(runtime, agent, async client => {
    assert.equal((await client.query("update contacts set name='SYNTHETIC forbidden edit' where id=any($1::uuid[])", [[ids.hiddenContact, ids.foreignContact]])).rowCount, 0);
  }));
  await check("cross_tenant_insert_denied_by_rls", () => expectSqlFailure(runtime, agent, "insert into contacts(workspace_id,project_id,name,role) values($1,$2,'SYNTHETIC denied','Käufer')", [ids.foreignWorkspace, ids.foreignProject], ["42501"]));
  await check("hidden_project_insert_denied_by_rls", () => expectSqlFailure(runtime, agent, "insert into contacts(workspace_id,project_id,name,role) values($1,$2,'SYNTHETIC denied','Käufer')", [ids.workspace, ids.hiddenProject], ["42501"]));
  await check("classification_mutation_denied", () => expectSqlFailure(runtime, agent, "update contacts set data_classification='PRIVATE_FRANZ' where id=$1", [ids.contact], ["42501"]));
  await check("tenant_qualified_contact_fk_rejects_foreign_reference", () => expectSqlFailure(admin, null, "insert into leads(workspace_id,project_id,contact_id,type,buyer_profile) values($1,$2,$3,'Käufer','{}')", [ids.workspace, ids.project, ids.foreignContact], ["23503"]));
  for (const [table, id] of [["contacts", ids.contact], ["tasks", ids.task], ["projects", ids.project]]) {
    await check("monotone_version_and_stale_cas_" + table, () => transaction(runtime, agent, async client => {
      const initial = (await client.query("select version::text as version from public." + identifier(table) + " where id=$1", [id])).rows[0].version;
      const update = await client.query("update public." + identifier(table) + " set updated_at=updated_at where id=$1 and version=$2 returning version::text as version", [id, initial]);
      assert.equal(update.rowCount, 1);
      assert.equal(BigInt(update.rows[0].version), BigInt(initial) + 1n);
      assert.equal((await client.query("update public." + identifier(table) + " set updated_at=updated_at where id=$1 and version=$2", [id, initial])).rowCount, 0);
    }));
  }
  for (const table of ["audit_logs", "crm_command_receipts", "crm_domain_events"]) {
    for (const operation of ["update", "delete", "truncate"]) {
      const statement = operation === "update" ? "update public." + identifier(table) + " set " + (table === "audit_logs" ? "action=action" : table === "crm_command_receipts" ? "operation=operation" : "event_type=event_type") : operation === "delete" ? "delete from public." + identifier(table) : "truncate public." + identifier(table) + " cascade";
      await check("runtime_immutable_" + table + "_" + operation, () => expectSqlFailure(runtime, owner, statement, [], ["42501", "55000"]));
      await check("owner_trigger_immutable_" + table + "_" + operation, () => expectSqlFailure(admin, null, statement, [], ["42501", "55000"]));
    }
  }
  await check("requested_reservation_remains_unconfirmed_and_unit_available", () => transaction(runtime, agent, async client => {
    const row = (await client.query("insert into property_reservations(workspace_id,project_id,unit_id,contact_id,buyer_lead_id,status,expires_at) values($1,$2,$3,$4,$5,'requested','2030-01-01T00:00:00Z') returning status,confirmation", [ids.workspace, ids.project, ids.unit, ids.contact, ids.lead])).rows[0];
    assert.deepEqual(row, { status: "requested", confirmation: null });
    assert.equal((await client.query("select status from property_units where id=$1", [ids.unit])).rows[0].status, "available");
  }));
  await check("reservation_invalid_status_rejected", () => expectSqlFailure(runtime, agent, "insert into property_reservations(workspace_id,project_id,unit_id,contact_id,status,expires_at) values($1,$2,$3,$4,'SYNTHETIC_INVALID','2030-01-01T00:00:00Z')", [ids.workspace, ids.project, ids.unit, ids.contact], ["23514"]));
  const protectedTables = ["projects", "contacts", "leads", "tasks", "property_units", "audit_logs", "crm_command_receipts", "crm_domain_events", "crm_offers", "crm_offer_revisions", "crm_project_sales_authorities", "lead_sales_handovers", "property_sales", "crm_service_principals", "crm_service_resource_bindings", "crm_service_audit_bindings", "crm_synthetic_approval_requests", "crm_synthetic_approval_evidence", "crm_synthetic_approval_effects"];
  protectedTables.push('crm_evelyn_preview_targets', 'crm_evelyn_contract_actions', 'crm_evelyn_contract_revisions',
    'crm_evelyn_contract_approvals', 'crm_evelyn_contract_events', 'crm_evelyn_contract_executions',
    'crm_financial_policy_versions', 'crm_financial_snapshots', 'crm_financial_events');
  await check("080_to_087_protected_relations_enable_and_force_rls", () => transaction(admin, null, async client => {
    const rows = (await client.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relname=any($1::text[])", [protectedTables])).rows;
    assert.equal(rows.length, protectedTables.length);
    assert.ok(rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
  }));
  for (const table of ['crm_financial_policy_versions', 'crm_financial_snapshots', 'crm_financial_events']) {
    for (const operation of ['update', 'delete', 'truncate']) {
      const statement = operation === 'update' ? `update public.${identifier(table)} set workspace_id=workspace_id`
        : operation === 'delete' ? `delete from public.${identifier(table)}` : `truncate public.${identifier(table)} cascade`;
      await check(`runtime_financial_immutable_${table}_${operation}`, () => expectSqlFailure(runtime, owner, statement, [], ['42501', '55000']));
      await check(`owner_financial_immutable_${table}_${operation}`, () => expectSqlFailure(admin, null, statement, [], ['42501', '55000']));
    }
  }
  await check("runtime_has_no_migration_ledger_or_execution_receipt_rights", () => transaction(runtime, null, async client => {
    const tables = (await client.query("select relname from pg_class where relnamespace='public'::regnamespace and relkind in('r','p') and relname in('novalure_schema_migrations','novalure_migration_execution_receipts') order by relname")).rows;
    assert.equal(tables.length, 2, "Migration execution metadata table must be present");
    for (const { relname } of tables) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        assert.equal((await client.query("select has_table_privilege(current_user,$1,$2) as allowed", ['public.' + identifier(relname), privilege])).rows[0].allowed, false);
      }
    }
  }));
  for (const operation of ["update", "delete", "truncate"]) {
    const statement = operation === "update" ? "update public.novalure_migration_execution_receipts set source_checksum=source_checksum" : operation === "delete" ? "delete from public.novalure_migration_execution_receipts" : "truncate public.novalure_migration_execution_receipts";
    await check("runtime_migration_receipt_immutable_" + operation, () => expectSqlFailure(runtime, owner, statement, [], ["42501", "55000"]));
    await check("owner_migration_receipt_immutable_" + operation, () => expectSqlFailure(admin, null, statement, [], ["42501", "55000"]));
  }
  return { status: "PASS", syntheticOnly: true, databaseFakes: 0, checks, counts: { passed: checks.length, failed: 0, skipped: 0 }, limitations: ["SQL boundary checks are not provider or application-route approval evidence.", "Requested reservation check proves stored SQL state only; authorized confirmation remains covered by the separate business-flow suite.", "All security mutation probes roll back; sequence allocation, if any, is not a business mutation."] };
}

/** OID-free, stable catalog and complete data digests. No row payload is returned. */
export async function snapshotG27(admin) {
  return transaction(admin, null, async client => {
    const catalog = {};
    const queries = {
      extensions: "select e.extname,e.extversion,n.nspname as schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by e.extname",
      tables: "select c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,r.rolname as owner,c.reloptions,pg_get_partkeydef(c.oid) as partition_key from pg_class c join pg_roles r on r.oid=c.relowner where c.relnamespace='public'::regnamespace and c.relkind in('r','p','v','m','S','f') order by c.relname",
      columns: "select c.relname,(row_number() over(partition by c.relname order by a.attnum))::int as ordinal_position,a.attname,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) as default_expression,case when a.attcollation=0 then null else cn.nspname||'.'||co.collname end as collation from pg_attribute a join pg_class c on c.oid=a.attrelid left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum left join pg_collation co on co.oid=a.attcollation left join pg_namespace cn on cn.oid=co.collnamespace where c.relnamespace='public'::regnamespace and c.relkind in('r','p','v','m','f') and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum",
      constraints: "select c.conname,coalesce(r.relname,'') as relation,c.contype,c.convalidated,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid,false) as definition from pg_constraint c left join pg_class r on r.oid=c.conrelid where c.connamespace='public'::regnamespace order by relation,c.conname",
      indexes: "select t.relname as relation,i.relname as name,x.indisunique,x.indisprimary,x.indisvalid,x.indisready,x.indimmediate,x.indnullsnotdistinct,pg_get_indexdef(i.oid) as definition from pg_index x join pg_class i on i.oid=x.indexrelid join pg_class t on t.oid=x.indrelid where t.relnamespace='public'::regnamespace order by t.relname,i.relname",
      policies: "select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname",
      functions: "select p.proname,pg_get_function_identity_arguments(p.oid) as arguments,r.rolname as owner,p.prosecdef,p.proleakproof,p.provolatile,p.proparallel,p.proconfig,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_roles r on r.oid=p.proowner where p.pronamespace='public'::regnamespace and p.prokind in('f','p') order by p.proname,arguments",
      triggers: "select c.relname as relation,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,false) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal order by c.relname,t.tgname",
      views: "select c.relname,pg_get_viewdef(c.oid,false) as definition from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in('v','m') order by c.relname",
      roles: "select rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit,rolconfig from pg_roles where rolname !~ '^pg_' order by rolname",
      memberships: "select parent.rolname as parent,member.rolname as member,grantor.rolname as grantor,m.admin_option,m.inherit_option,m.set_option from pg_auth_members m join pg_roles parent on parent.oid=m.roleid join pg_roles member on member.oid=m.member join pg_roles grantor on grantor.oid=m.grantor order by parent.rolname,member.rolname,grantor.rolname",
      relationGrants: "select c.relname,case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,grantor.rolname as grantor,a.privilege_type,a.is_grantable from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 'S'::\"char\" else 'r'::\"char\" end,c.relowner))) a left join pg_roles grantee on grantee.oid=a.grantee join pg_roles grantor on grantor.oid=a.grantor where c.relnamespace='public'::regnamespace and c.relkind in('r','p','v','m','S','f') order by c.relname,grantee,grantor,a.privilege_type",
      columnGrants: "select c.relname,col.attname,case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,grantor.rolname as grantor,a.privilege_type,a.is_grantable from pg_attribute col join pg_class c on c.oid=col.attrelid cross join lateral aclexplode(col.attacl) a left join pg_roles grantee on grantee.oid=a.grantee join pg_roles grantor on grantor.oid=a.grantor where c.relnamespace='public'::regnamespace and col.attnum>0 and not col.attisdropped order by c.relname,col.attname,grantee,grantor,a.privilege_type",
      functionGrants: "select p.proname,pg_get_function_identity_arguments(p.oid) as arguments,case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,grantor.rolname as grantor,a.privilege_type,a.is_grantable from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a left join pg_roles grantee on grantee.oid=a.grantee join pg_roles grantor on grantor.oid=a.grantor where p.pronamespace='public'::regnamespace order by p.proname,arguments,grantee,grantor,a.privilege_type",
      schemaGrants: "select n.nspname,owner.rolname as owner,case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,grantor.rolname as grantor,a.privilege_type,a.is_grantable from pg_namespace n join pg_roles owner on owner.oid=n.nspowner cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a left join pg_roles grantee on grantee.oid=a.grantee join pg_roles grantor on grantor.oid=a.grantor where n.nspname='public' order by grantee,grantor,a.privilege_type",
      defaultGrants: "select owner.rolname as owner,coalesce(n.nspname,'ALL_SCHEMAS') as schema,d.defaclobjtype,case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,grantor.rolname as grantor,a.privilege_type,a.is_grantable from pg_default_acl d join pg_roles owner on owner.oid=d.defaclrole left join pg_namespace n on n.oid=d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a left join pg_roles grantee on grantee.oid=a.grantee join pg_roles grantor on grantor.oid=a.grantor where d.defaclnamespace=0 or n.nspname='public' order by owner.rolname,schema,d.defaclobjtype,grantee,grantor,a.privilege_type",
      sequences: "select sequencename,sequenceowner,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value from pg_sequences where schemaname='public' order by sequencename",
    };
    for (const [name, sql] of Object.entries(queries)) catalog[name] = (await client.query(sql)).rows;
    // Role settings are compared without returning possible pre-existing secret values.
    for (const role of catalog.roles) if (role.rolconfig) role.rolconfig = role.rolconfig.map(setting => ({ name: setting.split("=", 1)[0], sha256: hash(setting) })).sort((a, b) => a.name.localeCompare(b.name));
    assert.ok(catalog.extensions.some(extension => extension.extname === "vector"), "Actual pgvector extension must be present; no substitution accepted");
    const ledger = (await client.query("select version,name,checksum from novalure_schema_migrations order by version")).rows;
    const data = [];
    for (const table of catalog.tables.filter(table => ["r", "p", "m"].includes(table.relkind))) {
      const rows = (await client.query("select to_jsonb(t)::text as canonical from public." + identifier(table.relname) + " t order by (to_jsonb(t)::text) collate \"C\"")).rows;
      const digest = createHash("sha256");
      for (const row of rows) digest.update(row.canonical + "\n");
      data.push({ table: table.relname, rows: rows.length, sha256: digest.digest("hex") });
    }
    const counts = { tables: catalog.tables.length, columns: catalog.columns.length, constraints: catalog.constraints.length, foreignKeys: catalog.constraints.filter(row => row.contype === "f").length, indexes: catalog.indexes.length, policies: catalog.policies.length, functions: catalog.functions.length, triggers: catalog.triggers.length, ledgerRows: ledger.length, dataTables: data.length, dataRows: data.reduce((sum, table) => sum + table.rows, 0) };
    const snapshot = { format: "g27-qa-snapshot-v1", catalog, ledger, data, counts };
    return { ...snapshot, hash: hash(canonical(snapshot)) };
  }, { readOnly: true });
}
