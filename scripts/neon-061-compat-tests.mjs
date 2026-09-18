import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { startLocalSalesDb } from './lib/local-sales-db.mjs';
import { applyNeon061Compatibility, renderNeon061Compatibility, neon061SourceChecksum, neon061QaTarget } from './lib/neon-061-compat.mjs';
const source = await readFile(new URL('../migrations/061_validate_and_activate_tenant_rls_pilot.sql', import.meta.url), 'utf8');
const preparation = await readFile(new URL('../migrations/060_tenant_rls_pilot_prepare.sql', import.meta.url), 'utf8');
const sha = value => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
const pilot = ['audit_logs','contacts','deals','leads','projects'];

test('G24 rendering changes only the two exact creator-edge predicates and pins historical bytes', () => {
  assert.equal(sha(source),neon061SourceChecksum);
  const prepared=renderNeon061Compatibility(source);
  assert.notEqual(prepared.executedSqlChecksum,prepared.sourceChecksum);
  assert.equal(renderNeon061Compatibility(source.replace(/\r?\n/g,'\r\n')).executedSqlChecksum,prepared.executedSqlChecksum);
  assert.throws(()=>renderNeon061Compatibility(source+'\n'),/checksum mismatch/);
  assert.equal((prepared.executedSql.match(/and not \(\n        membership.member/g)||[]).length,2);
  const suffix=source.slice(source.indexOf('-- Separate validation')).replace(/\r\n/g,'\n');
  assert.equal(prepared.executedSql.slice(prepared.executedSql.indexOf('-- Separate validation')),suffix);
  assert.equal((prepared.executedSql.match(/validate constraint/g)||[]).length,15);
  assert.equal((prepared.executedSql.match(/force row level security/g)||[]).length,5);
  assert.doesNotMatch(prepared.executedSql,/alter role|revoke[^;]+from neondb_owner/i);
});

test('G24 actual local PostgreSQL provider-edge emulation preserves every 061 invariant', {timeout:240000}, async t=>{
 const db=await startLocalSalesDb(),suffix=randomUUID().replaceAll('-','').slice(0,8),owner='g24_owner_'+suffix,provider='qa_admin';
 let client;
 try{
  await db.admin.query(`create role ${owner} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; create role novalure_tenant_app nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; alter database postgres owner to ${owner};`);
  // Provider emulation is confined to this self-owned disposable cluster. Module never issues these statements.
  const control=await db.admin.connect();try{await control.query(`set role ${provider}; grant novalure_tenant_app to ${owner} with admin true,inherit false,set false; reset role;`)}finally{control.release()}
  await db.admin.query(`grant novalure_tenant_app to ${db.role} with inherit true,set true,admin false; comment on role novalure_tenant_app is 'novalure-tenant-cutover:synthetic-g24-qa';`);
  client=new pg.Client({host:'127.0.0.1',port:db.port,user:owner,database:'postgres'});await client.connect();
  await client.query(`
   create table workspace_users(id uuid primary key,workspace_id uuid not null);
   create table projects(id uuid primary key,workspace_id uuid not null);
   create table organizations(id uuid primary key,workspace_id uuid not null);
   create table contacts(id uuid primary key,workspace_id uuid not null,project_id uuid,organization_id uuid,owner_user_id uuid,archived_by_user_id uuid);
   create table leads(id uuid primary key,workspace_id uuid not null,project_id uuid,contact_id uuid,assigned_to_user_id uuid);
   create table deals(id uuid primary key,workspace_id uuid not null,project_id uuid,contact_id uuid,organization_id uuid,owner_user_id uuid,lead_id uuid);
   create table audit_logs(id uuid primary key,workspace_id uuid not null,actor_user_id uuid,project_id uuid,deal_id uuid);
   create table novalure_schema_migrations(version text primary key,name text not null,checksum text not null,applied_at timestamptz not null default now());
  `);
  await client.query(preparation);
  await client.query("insert into novalure_schema_migrations(version,name,checksum) values('060_tenant_rls_pilot_prepare','060_tenant_rls_pilot_prepare.sql',$1)",[sha(preparation)]);
  const target={projectId:'local-disposable',branchId:'local-disposable',databaseName:'postgres',runtimeRole:db.role};
  const localTest={profile:'disposable-loopback-postgresql',directory:db.directory,ownerRole:owner,grantorRole:provider};
  const executionContext={headCommit:'a'.repeat(40),planDigest:'b'.repeat(64)}; // Explicit synthetic runner identities, not a real remote execution claim.
  const apply=(overrides={})=>applyNeon061Compatibility({client,sql:source,target,localTest,executionContext,...overrides});
  const catalog=async()=>JSON.stringify((await client.query("select relname,relrowsecurity,relforcerowsecurity,relacl::text from pg_class where relnamespace='public'::regnamespace order by relname")).rows);
  async function rolledBack(fn){await client.query('begin');try{return await fn()}finally{await client.query('rollback')}}
  async function deny(pattern,overrides={}){const before=await catalog();await rolledBack(()=>assert.rejects(apply(overrides),pattern));assert.equal(await catalog(),before);assert.equal((await client.query("select to_regclass('public.novalure_migration_execution_receipts') as relation")).rows[0].relation,null)}
  await t.test('original historical SQL rejects the known provider creator edge',async()=>{
   await rolledBack(()=>assert.rejects(client.query(source),/unsafe or non-LOGIN direct member/));
   const edge=(await client.query("select m.admin_option,m.inherit_option,m.set_option,pg_has_role(m.member,m.roleid,'USAGE') as usage,pg_has_role(m.member,m.roleid,'SET') as set from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname=$1 and m.roleid='novalure_tenant_app'::regrole",[owner])).rows[0];
   assert.deepEqual(edge,{admin_option:true,inherit_option:false,set_option:false,usage:false,set:false});
  });
  await t.test('caller transaction, exact source, predecessor and remote fingerprints are mandatory',async()=>{
   await assert.rejects(apply(),/transaction blocks/);
   await deny(/checksum mismatch/,{sql:source+'\n'});
   await deny(/runner commit and plan digest/,{executionContext:undefined});
   await deny(/runner commit and plan digest/,{executionContext:{headCommit:'bad',planDigest:'b'.repeat(64)}});
   await deny(/database or session identity mismatch|pinned Neon QA fingerprint/,{localTest:undefined,target:{...neon061QaTarget}});
   await deny(/local profile requires/,{target:{...target,projectId:'not-local'}});
   await deny(/local cluster is outside/,{localTest:{...localTest,directory:'.npm-cache/qa'}});
   await rolledBack(async()=>{await client.query("update novalure_schema_migrations set checksum='bad'");await assert.rejects(apply(),/checksummed 060/) });
  });
  await t.test('valid exception executes all fifteen validations and five FORCE RLS changes without role mutations',async()=>{
   const memberships=JSON.stringify((await db.admin.query('select * from pg_auth_members order by roleid,member,grantor')).rows);
   await rolledBack(async()=>{const result=await apply();assert.equal(result.sourceChecksum,neon061SourceChecksum);assert.notEqual(result.sourceChecksum,result.executedSqlChecksum);assert.equal(result.evidence.foreignKeysValidated.length,15);assert.deepEqual(result.evidence.forcedRlsTables,pilot);assert.equal(result.profileId,'local-test:neon-provider-creator-admin-only-061-v1');
    const row=(await client.query('select * from novalure_migration_execution_receipts')).rows[0];assert.equal(row.source_checksum,result.sourceChecksum);assert.equal(row.executed_sql_checksum,result.executedSqlChecksum);assert.equal(row.executed_by,owner);assert.deepEqual(row.catalog_evidence.executionContext,executionContext);
    for(const table of pilot){const relation=(await client.query('select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass',[table])).rows[0];assert.deepEqual(relation,{relrowsecurity:true,relforcerowsecurity:true});}
   });assert.equal(JSON.stringify((await db.admin.query('select * from pg_auth_members order by roleid,member,grantor')).rows),memberships);
  });
  await t.test('creator INHERIT, SET, wrong grantor and other admin-only direct members fail closed',async()=>{
   for(const option of ['inherit true','set true']){await db.admin.query(`grant novalure_tenant_app to ${owner} with ${option} granted by ${provider}`);try{await deny(/creator edge/)}finally{await db.admin.query(`grant novalure_tenant_app to ${owner} with inherit false,set false granted by ${provider}`)}}
   await deny(/local synthetic creator.*grantor identity mismatch/,{localTest:{...localTest,grantorRole:'wrong_grantor'}});
   const other='g24_other_'+suffix;await db.admin.query(`create role ${other} nologin; grant novalure_tenant_app to ${other} with admin true,inherit false,set false`);try{await deny(/unsafe additional/)}finally{await db.admin.query(`revoke novalure_tenant_app from ${other}`)}
  });
  await t.test('runtime high attributes, owner status, ADMIN and indirect privileged paths are rejected',async()=>{
   await db.admin.query(`alter role ${db.role} bypassrls`);try{await deny(/safe non-owner/)}finally{await db.admin.query(`alter role ${db.role} nobypassrls`)}
   await db.admin.query(`grant novalure_tenant_app to ${db.role} with admin true`);try{await deny(/unsafe additional|ADMIN/)}finally{await db.admin.query(`grant novalure_tenant_app to ${db.role} with admin false`)}
   const bridge='g24_bridge_'+suffix;await db.admin.query(`create role ${bridge} nologin; grant ${owner} to ${bridge} with inherit false,set false,admin true; grant ${bridge} to ${db.role} with inherit false,set true`);try{await deny(/ADMIN|privileged/)}finally{await db.admin.query(`revoke ${bridge} from ${db.role}`)}
   await db.admin.query(`alter table public.projects owner to ${db.role}`);try{await deny(/creator must own|safe non-owner/)}finally{await db.admin.query(`alter table public.projects owner to ${owner}`)}
  });
  await t.test('additional safe-looking LOGIN with inherited owner privileges is not an exempt creator',async()=>{
   const hidden='g24_hidden_'+suffix;await db.admin.query(`create role ${hidden} login inherit; grant novalure_tenant_app to ${hidden} with admin false,inherit true,set true; grant ${owner} to ${hidden} with admin false,inherit true,set true`);
   try{await deny(/runtime can reach a privileged|reachable ADMIN path/)}finally{await db.admin.query(`revoke novalure_tenant_app from ${hidden}; revoke ${owner} from ${hidden}`)}
  });
  await t.test('original cutover, policy, append-only and bad legacy FK guards still refuse activation',async()=>{
   await db.admin.query("comment on role novalure_tenant_app is null");try{await deny(/role comment/)}finally{await db.admin.query("comment on role novalure_tenant_app is 'novalure-tenant-cutover:synthetic-g24-qa'")}
   await rolledBack(async()=>{await client.query('drop policy contacts_tenant_actor_policy on contacts');await assert.rejects(apply(),/all six tenant pilot policies/)});
   await rolledBack(async()=>{await client.query('alter table audit_logs disable trigger audit_logs_append_only_guard');await assert.rejects(apply(),/append-only guard/)});
   await db.admin.query('alter table contacts disable trigger all');await db.admin.query('insert into contacts(id,workspace_id,project_id) values($1,$2,$3)',[randomUUID(),randomUUID(),randomUUID()]);await db.admin.query('alter table contacts enable trigger all');
   try{await deny(/foreign key constraint/)}finally{await db.admin.query('delete from contacts')}
  });
  await t.test('ledger failure rolls back execution receipt, grants and activation atomically',async()=>{
   const before=await catalog();await rolledBack(async()=>{await apply();await assert.rejects(client.query("insert into novalure_schema_migrations(version,name,checksum) values('060_tenant_rls_pilot_prepare','deliberate duplicate',$1)",[neon061SourceChecksum]),/duplicate key/)});assert.equal(await catalog(),before);
   assert.equal((await client.query("select to_regclass('public.novalure_migration_execution_receipts') as relation")).rows[0].relation,null);
  });
  await t.test('committed receipt is immutable and runtime-scoped data remains protected; rerun is denied',async()=>{
   await client.query('begin');const receipt=await apply();await client.query("insert into novalure_schema_migrations(version,name,checksum) values('061_validate_and_activate_tenant_rls_pilot','061_validate_and_activate_tenant_rls_pilot.sql',$1)",[receipt.sourceChecksum]);await client.query('commit');
   for(const command of ["update novalure_migration_execution_receipts set profile_id='changed'",'delete from novalure_migration_execution_receipts','truncate novalure_migration_execution_receipts'])await assert.rejects(client.query(command),error=>error.code==='55000' && /append-only/.test(error.message));
   await rolledBack(()=>assert.rejects(apply(),/061 already applied/));
   const workspace=randomUUID(),foreign=randomUUID(),actor=randomUUID();await db.admin.query('insert into projects(id,workspace_id) values($1,$2),($3,$4)',[randomUUID(),workspace,randomUUID(),foreign]);
   const runtime=await db.pool.connect();try{assert.equal((await runtime.query('select * from projects')).rows.length,0);await runtime.query('begin');await runtime.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",[workspace,actor]);assert.equal((await runtime.query('select * from projects')).rows.length,1);await runtime.query('rollback');await assert.rejects(runtime.query('select * from novalure_migration_execution_receipts'),/permission denied/);await assert.rejects(runtime.query('truncate novalure_migration_execution_receipts'),/permission denied/);await assert.rejects(runtime.query(`set role ${owner}`),/permission denied/)}finally{runtime.release()}
   assert.equal((await client.query("select checksum from novalure_schema_migrations where version='061_validate_and_activate_tenant_rls_pilot'")).rows[0].checksum,neon061SourceChecksum);
  });
 }finally{await client?.end();await db.stop()}
});
