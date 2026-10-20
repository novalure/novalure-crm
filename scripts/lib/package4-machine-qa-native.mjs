/** One-shot trusted augmentation of the already seeded, isolated package4 QA DB.
 * No connection, credential, environment read or provider request is made here.
 * Callers supply one connected transaction-capable owner client, never a pool.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const knowledgeQaTarget = Object.freeze({
  projectId: "green-thunder-49879900", branchId: "br-sweet-surf-ba6iahut",
  host: "ep-crimson-forest-ba4kk6sb.c-8.eu-central-1.aws.neon.tech",
  databaseName: "neondb", owner: "neondb_owner",
});
export const knowledgeQaIdentity = Object.freeze({
  identityId: "EVELYN_CRM_KNOWLEDGE_QA_IDENTITY", authType: "VERCEL_OIDC_QA",
  environment: "preview", role: "Evelyn.QA", consumer: "EVELYN",
  issuer: "https://oidc.vercel.com/novalure",
  projectId: "prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I", ownerId: "team_sjD78IkSicXJK6TAOR1JC7Wv",
  subject: "owner:novalure:project:evelyn:environment:preview",
});
const recipientProjectId = "prj_R32Okl6AHijTohvuKmryuTLjWMsk";
const marker = "package4-hosted-20261020-v1";
const signature = "text,text,text,text,text,text,uuid,text,text";
const readerName = "crm_authenticate_knowledge_qa_machine";
const constraintNames = ["crm_service_principals_environment_check", "crm_service_principals_auth_type_check", "crm_service_principals_auth_model_check"];
const preservedFunctionNames = ["crm_authenticate_machine", "crm_machine_action_allowed", "crm_claim_machine_request", "knowledge_lock_assistant_service_binding"];
const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const uuid = value => {
  assert.match(value ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, "Canonical UUID required");
  return value;
};
const lit = value => "'" + String(value).replaceAll("'", "''") + "'";
export const knowledgeQaAudience = workspaceId => `urn:novalure:crm:knowledge-qa:${recipientProjectId}:${uuid(workspaceId)}`;

function pinnedIds({ workspaceId, actorUserId, principalId }) {
  const ids = { workspaceId: uuid(workspaceId), actorUserId: uuid(actorUserId), principalId: uuid(principalId) };
  assert.equal(new Set(Object.values(ids)).size, 3, "Separate workspace, actor and principal IDs required");
  assert.notEqual(ids.workspaceId, "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101", "The internal Production fixture cannot be a QA customer workspace");
  return ids;
}

function qaPredicate(ids, prefix = "") {
  const c = name => prefix + name;
  const i = knowledgeQaIdentity;
  return [
    `${c("id")}=${lit(ids.principalId)}::uuid`, `${c("workspace_id")}=${lit(ids.workspaceId)}::uuid`,
    `${c("actor_user_id")}=${lit(ids.actorUserId)}::uuid`, `${c("tenant_alias")}=${lit(ids.workspaceId)}`,
    `${c("identity_id")}=${lit(i.identityId)}`, `${c("service_subject")}=${lit(i.subject)}`,
    `${c("auth_type")}=${lit(i.authType)}`, `${c("environment")}=${lit(i.environment)}`,
    `${c("service_role")}=${lit(i.role)}`, `${c("consumer")}=${lit(i.consumer)}`,
    `${c("issuer")}=${lit(i.issuer)}`, `${c("audience")}=${lit(knowledgeQaAudience(ids.workspaceId))}`,
    `${c("oidc_project_id")}=${lit(i.projectId)}`, `${c("oidc_owner_id")}=${lit(i.ownerId)}`,
    `${c("agent_id")}='evelyn'`, `${c("synthetic")} is true`, `${c("token_hash")} is null`,
    `${c("data_context")}='CUSTOMER_TENANT'`, `${c("data_classification")}='CONFIDENTIAL'`,
    `${c("purpose")}='OPERATIONS'`, `${c("scopes")}=array['crm.projects.read']::text[]`,
    `${c("expires_at")}<=${c("not_before")}+interval '1 hour'`,
  ].join(" and ");
}

const identityQuery = `select current_setting('neon.project_id',true) as project,
  current_setting('neon.branch_id',true) as branch,current_database() as database,
  current_user as role,session_user as session_role,pg_backend_pid() as backend,
  (select pg_get_userbyid(datdba) from pg_database where datname=current_database()) as database_owner`;

function sqlTargetGuard() {
  return `do $qa_target$ begin
    if current_setting('neon.project_id',true) is distinct from ${lit(knowledgeQaTarget.projectId)}
      or current_setting('neon.branch_id',true) is distinct from ${lit(knowledgeQaTarget.branchId)}
      or current_database() is distinct from 'neondb' or current_user is distinct from 'neondb_owner'
      or session_user is distinct from 'neondb_owner'
      or (select pg_get_userbyid(datdba) from pg_database where datname=current_database()) is distinct from 'neondb_owner'
    then raise exception using errcode='55000',message='Exact isolated package4 owner target required'; end if;
  end $qa_target$;`;
}

/** DDL only. Original predicates are inspected, checked against unchanged092,
 * and embedded verbatim as the old alternative. A drifted baseline is rejected.
 * Execute atomically through augmentKnowledgeQa, not as a generic migration.
 */
export function buildKnowledgeQaBootstrapSql(input) {
  const ids = pinnedIds(input), i = knowledgeQaIdentity;
  const qa = qaPredicate(ids);
  return `${sqlTargetGuard()}
create temporary table package4_qa_constraint_reference (like public.crm_service_principals) on commit drop;
alter table pg_temp.package4_qa_constraint_reference
 add constraint crm_service_principals_environment_check check(environment in ('simulation','production')),
 add constraint crm_service_principals_auth_type_check check(auth_type in ('STATIC_HASH_QA','VERCEL_OIDC')),
 add constraint crm_service_principals_auth_model_check check(
  (auth_type='STATIC_HASH_QA' and token_hash is not null and environment='simulation' and service_role='Evelyn.QA')
  or (auth_type='VERCEL_OIDC' and token_hash is null and environment='production' and service_role='Evelyn.Service'
   and issuer is not null and audience is not null and oidc_project_id is not null and oidc_owner_id is not null));
do $qa_constraints$
declare constraint_name text; old_expression text; expected_expression text; valid boolean;
begin
 foreach constraint_name in array array[${constraintNames.map(lit).join(",")}] loop
  select pg_get_expr(c.conbin,c.conrelid),c.convalidated into old_expression,valid
   from pg_constraint c where c.conrelid='public.crm_service_principals'::regclass
    and c.conname=constraint_name and c.contype='c';
  select pg_get_expr(c.conbin,c.conrelid) into expected_expression from pg_constraint c
   where c.conrelid='pg_temp.package4_qa_constraint_reference'::regclass and c.conname=constraint_name;
  if valid is distinct from true or old_expression is distinct from expected_expression then
   raise exception using errcode='55000',message='Unchanged092 machine constraint baseline required: '||constraint_name;
  end if;
  execute format('alter table public.crm_service_principals drop constraint %I, add constraint %I check ((%s) or coalesce((%s),false))',
   constraint_name,constraint_name,old_expression,${lit(qa)});
 end loop;
end $qa_constraints$;
drop table pg_temp.package4_qa_constraint_reference;
create function public.${readerName}(p_identity_id text,p_subject text,p_issuer text,p_audience text,p_project_id text,p_owner_id text,p_workspace uuid,p_environment text,p_role text)
returns table(id uuid,workspace_id uuid,actor_user_id uuid,tenant_alias text,agent_id text,scopes text[],data_context text,data_classification text,purpose text,identity_id text,service_subject text,consumer text,service_role text,environment text,auth_type text,issuer text,audience text)
language plpgsql volatile security definer set search_path=pg_catalog,public as $qa_reader$
declare previous_tenant text:=current_setting('app.tenant_id',true); previous_actor text:=current_setting('app.actor_id',true);
begin
 if p_identity_id is distinct from ${lit(i.identityId)} or p_subject is distinct from ${lit(i.subject)}
  or p_issuer is distinct from ${lit(i.issuer)} or p_audience is distinct from ${lit(knowledgeQaAudience(ids.workspaceId))}
  or p_project_id is distinct from ${lit(i.projectId)} or p_owner_id is distinct from ${lit(i.ownerId)}
  or p_workspace is distinct from ${lit(ids.workspaceId)}::uuid or p_environment is distinct from 'preview'
  or p_role is distinct from 'Evelyn.QA' then return; end if;
 perform set_config('app.tenant_id',${lit(ids.workspaceId)},true),set_config('app.actor_id',${lit(ids.actorUserId)},true);
 begin
  return query select p.id,p.workspace_id,p.actor_user_id,p.tenant_alias,p.agent_id,p.scopes,p.data_context,p.data_classification,p.purpose,p.identity_id,p.service_subject,p.consumer,p.service_role,p.environment,p.auth_type,p.issuer,p.audience
   from public.crm_service_principals p
   join public.workspace_users member on member.id=p.actor_user_id and member.workspace_id=p.workspace_id
   join public.workspaces workspace on workspace.id=p.workspace_id
   where ${qaPredicate(ids, "p.")}
    and p.state='ACTIVE' and not p.kill_switch_active and p.revoked_at is null
    and p.not_before<=clock_timestamp() and p.expires_at>clock_timestamp()
    and member.status='active' and member.role='agent' and member.product_role='project_sales_member'
    and workspace.setup_state->>'syntheticQa'='true' and workspace.setup_state->>'package4HostedSeed'=${lit(marker)}
    and workspace.name like 'SYNTHETIC PACKAGE4%'
    and workspace.operating_model in ('self_service_customer','managed_by_novalure','hybrid')
    and workspace.customer_type='property_developer';
 exception when others then
  perform set_config('app.tenant_id',coalesce(previous_tenant,''),true),set_config('app.actor_id',coalesce(previous_actor,''),true);
  raise;
 end;
 perform set_config('app.tenant_id',coalesce(previous_tenant,''),true),set_config('app.actor_id',coalesce(previous_actor,''),true);
end $qa_reader$;
revoke all on function public.${readerName}(${signature}) from public,novalure_app;
grant execute on function public.${readerName}(${signature}) to novalure_tenant_app;
`;
}

/** Fixture rows remain separate from DDL and cannot be reached by a customer route. */
export function buildKnowledgeQaFixtureSql(input) {
  const ids = pinnedIds(input), botId = uuid(input.botId), i = knowledgeQaIdentity;
  return `${sqlTargetGuard()}
select set_config('app.tenant_id',${lit(ids.workspaceId)},true),set_config('app.actor_id',${lit(ids.actorUserId)},true);
do $qa_metadata_policies$ declare bound_project uuid; begin
 execute format('create policy package4_qa_bot_select on public.bots for select to %I using (%s)',current_user,
  ${lit(`id=${lit(botId)}::uuid and workspace_id=${lit(ids.workspaceId)}::uuid`)});
 select b.project_id into strict bound_project from public.bots b where b.id=${lit(botId)}::uuid and b.workspace_id=${lit(ids.workspaceId)}::uuid;
 if bound_project is null then raise exception using errcode='55000',message='Existing exact QA bot project required'; end if;
 execute format('create policy package4_qa_project_select on public.projects for select to %I using (id=%L::uuid and workspace_id=%L::uuid)',
  current_user,bound_project,${lit(ids.workspaceId)});
end $qa_metadata_policies$;
do $qa_fixture_guard$ begin
 if not exists(select 1 from public.workspaces w where w.id=${lit(ids.workspaceId)}::uuid
  and w.setup_state->>'syntheticQa'='true' and w.setup_state->>'package4HostedSeed'=${lit(marker)}
  and w.name like 'SYNTHETIC PACKAGE4%' and w.customer_type='property_developer'
  and w.operating_model in ('self_service_customer','managed_by_novalure','hybrid'))
 or not exists(select 1 from public.bots b join public.projects p on p.id=b.project_id and p.workspace_id=b.workspace_id
  where b.id=${lit(botId)}::uuid and b.workspace_id=${lit(ids.workspaceId)}::uuid
   and p.name like 'SYNTHETIC PACKAGE4%' and p.data_classification='CUSTOMER_TENANT')
 then raise exception using errcode='55000',message='Native synthetic customer workspace/project/bot required'; end if;
 if exists(select 1 from public.workspace_users where id=${lit(ids.actorUserId)}::uuid)
 then raise exception using errcode='55000',message='New dedicated QA service actor required; existing user cannot be relabeled'; end if;
end $qa_fixture_guard$;
insert into public.workspace_users(id,workspace_id,name,email,role,product_role,status)
 values(${lit(ids.actorUserId)}::uuid,${lit(ids.workspaceId)}::uuid,'SYNTHETIC PACKAGE4 knowledge QA service actor',
 ${lit(`package4-machine-qa-${ids.actorUserId}@service.invalid`)},'agent','project_sales_member','active');
insert into public.project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals)
 select ${lit(ids.workspaceId)}::uuid,b.project_id,${lit(ids.actorUserId)}::uuid,true,false from public.bots b
 where b.id=${lit(botId)}::uuid and b.workspace_id=${lit(ids.workspaceId)}::uuid;
do $qa_insert_policies$ begin
 execute format('create policy package4_qa_principal_insert on public.crm_service_principals for insert to %I with check (%s)',current_user,${lit(qaPredicate(ids))});
 execute format('create policy package4_qa_binding_insert on public.knowledge_assistant_service_bindings for insert to %I with check (%s)',current_user,
 ${lit(`principal_id=${lit(ids.principalId)}::uuid and workspace_id=${lit(ids.workspaceId)}::uuid and bot_id=${lit(botId)}::uuid and channel in ('webchat','voice') and enabled is true and revoked_at is null`)});
end $qa_insert_policies$;
insert into public.crm_service_principals(id,workspace_id,actor_user_id,token_hash,tenant_alias,agent_id,scopes,data_context,data_classification,purpose,environment,synthetic,expires_at,identity_id,service_subject,consumer,service_role,auth_type,issuer,audience,oidc_project_id,oidc_owner_id,state,not_before)
 values(${lit(ids.principalId)}::uuid,${lit(ids.workspaceId)}::uuid,${lit(ids.actorUserId)}::uuid,null,${lit(ids.workspaceId)},'evelyn',array['crm.projects.read']::text[],
 'CUSTOMER_TENANT','CONFIDENTIAL','OPERATIONS','preview',true,statement_timestamp()+interval '1 hour',
 ${lit(i.identityId)},${lit(i.subject)},'EVELYN','Evelyn.QA',${lit(i.authType)},${lit(i.issuer)},${lit(knowledgeQaAudience(ids.workspaceId))},${lit(i.projectId)},${lit(i.ownerId)},'ACTIVE',statement_timestamp());
insert into public.knowledge_assistant_service_bindings(principal_id,workspace_id,bot_id,channel)
 values(${lit(ids.principalId)}::uuid,${lit(ids.workspaceId)}::uuid,${lit(botId)}::uuid,'webchat'),
 (${lit(ids.principalId)}::uuid,${lit(ids.workspaceId)}::uuid,${lit(botId)}::uuid,'voice');
drop policy package4_qa_principal_insert on public.crm_service_principals;
drop policy package4_qa_binding_insert on public.knowledge_assistant_service_bindings;
drop policy package4_qa_bot_select on public.bots;
drop policy package4_qa_project_select on public.projects;
`;
}

function canonicalLedger(rows) {
  assert.ok(Array.isArray(rows) && rows.length === 60, "Full canonical 60-row ledger/checksum manifest required");
  const result = rows.map(({ version, name, checksum }) => {
    assert.match(version ?? "", /^\d{3}_[a-z0-9_]+$/u);
    assert.equal(name, version + ".sql"); assert.match(checksum ?? "", /^[a-f0-9]{64}$/u);
    return { version, name, checksum };
  }).sort((a, b) => a.version.localeCompare(b.version));
  assert.equal(new Set(result.map(row => row.version)).size, 60, "Unique canonical migration versions required");
  assert.deepEqual(result.filter(row => Number(row.version.slice(0, 3)) >= 91).map(row => Number(row.version.slice(0, 3))),
    [91, 92, 93, 94, 95, 96, 100, 101, 102, 103, 104, 105, 106], "Exact accepted 13-migration package4 lineage required");
  return result;
}

async function fingerprint(owner) {
  const row = (await owner.query(identityQuery)).rows[0];
  assert.deepEqual({ ...row, backend: undefined }, { project: knowledgeQaTarget.projectId, branch: knowledgeQaTarget.branchId,
    database: "neondb", role: "neondb_owner", session_role: "neondb_owner", database_owner: "neondb_owner", backend: undefined }, "Exact isolated QA owner fingerprint required");
  return row;
}

async function catalog(owner) {
  const ledger = (await owner.query("select version,name,checksum from public.novalure_schema_migrations order by version")).rows;
  const allFunctions = (await owner.query(`select p.oid::regprocedure::text as signature,p.proname,pg_get_functiondef(p.oid) as definition,
    p.proacl::text as acl,pg_get_userbyid(p.proowner) as owner,
    (select jsonb_agg(jsonb_build_object('grantor',a.grantor::regrole::text,'grantee',case when a.grantee=0 then 'PUBLIC' else a.grantee::regrole::text end,
      'privilege',a.privilege_type,'grantable',a.is_grantable) order by a.grantee,a.privilege_type)
     from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) as effective_acl,
    has_function_privilege('novalure_app',p.oid,'EXECUTE') as runtime_execute,
    has_function_privilege('novalure_tenant_app',p.oid,'EXECUTE') as tenant_role_execute
    from pg_proc p
    where p.pronamespace='public'::regnamespace and p.prokind in ('f','p') order by p.proname,p.oid::regprocedure::text`)).rows;
  const functions = allFunctions.filter(row => preservedFunctionNames.includes(row.proname));
  assert.equal(functions.length, 4, "Four unchanged native machine/binding functions required");
  const policies = (await owner.query("select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname")).rows;
  const relations = (await owner.query(`select relname,relrowsecurity,relforcerowsecurity,relacl::text as acl,pg_get_userbyid(relowner) as owner
    from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p') order by relname`)).rows;
  const triggers = (await owner.query(`select t.tgrelid::regclass::text as relation,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) as definition
    from pg_trigger t where t.tgrelid in(select oid from pg_class where relnamespace='public'::regnamespace) and not t.tgisinternal order by relation,t.tgname`)).rows;
  const constraints = (await owner.query(`select conname,pg_get_expr(conbin,conrelid) as expression,pg_get_constraintdef(oid) as definition,convalidated
    from pg_constraint where conrelid='public.crm_service_principals'::regclass and contype='c' order by conname`)).rows;
  return { ledger, functions, allFunctions, policies, relations, triggers, constraints };
}

/** The caller owns connection establishment and persistence of the safe receipt.
 * Deliberately one-shot: a prior install or any baseline drift aborts atomically.
 * canonicalMigrationChecksums is the complete array of 60 {version,name,checksum}.
 */
export async function augmentKnowledgeQa({ owner, target, workspaceId, actorUserId, principalId, botId, sourceRevision, canonicalMigrationChecksums }) {
  assert.ok(owner && typeof owner.query === "function" && !Number.isInteger(owner.totalCount), "Supply one connected owner client, not a pool");
  assert.equal(target?.projectId, knowledgeQaTarget.projectId); assert.equal(target?.branchId, knowledgeQaTarget.branchId);
  assert.equal(target?.host, knowledgeQaTarget.host, "Exact provider-attested active QA endpoint required");
  assert.equal(target?.databaseName ?? target?.database, "neondb");
  assert.match(sourceRevision ?? "", /^[a-f0-9]{40}$/u, "Exact source revision required");
  const expectedLedger = canonicalLedger(canonicalMigrationChecksums);
  const ids = pinnedIds({ workspaceId, actorUserId, principalId }); uuid(botId);
  const ddl = buildKnowledgeQaBootstrapSql(ids), fixture = buildKnowledgeQaFixtureSql({ ...ids, botId });
  const firstIdentity = await fingerprint(owner);
  let begun = false;
  try {
    await owner.query("begin"); begun = true;
    await owner.query("set local search_path=pg_catalog,public; set local lock_timeout='5s'; set local statement_timeout='30s'");
    assert.equal((await fingerprint(owner)).backend, firstIdentity.backend, "One connected transaction client required");
    await owner.query("select pg_advisory_xact_lock(941408)");
    await owner.query("lock table public.novalure_schema_migrations,public.crm_service_principals,public.knowledge_assistant_service_bindings in share row exclusive mode");
    const before = await catalog(owner);
    assert.deepEqual(before.ledger, expectedLedger, "Every canonical ledger checksum must match before QA augmentation");
    const rlsCount = rows => rows.filter(row => row.relrowsecurity).length;
    const forcedCount = rows => rows.filter(row => row.relrowsecurity && row.relforcerowsecurity).length;
    assert.equal(rlsCount(before.relations), 94, "Exact accepted 94-table RLS baseline required");
    assert.equal(forcedCount(before.relations), 94, "All 94 accepted RLS tables must retain FORCE RLS");
    assert.equal((await owner.query("select to_regprocedure($1) is null as absent", [`public.${readerName}(${signature})`])).rows[0].absent, true, "A prior QA installation must be reconciled, never overwritten");
    await owner.query(ddl);
    await owner.query(fixture);
    const after = await catalog(owner);
    for (const key of ["ledger", "functions", "policies", "relations", "triggers"]) {
      assert.deepEqual(after[key], before[key], `QA augmentation must preserve the existing ${key} catalog`);
    }
    const newSignature = `${readerName}(${signature})`;
    assert.deepEqual(after.allFunctions.filter(row => row.signature !== newSignature), before.allFunctions,
      "Every existing public function definition, owner and effective ACL must remain identical");
    const added = after.allFunctions.filter(row => row.signature === newSignature);
    assert.equal(added.length, 1, "Only the exact new QA reader may enter the public function catalog");
    assert.equal(added[0].owner, "neondb_owner");
    assert.deepEqual(added[0].effective_acl.map(row => row.grantee).sort(), ["neondb_owner", "novalure_tenant_app"]);
    assert.ok(added[0].effective_acl.every(row => row.privilege === "EXECUTE" && !row.grantable));
    for (const row of before.constraints.filter(row => !constraintNames.includes(row.conname))) {
      assert.deepEqual(after.constraints.find(candidate => candidate.conname === row.conname), row, "Unrelated principal constraints must be unchanged");
    }
    const reader = (await owner.query(`select pg_get_functiondef(p.oid) as definition,p.provolatile,p.prosecdef,p.proconfig,p.proacl::text as acl,
      pg_get_userbyid(p.proowner) as owner from pg_proc p where p.oid=$1::regprocedure`, [`public.${readerName}(${signature})`])).rows[0];
    assert.equal(reader.provolatile, "v"); assert.equal(reader.prosecdef, true); assert.equal(reader.owner, "neondb_owner");
    const params = [knowledgeQaIdentity.identityId, knowledgeQaIdentity.subject, knowledgeQaIdentity.issuer, knowledgeQaAudience(workspaceId),
      knowledgeQaIdentity.projectId, knowledgeQaIdentity.ownerId, workspaceId, "preview", "Evelyn.QA"];
    await owner.query("select set_config('app.tenant_id','',true),set_config('app.actor_id','',true)");
    assert.equal((await owner.query(`select * from public.${readerName}($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9)`, params)).rowCount, 1, "Fresh QA metadata must authenticate from an empty initial scope");
    assert.deepEqual((await owner.query("select current_setting('app.tenant_id',true) as tenant,current_setting('app.actor_id',true) as actor")).rows[0], { tenant: "", actor: "" }, "Authentication bootstrap must restore the caller context");
    await owner.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [workspaceId, actorUserId]);
    const bindings = (await owner.query("select principal_id,workspace_id,bot_id,channel,enabled,revoked_at from public.knowledge_assistant_service_bindings where principal_id=$1 order by channel", [principalId])).rows;
    assert.deepEqual(bindings.map(row => row.channel), ["voice", "webchat"]);
    assert.ok(bindings.every(row => row.workspace_id === workspaceId && row.bot_id === botId && row.enabled && row.revoked_at === null));
    const actor = (await owner.query(`select u.id,u.workspace_id,u.role,u.product_role,u.status,u.auth_identity_id,
      a.password_hash is null as no_password,a.mfa_secret_ciphertext is null as no_mfa_secret,a.mfa_enabled_at is null as no_mfa,
      (select count(*)::int from public.auth_sessions s where s.auth_identity_id=u.auth_identity_id) as sessions
      from public.workspace_users u join public.auth_identities a on a.id=u.auth_identity_id where u.id=$1`, [actorUserId])).rows[0];
    assert.equal(actor.role, "agent"); assert.equal(actor.product_role, "project_sales_member");
    assert.equal(actor.no_password && actor.no_mfa_secret && actor.no_mfa, true); assert.equal(actor.sessions, 0);
    const principal = (await owner.query(`select id,workspace_id,actor_user_id,identity_id,auth_type,environment,service_role,
      scopes,token_hash is null as no_static_token,state,not_before,expires_at,revoked_at,kill_switch_active
      from public.crm_service_principals where id=$1`, [principalId])).rows[0];
    assert.equal((await fingerprint(owner)).backend, firstIdentity.backend);
    const receipt = { schema: "package4-machine-qa-native-v1", sourceRevision, target: knowledgeQaTarget, installedAtUtc: new Date().toISOString(),
      workspaceId, principalId, actorUserId, botId, identity: { ...knowledgeQaIdentity, audience: knowledgeQaAudience(workspaceId) },
      ddlSha256: hash(ddl), fixtureSha256: hash(fixture), reader: { name: readerName, sha256: hash(reader.definition), owner: reader.owner, volatility: reader.provolatile, securityDefiner: reader.prosecdef, searchPath: reader.proconfig, acl: reader.acl },
      ledgerBefore: before.ledger, ledgerAfter: after.ledger, ledgerRows: after.ledger.length, package4MigrationCount: 13,
      rlsBefore: { enabled: rlsCount(before.relations), forced: forcedCount(before.relations) },
      rlsAfter: { enabled: rlsCount(after.relations), forced: forcedCount(after.relations) },
      preservedFunctions: before.functions.map(row => ({ signature: row.signature, sha256: hash(row.definition), acl: row.acl, owner: row.owner })),
      preservedFunctionsBefore: before.functions.map(row => ({ ...row, sha256: hash(row.definition), effectiveAclSha256: hash(row.effective_acl) })),
      preservedFunctionsAfter: after.functions.map(row => ({ ...row, sha256: hash(row.definition), effectiveAclSha256: hash(row.effective_acl) })),
      allExistingPublicFunctionsBeforeSha256: hash(before.allFunctions),
      allExistingPublicFunctionsAfterSha256: hash(after.allFunctions.filter(row => row.signature !== newSignature)),
      allExistingPublicFunctionCount: before.allFunctions.length, newReaderEffectiveAcl: added[0].effective_acl,
      constraintsBefore: before.constraints, constraintsAfter: after.constraints,
      policyCatalogBeforeSha256: hash(before.policies), policyCatalogAfterSha256: hash(after.policies),
      relationCatalogSha256: hash(after.relations), triggerCatalogSha256: hash(after.triggers),
      existingFunctionHashesUnchanged: true, oldPredicatesPreservedAndBaselineChecked: true, temporaryInsertPoliciesRemoved: true,
      existingGrantsRlsAndTriggersUnchanged: true, bindings, actor, principal, nativeAuthIdentityCreated: true,
      nativePrincipalLifetimeSeconds: 3600, cleanupRequired: "After the bounded proof disable/revoke both saved bindings and the QA principal, and remove/disable the recipient branch QA flag through the trusted control plane.",
      passwordOrSessionMaterialCreated: false, sessionsCreated: false, providerActivations: false, productionTouched: false };
    await owner.query("commit"); begun = false;
    return receipt;
  } catch (error) {
    if (begun) await owner.query("rollback");
    throw error;
  }
}
