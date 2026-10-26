import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction, type TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { createKnowledgeArea, createKnowledgeSource, publishKnowledgeSource, assignKnowledgeAreas, queryKnowledgeCenter } from "../src/lib/knowledge-center/repository";
import { loadEvelynRuntimeContext, recordEvelynRuntimeSignal, evelynDepartments } from "../src/lib/shared-behavior/runtime";
import { handleEvelynRuntimeRequest } from "../src/lib/shared-behavior/runtime-http";
import * as machine from "../src/lib/crm-machine-auth";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

test("Evelyn runtime: CEO, departments and shared workload retain private knowledge boundaries", { timeout: 240000 }, async t => {
 const db = await startLocalSalesDb();
 const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
 const workspace = machine.CRM_MACHINE_WORKSPACE_ID, adminId = randomUUID(), foreign = randomUUID(), foreignOwner = randomUUID();
 const bindings: { actor: string; bot: string; token: string; area: string; id: string; department: string }[] = [];
 function session(userId: string, role: "owner" | "agent" = "agent", workspaceId = workspace): AppSession {
  const productRole = workspaceId === workspace ? role === "owner" ? "platform_admin" : "novalure_operator" : "customer_owner";
  return { authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC", name: "SYNTHETIC", email: "synthetic@example.invalid", role, productRole, permissions: getRolePermissions(role), productPermissions: getProductRoleCapabilities(productRole) };
 }
 async function published(owner: AppSession, areaId: string, content: string) {
  const s = await createKnowledgeSource(owner, { areaId, name: "SYNTHETIC knowledge", content, type: "manual" }, options);
  return publishKnowledgeSource(owner, { sourceId: s.id, versionId: s.draftVersionId!, expectedVersion: s.revision }, options);
 }
 try {
  await applySalesSchema(db, { maxMigrationNumber: 90 });
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC runtime','novalure_internal','novalure_internal','{}') on conflict(id) do update set operating_model='novalure_internal',customer_type='novalure_internal'", [workspace]);
  await db.admin.query("do $$ declare r record; begin for r in select format('%I.%I',n.nspname,c.relname) q from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity loop execute 'alter table '||r.q||' force row level security'; end loop; end $$");
  await db.admin.query("alter table company_profiles enable row level security; alter table company_profiles force row level security; alter table company_profile_versions enable row level security; alter table company_profile_versions force row level security");
  for (const path of ["092_crm_production_machine_identity.sql","093_crm_machine_internal_context.sql","101_knowledge_center.sql","108_knowledge_connected_assistant_quota.sql", "staged/shared_behavior_foundation.sql", "staged/shared_behavior_package2.sql", "staged/shared_behavior_package3.sql"]) {
   const c = await db.admin.connect();
   try { await c.query("begin"); await c.query(await readFile(`migrations/${path}`, "utf8")); await c.query("commit"); }
   catch(e) { await c.query("rollback"); throw e; } finally { c.release(); }
  }
  const native = (await db.admin.query("select id,actor_user_id from crm_service_principals where identity_id=$1 and auth_type='VERCEL_OIDC'", [machine.CRM_MACHINE_IDENTITY_ID])).rows[0];
  const broker = session(native.actor_user_id);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC admin',$3,'owner','platform_admin')", [adminId,workspace,`${adminId}@example.invalid`]);
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC foreign','managed_by_novalure')", [foreign]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC foreign',$3,'owner','customer_owner')", [foreignOwner,foreign,`${foreignOwner}@example.invalid`]);
  for (const id of [workspace,foreign]) await db.admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits) values($1,true,100,20000000,1000,'SYNTHETIC-RUNTIME','{}','{"maxAreas":100,"maxWebsites":30,"maxScansPerMonth":10,"maxUsers":30,"maxAssistants":30}')`, [id]);
  const owner = session(adminId,"owner");
  const common = await createKnowledgeArea(owner, { name: "SYNTHETIC explicitly common", kind: "company" }, options);
  await published(owner, common.id, "runtimeanchor COMMON_ALLOWED");
  const unassigned = await createKnowledgeArea(owner, { name: "SYNTHETIC unassigned", kind: "company" }, options);
  await published(owner, unassigned.id, "runtimeanchor INTERNAL_UNASSIGNED_SECRET");
  const foreignArea = await createKnowledgeArea(session(foreignOwner,"owner",foreign), { name: "SYNTHETIC foreign", kind: "company" }, options);
  await published(session(foreignOwner,"owner",foreign),foreignArea.id,"runtimeanchor FOREIGN_TENANT_SECRET");
  for (const department of evelynDepartments) {
   const actor=randomUUID(), bot=randomUUID(), token=randomBytes(32).toString("base64url"), id=randomUUID();
   await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC runtime',$3,'agent','novalure_operator')", [actor,workspace,`${actor}@example.invalid`]);
   await db.admin.query("insert into bots(id,workspace_id,name,role) values($1,$2,'SYNTHETIC department','advisor')", [bot,workspace]);
   const area=await createKnowledgeArea(owner,{name:`SYNTHETIC ${department}`,kind:"company"},options);
   await published(owner,area.id,`runtimeanchor ${department}_ONLY_SECRET`);
   await createKnowledgeSource(owner,{areaId:area.id,name:"SYNTHETIC draft",content:"runtimeanchor UNPUBLISHED_DRAFT",type:"manual"},options);
   await assignKnowledgeAreas(owner,{botId:bot,channel:"internal",areaIds:[area.id,common.id]},options);
   await db.admin.query("insert into behavior_runtime_bindings(id,workspace_id,broker_actor_id,actor_id,bot_id,department,token_hash,enabled,expires_at) values($1,$2,$3,$4,$5,$6,$7,true,now()+interval '1 day')",[id,workspace,broker.userId,actor,bot,department,createHash("sha256").update(token).digest("hex")]);
   bindings.push({id,actor,bot,token,area:area.id,department});
  }
  await db.admin.query("insert into behavior_releases values(1,array['clarify-goal'],array['ceo','department']); insert into behavior_release_head values(true,1,1)");
  const ceo=bindings[0], finance=bindings.find(b=>b.department==='finance')!;
  const read=(b=ceo,value:unknown={query:"runtimeanchor"})=>loadEvelynRuntimeContext(broker,b.token,value,options);
  await t.test("all canonical roles share methods but receive only their own published knowledge",async()=>{
   let instruction: string | undefined;
   for(const b of bindings){const context=await read(b); assert.equal(context.department,b.department); assert.equal(context.behavior.version,1);
    instruction??=context.behavior.instruction; assert.equal(context.behavior.instruction,instruction);
    assert.deepEqual(context.toolsGranted,[]); const data=JSON.stringify(context.knowledge);
    assert.match(data,new RegExp(`${b.department}_ONLY_SECRET`)); assert.match(data,/COMMON_ALLOWED/);
    for(const other of bindings.filter(x=>x!==b)) assert.doesNotMatch(data,new RegExp(`${other.department}_ONLY_SECRET`));
    assert.doesNotMatch(data,/FOREIGN_TENANT_SECRET|INTERNAL_UNASSIGNED_SECRET|UNPUBLISHED_DRAFT/);
    assert.doesNotMatch(JSON.stringify(context),new RegExp(b.token));
   }
  });
  await t.test("model-supplied department, bot, tenant and area overrides are denied",async()=>{
   for(const key of ["department","botId","actorId","workspaceId","areaIds","tools"]) await assert.rejects(read(ceo,{query:"runtimeanchor",[key]:finance.bot}));
   await assert.rejects(loadEvelynRuntimeContext(broker,randomBytes(32).toString('base64url'),{query:"runtimeanchor"},options));
   await assert.rejects(loadEvelynRuntimeContext(session(foreignOwner,"owner",foreign),ceo.token,{query:"runtimeanchor"},options));
  });
  await t.test("RLS still isolates knowledge when a generic query omits or spoofs the assistant",async()=>{
   const data=JSON.stringify(await queryKnowledgeCenter(session(ceo.actor),{query:"runtimeanchor"},options));
   assert.match(data,/executive_ONLY_SECRET/); assert.doesNotMatch(data,/finance_ONLY_SECRET|FOREIGN_TENANT_SECRET|INTERNAL_UNASSIGNED_SECRET/);
   const rows=await withTenantTransaction({workspaceId:workspace,actorId:ceo.actor},tx=>tx.query("select content from knowledge_chunks"),options);
   assert.doesNotMatch(JSON.stringify(rows),/finance_ONLY_SECRET|FOREIGN_TENANT_SECRET|INTERNAL_UNASSIGNED_SECRET/);
   const spoof=await queryKnowledgeCenter(session(ceo.actor),{query:"runtimeanchor",botId:finance.bot,channel:"internal"},options);
   assert.doesNotMatch(JSON.stringify(spoof),/finance_ONLY_SECRET/);
  });
  await t.test("learning evidence remains private between departments behind the same broker",async()=>{
   for(const b of [ceo,finance]) await recordEvelynRuntimeSignal(broker,b.token,{eventId:randomUUID(),issue:"unclear_goal",outcome:"fail"},options);
   const rows=await withTenantTransaction({workspaceId:workspace,actorId:ceo.actor},tx=>tx.query<{actor_id:string}>("select actor_id from behavior_learning_signals"),options);
   assert.equal(rows.length,1); assert.equal(rows[0].actor_id,ceo.actor);
   await assert.rejects(recordEvelynRuntimeSignal(broker,ceo.token,{eventId:randomUUID(),issue:"unclear_goal",outcome:"fail",transcript:"PRIVATE"},options));
   await assert.rejects(withTenantTransaction({workspaceId:workspace,actorId:ceo.actor},tx=>tx.query("select * from behavior_runtime_bindings"),options));
  });
  const nowSeconds=Math.floor(Date.now()/1000), fakeToken=`eyJ${'a'.repeat(20)}.${'b'.repeat(24)}.${'c'.repeat(24)}`;
  const auth: machine.CrmMachineAuthOptions={env:{NODE_ENV:"production",CRM_MACHINE_AUTH_ENABLED:"1",VERCEL_ENV:"production"},verifier:async()=>({payload:{aud:machine.CRM_MACHINE_AUDIENCE,iss:machine.CRM_MACHINE_ISSUER,sub:machine.CRM_MACHINE_SUBJECT,project_id:machine.CRM_MACHINE_PROJECT_ID,owner_id:machine.CRM_MACHINE_OWNER_ID,environment:"production",jti:randomUUID(),iat:nowSeconds-5,nbf:nowSeconds-5,exp:nowSeconds+3600},protectedHeader:{alg:"RS256",kid:"synthetic-runtime-key",typ:"JWT"}}) as never};
  const request=(token=ceo.token,body:unknown={query:"runtimeanchor"},headers={})=>new Request("https://crm.example.invalid/api/integrations/evelyn/runtime/context",{method:"POST",headers:{authorization:`Bearer ${fakeToken}`,"x-evelyn-runtime-token":token,"content-type":"application/json",...headers},body:JSON.stringify(body)});
  const httpOptions={...options,machineAuth:auth,env:{NODE_ENV:"test" as const,EVELYN_SHARED_RUNTIME_ENABLED:"1"}};
  await t.test("native workload verification plus scoped capability reaches the actual HTTP handler",async()=>{
   const response=await handleEvelynRuntimeRequest(request(),"context",httpOptions);
   assert.equal(response.status,200,JSON.stringify(await response.clone().json())); assert.match(await response.text(),/executive_ONLY_SECRET/);
   assert.equal((await handleEvelynRuntimeRequest(request(),"context",{...httpOptions,env:{NODE_ENV:"test"}})).status,503);
   assert.equal((await handleEvelynRuntimeRequest(request('',{query:"runtimeanchor"}),"context",httpOptions)).status,403);
   assert.equal((await handleEvelynRuntimeRequest(request(ceo.token,{query:"runtimeanchor",department:"finance"}),"context",httpOptions)).status,400);
   assert.equal((await handleEvelynRuntimeRequest(request(ceo.token,{}, {origin:"https://evil.invalid"}),"context",httpOptions)).status,401);
   assert.equal((await handleEvelynRuntimeRequest(request(),"context",{...httpOptions,machineAuth:{...auth,verifier:async()=>{throw new Error("invalid signature");}}})).status,401);
  });
  await t.test("native principal revocation blocks the route without an identity fallback",async()=>{
   await db.admin.query("update crm_service_principals set kill_switch_active=true,kill_switch_reason='SYNTHETIC runtime revocation test' where id=$1",[native.id]);
   assert.equal((await handleEvelynRuntimeRequest(request(),"context",httpOptions)).status,401);
   await db.admin.query("update crm_service_principals set kill_switch_active=false where id=$1",[native.id]);
  });
  await t.test("grant removal, expiry and revocation take effect on the next call",async()=>{
   await db.admin.query("delete from knowledge_area_grants where bot_id=$1 and area_id=$2 and channel='internal'",[ceo.bot,ceo.area]);
   assert.doesNotMatch(JSON.stringify(await read()),/executive_ONLY_SECRET/);
   await db.admin.query("update behavior_runtime_bindings set expires_at=now()-interval '1 second' where id=$1",[finance.id]); await assert.rejects(read(finance));
   await db.admin.query("update behavior_runtime_bindings set revoked_at=now() where id=$1",[ceo.id]); await assert.rejects(read());
   assert.deepEqual((await queryKnowledgeCenter(session(ceo.actor),{query:"runtimeanchor"},options)).matches,[]);
  });
 } finally { await db.stop(); }
});
