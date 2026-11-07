import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { CrmCommandError, withCrmRead } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { upsertCustomerProjectGrant } from "../src/lib/db/customer-access-repositories";
import { readCustomerProjectGrantState } from "../src/lib/db/customer-project-grant-repository";
import { loadPropertySalesWorkspace } from "../src/lib/db/property-sales-repositories";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

test("project grants: actual tenant runtime, cumulative project gate, CAS and atomic receipts",{timeout:240_000},async t=>{
 const db=await startLocalSalesDb();
 const options={pool:db.pool as unknown as TenantPool};
 const previousFetch=globalThis.fetch;
 globalThis.fetch=async()=>{throw Error("Provider egress forbidden in isolated grant qualification");};
 try{
  // Reuse the qualified compatibility fixture's actual Webchat/partner
  // predecessors. This synthetic PG18 fixture is not the PG17 native upgrade.
  await applySalesSchema(db,{maxMigrationNumber:90});
  await db.admin.query("alter table company_profiles enable row level security;alter table company_profiles force row level security;alter table company_profile_versions enable row level security;alter table company_profile_versions force row level security");
  await db.admin.query("do $$ declare r record;begin for r in select format('%I.%I',n.nspname,c.relname) as q from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in('r','p') and c.relrowsecurity loop execute 'alter table '||r.q||' force row level security';end loop;end $$");
  async function apply(name:string){const client=await db.admin.connect();const sql=await readFile(`migrations/${name}`,"utf8");try{await client.query("begin");await client.query(sql);await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3) on conflict(version) do nothing",[name.replace(/\.sql$/,""),name,createHash("sha256").update(sql.replace(/\r\n/g,"\n")).digest("hex")]);await client.query("commit");}catch(e){await client.query("rollback");throw e;}finally{client.release();}}
  for(const name of ["092_crm_production_machine_identity.sql","093_crm_machine_internal_context.sql","094_website_sales_ingestion.sql","095_form_tenant_isolation.sql","096_public_integration_gateway.sql"])await apply(name);
  for(const name of (await readdir("migrations")).filter(name=>/^\d+.*\.sql$/.test(name)&&!name.includes("_rollback")&&Number(name.slice(0,3))>=101&&Number(name.slice(0,3))<=110).sort())await apply(name);
  for(const name of ["114_customer_workspace_provisioning.sql","146_ai_credit_billing.sql","152_ai_billing_admin.sql","153_ai_billing_runtime_acl.sql","167_crm_partner_cooperation.sql","188_crm_ai_assistant.sql","121_webchat_customer_product.sql","191_webchat_partner_access_compatibility.sql"])await apply(name);
  // The real read-only production catalog records these existing direct CRUD
  // ACLs on novalure_app, including the target membership's existing row-lock
  // authority. Historical local-sales bootstrap omits that legacy setup.
  // Mirror only those four actual ACLs, without changing RLS or owners.
  await db.admin.query("grant select,insert,update,delete on customer_workspace_access,customer_project_access,project_pipeline_permissions,workspace_users to novalure_app");
  async function person(workspaceId:string,owner:boolean){
   const userId=randomUUID(),sessionId=randomUUID();
   const row=(await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC grant subject',$3,$4,$5,'active') returning auth_identity_id",[userId,workspaceId,`grant-${userId}@example.invalid`,owner?"owner":"agent",owner?"novalureAdmin":"project_sales_member"])).rows[0];
   await db.admin.query("update auth_identities set credential_state='active' where id=$1",[row.auth_identity_id]);
   await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')",[sessionId,createHash('sha256').update(randomUUID()).digest('hex'),row.auth_identity_id,userId,workspaceId]);
   const role=owner?"owner":"agent",productRole=owner?"novalureAdmin":"project_sales_member";
   const session:AppSession={authenticated:true,source:"database",workspaceId,userId,name:"SYNTHETIC",email:`grant-${userId}@example.invalid`,workspaceName:"SYNTHETIC grant QA",role,productRole,permissions:getRolePermissions(role),productPermissions:getProductRoleCapabilities(productRole),authIdentityId:row.auth_identity_id,authSessionId:sessionId};
   return session;
  }
  async function tenant(){
   const w=randomUUID(),p=randomUUID(),organization=randomUUID(),access=randomUUID();
   await db.admin.query("insert into workspaces(id,name,is_qa,operating_model,customer_type) values($1,'SYNTHETIC grant QA',true,'self_service_customer','general_company')",[w]);
   const owner=await person(w,true),member=await person(w,false);
   await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC protected project','Service')",[p,w]);
   await db.admin.query("insert into organizations(id,workspace_id,name,type) values($1,$2,'SYNTHETIC grant customer','Kunde')",[organization,w]);
   await db.admin.query("insert into customer_workspace_access(id,workspace_id,organization_id,project_id,owner_user_id,status) values($1,$2,$3,$4,$5,'active')",[access,w,organization,p,owner.userId]);
   return{w,p,organization,access,owner,member};
  }
  const a=await tenant(),b=await tenant();
  const scope=(tenant=a,access=tenant.access,user=tenant.member.userId)=>({accessId:access,projectId:tenant.p,userId:user});
  const meta=()=>({idempotencyKey:randomUUID(),correlationId:randomUUID()});
  const state=(tenant=a,access=tenant.access,user=tenant.member.userId)=>readCustomerProjectGrantState(tenant.owner,scope(tenant,access,user),options);
  async function change(enabled:boolean,tenant=a,access=tenant.access,expected?:string,metadata=meta()){
   const snapshot=expected??(await state(tenant,access)).digest;
   return upsertCustomerProjectGrant({...scope(tenant,access),session:tenant.owner,accessLevel:"editor",projectRole:"agent",status:enabled?"active":"suspended",canViewProject:true,canEditProject:true,canViewContacts:true,canExportData:false,expectedStateDigest:snapshot,...metadata},options);
  }
  const actualRead=(session=a.member,project=a.p)=>withCrmRead(session,tx=>tx.queryOne<{allowed:boolean}>("select crm_project_access($1::uuid,$2::uuid,false) as allowed",[session.workspaceId,project]),options);
  const direct=(session=a.member,project=a.p)=>loadPropertySalesWorkspace(session,project,options);
  const denied=(e:unknown)=>e instanceof CrmCommandError&&[401,403,404].includes(e.status);
  const pipeline=async(tenant=a,user=tenant.member.userId)=>(await db.admin.query("select to_jsonb(p) as row from project_pipeline_permissions p where workspace_id=$1 and project_id=$2 and user_id=$3",[tenant.w,tenant.p,user])).rows[0]?.row;

  await t.test("grant then revoke removes CanRead and protected direct access from the same old session",async()=>{
   assert.equal((await actualRead())?.allowed,false);await assert.rejects(direct(),denied);
   await change(true);assert.equal((await actualRead())?.allowed,true);assert.equal((await direct()).project.id,a.p);
   await change(false);assert.equal((await pipeline()).can_read,false);assert.equal((await actualRead())?.allowed,false);await assert.rejects(direct(),denied);
   const session=(await db.admin.query("select revoked_at from auth_sessions where id=$1",[a.member.authSessionId])).rows[0];assert.equal(session.revoked_at,null,"grant revocation must be observed without globally changing the subject's identity or session");
  });
  await t.test("stale editor cannot overwrite a newer grant and same-key committed replay is historical",async()=>{
   const before=await state(),key=meta();const first=await change(true,a,a.access,before.digest,key);
   const replay=await change(true,a,a.access,before.digest,key);assert.equal(replay.mutation.replayed,true);assert.equal(replay.mutation.commandId,first.mutation.commandId);
   await assert.rejects(change(false,a,a.access,before.digest),e=>e instanceof CrmCommandError&&e.code==="GRANT_STATE_CHANGED");assert.equal((await actualRead())?.allowed,true);
  });
  await t.test("malformed statuses and permission booleans cannot turn into an active default grant",async()=>{
   const before=await state();
   const input={...scope(),session:a.owner,accessLevel:"viewer",projectRole:"agent",status:"suspended",canViewProject:false,canEditProject:false,canViewContacts:false,canExportData:false,expectedStateDigest:before.digest};
   for(const invalid of [{status:"suspend_typo"},{canViewProject:"false"},{accessLevel:null}])await assert.rejects(upsertCustomerProjectGrant({...input,...invalid,...meta()},options),e=>e instanceof CrmCommandError&&e.code==="INVALID_GRANT");
   assert.equal((await state()).digest,before.digest);
  });
  await t.test("two actual concurrent writers with the same before-image commit exactly once",async()=>{
   const before=await state();const results=await Promise.allSettled([change(false,a,a.access,before.digest),change(false,a,a.access,before.digest)]);
   assert.equal(results.filter(r=>r.status==="fulfilled").length,1);const failure=results.find(r=>r.status==="rejected") as PromiseRejectedResult;
   assert.ok(failure.reason instanceof CrmCommandError&&failure.reason.code==="GRANT_STATE_CHANGED");assert.equal((await actualRead())?.allowed,false);
  });
  await t.test("an independently administered grant cannot slip into the missing-row window",async()=>{
   const subject=await person(a.w,false),snapshot=await state(a,a.access,subject.userId);
   let checked=false;
   const guardedPool={connect:async()=>{
    const client=await db.pool.connect();
    return new Proxy(client,{get(target,property){
     if(property==="release")return target.release.bind(target);
     if(property!=="query")return Reflect.get(target,property);
     return async(query:string,parameters?:unknown[])=>{
      const result=await target.query(query,parameters);
      if(!checked&&query.includes("from workspace_users u")&&query.includes("for update")){
       const competitor=await db.admin.connect();
       try{
        await competitor.query("begin");await competitor.query("set local lock_timeout='100ms'");
        await assert.rejects(competitor.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,metadata) values($1,$2,$3,true,'{\"source\":\"independent\"}')",[a.w,a.p,subject.userId]),{code:"55P03"});
        checked=true;
       }finally{await competitor.query("rollback");competitor.release();}
      }
      return result;
     };
    }});
   }};
   await upsertCustomerProjectGrant({...scope(a,a.access,subject.userId),session:a.owner,accessLevel:"viewer",projectRole:"agent",status:"active",canViewProject:true,canEditProject:false,canViewContacts:false,canExportData:false,expectedStateDigest:snapshot.digest,...meta()},{pool:guardedPool as unknown as TenantPool});
   assert.equal(checked,true);assert.equal((await actualRead(subject))?.allowed,true);
   const current=await state(a,a.access,subject.userId);
   await upsertCustomerProjectGrant({...scope(a,a.access,subject.userId),session:a.owner,accessLevel:"viewer",projectRole:"agent",status:"suspended",canViewProject:false,canEditProject:false,canViewContacts:false,canExportData:false,expectedStateDigest:current.digest,...meta()},options);
   assert.equal((await actualRead(subject))?.allowed,false);
  });
  await t.test("another active business grant is preserved as a separate read authority",async()=>{
   const second=randomUUID();await db.admin.query("insert into customer_workspace_access(id,workspace_id,organization_id,project_id,status) values($1,$2,$3,$4,'active')",[second,a.w,a.organization,a.p]);
   await change(true);await change(true,a,second);await change(false);
   assert.equal((await state()).activeOtherGrantCount,1);assert.equal((await actualRead())?.allowed,true);await direct();
   await change(false,a,second);assert.equal((await actualRead())?.allowed,false);
  });
  await t.test("foreign tenant and unrelated membership/customer/workspace rights stay unchanged",async()=>{
   await change(true,b);const before=await pipeline(b);
   const unaffected=async()=>(await db.admin.query("select (select jsonb_agg(to_jsonb(w) order by id) from workspaces w where id=any($1::uuid[])) as workspaces,(select jsonb_agg(to_jsonb(u) order by id) from workspace_users u where workspace_id=any($1::uuid[])) as users,(select jsonb_agg(to_jsonb(a) order by id) from customer_workspace_access a where workspace_id=any($1::uuid[])) as customers",[[a.w,b.w]])).rows[0];
   const originalRights=await unaffected();
   await assert.rejects(readCustomerProjectGrantState(a.owner,scope(b),options),denied);
   await change(true);await change(false);assert.deepEqual(await pipeline(b),before);assert.deepEqual(await unaffected(),originalRights);assert.equal((await actualRead(b.member,b.p))?.allowed,true);await direct(b.member,b.p);
  });
  await t.test("an independent manual projection cannot be adopted or overwritten by a valid digest",async()=>{
   const other=await person(a.w,false);
   await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals,metadata) values($1,$2,$3,true,false,$4)",[a.w,a.p,other.userId,JSON.stringify({source:"manual_project_administration",authority:"SYNTHETIC independent"})]);
   const before=await pipeline(a,other.userId),snapshot=await state(a,a.access,other.userId);assert.equal(snapshot.projectionOwnership,"independent");
   await assert.rejects(upsertCustomerProjectGrant({...scope(a,a.access,other.userId),session:a.owner,accessLevel:"viewer",projectRole:"agent",status:"suspended",canViewProject:false,canEditProject:false,canViewContacts:false,canExportData:false,expectedStateDigest:snapshot.digest,...meta()},options),e=>e instanceof CrmCommandError&&e.code==="GRANT_PROJECTION_INDEPENDENT");
   assert.deepEqual(await pipeline(a,other.userId),before);assert.equal((await db.admin.query("select count(*)::int as n from customer_project_access where workspace_id=$1 and user_id=$2",[a.w,other.userId])).rows[0].n,0);
  });
  await t.test("current stored caller rights and revoked sessions defeat stale admin claims",async()=>{
   const before=await state();await db.admin.query("update workspace_users set product_role='viewer',role='assistant' where id=$1",[a.owner.userId]);
   try{await assert.rejects(change(true,a,a.access,before.digest),denied);}finally{await db.admin.query("update workspace_users set product_role='novalureAdmin',role='owner' where id=$1",[a.owner.userId]);}
   await db.admin.query("update auth_sessions set revoked_at=now(),revoked_reason='SYNTHETIC grant revocation' where id=$1",[a.owner.authSessionId]);
   try{await assert.rejects(state(),denied);}finally{await db.admin.query("update auth_sessions set revoked_at=null,revoked_reason=null where id=$1",[a.owner.authSessionId]);}
  });
  await t.test("legacy merged provenance is not silently treated as an exclusively owned read grant",async()=>{
   const other=await person(a.w,false),grantId=randomUUID();
   await db.admin.query("insert into customer_project_access(id,workspace_id,customer_access_id,project_id,user_id,project_role,access_level,status) values($1,$2,$3,$4,$5,'agent','viewer','suspended')",[grantId,a.w,a.access,a.p,other.userId]);
   await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,metadata) values($1,$2,$3,true,$4)",[a.w,a.p,other.userId,JSON.stringify({source:"customer_access_cockpit",customerAccessId:a.access,grantStatus:"suspended"})]);
   const before=await pipeline(a,other.userId),snapshot=await state(a,a.access,other.userId);assert.equal(snapshot.projectionOwnership,"independent");
   await assert.rejects(upsertCustomerProjectGrant({...scope(a,a.access,other.userId),session:a.owner,accessLevel:"viewer",projectRole:"agent",status:"suspended",canViewProject:false,canEditProject:false,canViewContacts:false,canExportData:false,expectedStateDigest:snapshot.digest,...meta()},options),e=>e instanceof CrmCommandError&&e.code==="GRANT_PROJECTION_INDEPENDENT");
   assert.deepEqual(await pipeline(a,other.userId),before);
  });
  await t.test("audit failure rolls back both business grant and pipeline, with no receipt",async()=>{
   const before=await state(),old=await pipeline(),key=meta();
   await db.admin.query(`create function synthetic_grant_audit_fail() returns trigger language plpgsql as $$begin if new.action='customer_access.project_grant_upserted' then raise exception 'SYNTHETIC audit failure';end if;return new;end $$;create trigger synthetic_grant_audit_fail before insert on audit_logs for each row execute function synthetic_grant_audit_fail()`);
   try{await assert.rejects(change(true,a,a.access,before.digest,key),/SYNTHETIC audit failure/);}finally{await db.admin.query("drop trigger synthetic_grant_audit_fail on audit_logs;drop function synthetic_grant_audit_fail()");}
   assert.deepEqual(await pipeline(),old);assert.equal((await state()).digest,before.digest);assert.equal((await db.admin.query("select count(*)::int as n from crm_command_receipts where workspace_id=$1 and idempotency_key=$2",[a.w,key.idempotencyKey])).rows[0].n,0);
  });
  await t.test("a current workspace-manager authority is never revoked by changing its project grant",async()=>{
   const snapshot=await state(a,a.access,a.owner.userId);
   await upsertCustomerProjectGrant({...scope(a,a.access,a.owner.userId),session:a.owner,accessLevel:"viewer",projectRole:"owner",status:"suspended",canViewProject:false,canEditProject:false,canViewContacts:false,canExportData:false,expectedStateDigest:snapshot.digest,...meta()},options);
   assert.equal((await actualRead(a.owner))?.allowed,true);await direct(a.owner);
  });
 }finally{globalThis.fetch=previousFetch;await db.stop();}
});
