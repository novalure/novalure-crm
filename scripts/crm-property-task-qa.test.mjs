import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { LocalSalesPool, startLocalSalesDb, applySalesSchema } from './lib/local-sales-db.mjs';

// A disposable loopback PostgreSQL cluster; never consumes environment URLs.
let cluster, db, writer, outsider;
let policiesBefore;
const w=randomUUID(), p=randomUUID(), u=randomUUID(), a=randomUUID(), c=randomUUID();
const fw=randomUUID(), fp=randomUUID(), fu=randomUUID(), fa=randomUUID(), fc=randomUUID();
const login=`task_qa_${randomUUID().replaceAll('-','').slice(0,12)}`;
const stranger=`task_qa_${randomUUID().replaceAll('-','').slice(0,12)}`;
const sql='select property_task_qa.create_task($1,$2,$3,$4,$5,$6,$7,$8,$9) as id';
const args=(op=randomUUID()) => [w,p,u,a,c,1,1,1,op];
const invoke=(client, values=args()) => client.query(sql,values);
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));

before(async () => {
  cluster=await startLocalSalesDb();
  await cluster.admin.query('create database property_task_synthetic_qa');
  const admin=new LocalSalesPool({host:'127.0.0.1',port:cluster.port,user:'qa_admin',database:'property_task_synthetic_qa',max:8});
  db={...cluster,admin};
  // Same partial schema caveat as other local CRM suites; no production migration is executed.
  await applySalesSchema(db,{maxMigrationNumber:188});
  await admin.query('create role novalure_property_reader nologin');
  await admin.query(await readFile('migrations/staged/property_observation_grants_candidate.sql','utf8'));
  policiesBefore=(await admin.query("select schemaname,tablename,policyname,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname")).rows;
  await admin.query('create role property_task_qa_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls');
  await admin.query(await readFile('scripts/fixtures/property-task-crm-qa.sql','utf8'));
  for (const role of [login,stranger]) {
    await admin.query(`create role ${role} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
  }
  await admin.query(`grant usage on schema property_task_qa to ${login},${stranger}`);
  await admin.query(`grant execute on function property_task_qa.create_task(uuid,uuid,uuid,uuid,uuid,bigint,bigint,bigint,uuid) to ${login},${stranger}`);
  writer=new LocalSalesPool({host:'127.0.0.1',port:cluster.port,user:login,database:'property_task_synthetic_qa',max:4});
  outsider=new LocalSalesPool({host:'127.0.0.1',port:cluster.port,user:stranger,database:'property_task_synthetic_qa',max:2});
  await admin.query("insert into workspaces(id,name,operating_model,setup_state) values($1,'SYNTHETIC','managed_by_novalure','{}')",[w]);
  await admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC','qa@example.invalid','agent','project_sales_member','active')",[a,w]);
  await admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC','SYNTHETIC')",[p,w]);
  await admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)',[w,p,a]);
  await admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status,data_classification,data_purpose) values($1,$2,$3,'QA','available','CUSTOMER_TENANT','crm_sales')",[u,w,p]);
  await admin.query('insert into property_task_qa.authority values($1,$2,$3,$4,$5,$6,1,1,true,false,true)',[w,p,u,a,login,c]);
  await admin.query("insert into workspaces(id,name,operating_model,setup_state) values($1,'FOREIGN SYNTHETIC','managed_by_novalure','{}')",[fw]);
  await admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'FOREIGN','foreign@example.invalid','agent','project_sales_member','active')",[fa,fw]);
  await admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'FOREIGN','SYNTHETIC')",[fp,fw]);
  await admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)',[fw,fp,fa]);
  await admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status,data_classification,data_purpose) values($1,$2,$3,'FOREIGN','available','CUSTOMER_TENANT','crm_sales')",[fu,fw,fp]);
  await admin.query('insert into property_task_qa.authority values($1,$2,$3,$4,$5,$6,1,1,true,false,true)',[fw,fp,fu,fa,stranger,fc]);
});
after(async () => {
  if(writer) await writer.end();
  if(outsider) await outsider.end();
  if(db) await db.admin.end();
  if(cluster) await cluster.stop();
});

test('task, CRM audit and receipt commit together; exact replay is idempotent',async()=>{
  const input=args();
  const first=(await invoke(writer,input)).rows[0].id;
  assert.equal((await invoke(writer,input)).rows[0].id,first);
  const result=await db.admin.query('select (select count(*) from tasks where id=$1) as tasks,(select count(*) from audit_logs where entity_id=$1 and action=$2) as audits,(select count(*) from property_task_qa.receipts where task_id=$1) as receipts',[first,'PROPERTY_TASK_QA_CREATE']);
  assert.deepEqual(result.rows[0],{tasks:'1',audits:'1',receipts:'1'});
  await assert.rejects(invoke(writer,[...input.slice(0,5),2,...input.slice(6)]),/AUTHORITY_CHANGED/);
});

test('writer has no direct data privileges; principal and scope cannot be forged',async()=>{
  await assert.rejects(writer.query('select * from property_task_qa.authority'),/permission denied/i);
  await assert.rejects(writer.query('select * from property_task_qa.receipts'),/permission denied/i);
  await assert.rejects(writer.query("insert into public.tasks(workspace_id,title) values($1,'x')",[w]),/permission denied/i);
  await assert.rejects(writer.query('update public.tasks set title=$1 where workspace_id=$2',['x',w]),/permission denied/i);
  await assert.rejects(writer.query("insert into public.audit_logs(workspace_id,action,entity_type) values($1,'x','x')",[w]),/permission denied/i);
  await assert.rejects(writer.query('set role property_task_qa_owner'),/permission denied/i);
  const forged=await writer.connect();
  try {
    await forged.query('begin');
    await forged.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",[fw,fa]);
    await assert.rejects(forged.query('select id from public.tasks where workspace_id=$1',[fw]),/permission denied/i);
  } finally { await forged.query('rollback'); forged.release(); }
  await assert.rejects(invoke(outsider),/AUTHORITY_CHANGED/);
  await assert.rejects(invoke(writer,[randomUUID(),p,u,a,c,1,1,1,randomUUID()]),/DENIED/);
  await assert.rejects(invoke(writer,[fw,fp,fu,fa,fc,1,1,1,randomUUID()]),/AUTHORITY_CHANGED/);
  const otherActor=randomUUID();
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'OTHER','other@example.invalid','agent','project_sales_member','active')",[otherActor,w]);
  await db.admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)',[w,p,otherActor]);
  await assert.rejects(invoke(writer,[w,p,u,otherActor,c,1,1,1,randomUUID()]),/AUTHORITY_CHANGED/);
});

test('owner and runtime roles are restricted; CRM RLS predicates are unchanged',async()=>{
  const roles=await db.admin.query("select rolname,rolsuper,rolbypassrls,rolcanlogin,rolcreaterole,rolcreatedb from pg_roles where rolname=any($1::text[]) order by rolname",[[login,stranger,'property_task_qa_owner']]);
  assert.equal(roles.rows.length,3);
  for(const role of roles.rows) {
    assert.equal(role.rolsuper,false); assert.equal(role.rolbypassrls,false);
    assert.equal(role.rolcreaterole,false); assert.equal(role.rolcreatedb,false);
    assert.equal(role.rolcanlogin,role.rolname!=='property_task_qa_owner');
  }
  const checks=await db.admin.query("select c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where (n.nspname='public' and c.relname=any($1::text[])) or (n.nspname='property_task_qa' and c.relname=any($2::text[]))",[['projects','property_units','tasks','audit_logs'],['authority','receipts']]);
  assert.equal(checks.rows.length,6);
  for(const row of checks.rows) { assert.equal(row.relrowsecurity,true); assert.equal(row.relforcerowsecurity,true); assert.notEqual(row.owner,'property_task_qa_owner'); }
  const fn=await db.admin.query("select pg_get_userbyid(proowner) as owner,prosecdef from pg_proc where oid='property_task_qa.create_task(uuid,uuid,uuid,uuid,uuid,bigint,bigint,bigint,uuid)'::regprocedure");
  assert.deepEqual(fn.rows[0],{owner:'property_task_qa_owner',prosecdef:true});
  const nested=await db.admin.query("select proname,pg_get_userbyid(proowner) as owner,prosecdef from pg_proc where oid=any($1::regprocedure[]) order by proname",[['public.crm_lock_active_member(uuid,uuid)','public.crm_lock_project_access(uuid,uuid,boolean)']]);
  assert.deepEqual(nested.rows.map(row=>[row.owner,row.prosecdef]),[['qa_admin',true],['qa_admin',true]]);
  const membership=await db.admin.query("select pg_has_role('property_task_qa_owner','novalure_tenant_app','member') as member,pg_has_role($1,'property_task_qa_owner','member') as runtime_owner",[login]);
  assert.deepEqual(membership.rows[0],{member:false,runtime_owner:false});
  const privileges=await db.admin.query("select has_table_privilege('property_task_qa_owner','public.tasks','select') as all_select,has_table_privilege('property_task_qa_owner','public.tasks','update') as all_update,has_table_privilege('property_task_qa_owner','public.tasks','delete') as may_delete,has_column_privilege('property_task_qa_owner','public.tasks','id','update') as lock_column,has_column_privilege('property_task_qa_owner','public.tasks','title','update') as change_title");
  assert.deepEqual(privileges.rows[0],{all_select:false,all_update:false,may_delete:false,lock_column:true,change_title:false});
  const after=(await db.admin.query("select schemaname,tablename,policyname,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname")).rows;
  assert.deepEqual(after,policiesBefore);
});

test('existing CRM RLS denies a foreign tenant even to the definer role',async()=>{
  const own=(await invoke(writer)).rows[0].id;
  const foreign=(await invoke(outsider,[fw,fp,fu,fa,fc,1,1,1,randomUUID()])).rows[0].id;
  const client=await db.admin.connect();
  try {
    await client.query('begin'); await client.query('set local role property_task_qa_owner');
    await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",[w,a]);
    const seen=await client.query('select id from public.tasks where id=any($1::uuid[]) order by id',[[own,foreign]]);
    assert.deepEqual(seen.rows,[{id:own}]);
    await assert.rejects(client.query("insert into public.tasks(workspace_id,project_id,owner_user_id,title,data_classification,data_purpose) values($1,$2,$3,'FOREIGN','CUSTOMER_TENANT','crm_sales')",[fw,fp,fa]),/row-level security/i);
  } finally { await client.query('rollback'); client.release(); }
});

test('fixture refuses installation in the cluster default database',async()=>{
  await assert.rejects(cluster.admin.query(await readFile('scripts/fixtures/property-task-crm-qa.sql','utf8')),/QA_ISOLATION_REQUIRED/);
  assert.equal((await cluster.admin.query("select to_regnamespace('property_task_qa') as schema")).rows[0].schema,null);
});

test('concurrent identical operations produce one task and one audit',async()=>{
  const input=args();
  const [one,two]=await Promise.all([invoke(writer,input),invoke(writer,input)]);
  assert.equal(one.rows[0].id,two.rows[0].id);
  const counts=await db.admin.query('select (select count(*) from property_task_qa.receipts where operation_id=$1) as r,(select count(*) from audit_logs where entity_id=$2) as a',[input[8],one.rows[0].id]);
  assert.deepEqual(counts.rows[0],{r:'1',a:'1'});
});

test('same operation cannot be replayed for a different case',async()=>{
  const input=args(), otherCase=randomUUID();
  await db.admin.query('insert into property_task_qa.authority values($1,$2,$3,$4,$5,$6,1,1,true,false,true)',[w,p,u,a,login,otherCase]);
  await invoke(writer,input);
  await assert.rejects(invoke(writer,[w,p,u,a,otherCase,1,1,1,input[8]]),/REPLAY_CONFLICT/);
});

test('rollback removes task, audit and receipt',async()=>{
  const client=await writer.connect(), input=args(); let id;
  try { await client.query('begin'); id=(await invoke(client,input)).rows[0].id; await client.query('rollback'); }
  finally { client.release(); }
  const rows=await db.admin.query('select (select count(*) from tasks where id=$1) as t,(select count(*) from audit_logs where entity_id=$1) as a,(select count(*) from property_task_qa.receipts where task_id=$1) as r',[id]);
  assert.deepEqual(rows.rows[0],{t:'0',a:'0',r:'0'});
});

test('a committed stop wins over a waiting task',async()=>{
  const lock=await db.admin.connect(); let pending;
  try {
    await lock.query('begin');
    await lock.query('update property_task_qa.authority set stopped=true,generation=2 where case_id=$1',[c]);
    pending=invoke(writer);
    assert.equal(await Promise.race([pending.then(()=>false,()=>false),wait(100).then(()=>true)]),true);
    await lock.query('commit');
    await assert.rejects(pending,/AUTHORITY_CHANGED/);
  } finally { await lock.query('rollback').catch(()=>{}); lock.release(); await db.admin.query('update property_task_qa.authority set stopped=false,generation=1 where case_id=$1',[c]); }
});

test('task in flight holds the CRM project-grant and QA authority locks until commit',async()=>{
  const client=await writer.connect(); let revoke;
  try {
    await client.query('begin'); await invoke(client);
    revoke=db.admin.query('update project_pipeline_permissions set can_edit_deals=false where workspace_id=$1 and project_id=$2 and user_id=$3',[w,p,a]);
    assert.equal(await Promise.race([revoke.then(()=>false),wait(100).then(()=>true)]),true);
    await client.query('commit'); await revoke;
    await assert.rejects(invoke(writer),/DENIED/);
  } finally { await client.query('rollback').catch(()=>{}); client.release(); await db.admin.query('update project_pipeline_permissions set can_edit_deals=true where workspace_id=$1 and project_id=$2 and user_id=$3',[w,p,a]); }
});

test('membership revocation serializes with a pending task',async()=>{
  const lock=await db.admin.connect(); let pending;
  try {
    await lock.query('begin');
    await lock.query("update workspace_users set status='invited' where id=$1",[a]);
    pending=invoke(writer);
    assert.equal(await Promise.race([pending.then(()=>false,()=>false),wait(100).then(()=>true)]),true);
    await lock.query('commit');
    await assert.rejects(pending,/DENIED/);
  } finally { await lock.query('rollback').catch(()=>{}); lock.release(); await db.admin.query("update workspace_users set status='active' where id=$1",[a]); }
});

test('source revoke waits behind the task transaction then blocks new operations',async()=>{
  const client=await writer.connect(); let revoke;
  try {
    await client.query('begin'); await invoke(client);
    revoke=db.admin.query('update property_task_qa.authority set source_active=false where case_id=$1',[c]);
    assert.equal(await Promise.race([revoke.then(()=>false),wait(100).then(()=>true)]),true);
    await client.query('commit'); await revoke;
    await assert.rejects(invoke(writer),/AUTHORITY_CHANGED/);
  } finally { await client.query('rollback').catch(()=>{}); client.release(); await db.admin.query('update property_task_qa.authority set source_active=true where case_id=$1',[c]); }
});

test('stale source/case/generation or changed property version fails closed',async()=>{
  for (const change of ['source_active=false','can_write=false','case_version=2','generation=2']) {
    await db.admin.query(`update property_task_qa.authority set ${change} where case_id=$1`,[c]);
    await assert.rejects(invoke(writer),/AUTHORITY_CHANGED/);
    await db.admin.query('update property_task_qa.authority set source_active=true,can_write=true,case_version=1,generation=1 where case_id=$1',[c]);
  }
  const client=await writer.connect(); let change;
  try {
    await client.query('begin'); await invoke(client);
    change=db.admin.query('update property_units set version=version+1 where id=$1',[u]);
    assert.equal(await Promise.race([change.then(()=>false),wait(100).then(()=>true)]),true);
    await client.query('commit'); await change;
  } finally { await client.query('rollback').catch(()=>{}); client.release(); }
  await assert.rejects(invoke(writer),/UNIT_CHANGED/);
});
