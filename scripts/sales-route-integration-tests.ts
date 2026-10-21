import assert from "node:assert/strict";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {test} from "node:test";
import {startLocalSalesDb,applySalesSchema} from "./lib/local-sales-db.mjs";
import {seedSalesBrowser} from "./lib/sales-browser-fixture.mjs";
import {createCsrfToken} from "../src/lib/security/csrf-core";
import {closeLocalTestPool,getLocalTestPool} from "../src/lib/db/local-test-transport";
import {runWithTenantTransaction} from "../src/lib/db/transaction-context";
import type {TenantTransaction} from "../src/lib/db/tenant-client";
import {hasNotificationQueueAccess} from "../src/lib/db/notification-queue-access";
import {queueTeamsNotification} from "../src/lib/db/teams-notification-repositories";
import {queueGoogleNotification} from "../src/lib/db/google-notification-repositories";
import type {AppSession} from "../src/lib/auth/session";
import * as contacts from "../src/app/api/crm/contacts/route";
import * as tasks from "../src/app/api/crm/tasks/route";
import * as projects from "../src/app/api/crm/projects/route";
import * as leads from "../src/app/api/crm/leads/route";
import * as deals from "../src/app/api/crm/deals/route";
import * as stages from "../src/app/api/crm/deals/[dealId]/stage/route";
import * as analytics from "../src/app/api/crm/analytics-events/route";
import {POST as reconcile} from "../src/app/api/crm/commands/reconcile/route";
type Handler=(request:Request)=>Promise<Response>;
test("G06 actual cookie/CSRF routes: six areas, exact replay, current authority and tenant isolation",{timeout:240000},async t=>{
 const db=await startLocalSalesDb();const names=["DATABASE_URL","NODE_ENV","CRM_LOCAL_TEST_DATABASE","NOVALURE_SESSION_SECRET","NOVALURE_APP_ORIGIN","NOVALURE_AUTH_STRICT","NOVALURE_AUTH_ENCRYPTION_KEY","NOVALURE_AUTH_RATE_LIMIT_SECRET"];
 const original=Object.fromEntries(names.map(key=>[key,process.env[key]]));
 try{
  await applySalesSchema(db);const fixture=await seedSalesBrowser(db),secret=randomBytes(48).toString("base64url"),origin="http://127.0.0.1:3000";
  Object.assign(process.env,{DATABASE_URL:"postgresql://"+db.role+"@127.0.0.1:"+db.port+"/postgres",NODE_ENV:"test",CRM_LOCAL_TEST_DATABASE:"1",NOVALURE_SESSION_SECRET:secret,NOVALURE_APP_ORIGIN:origin,NOVALURE_AUTH_STRICT:"1",NOVALURE_AUTH_ENCRYPTION_KEY:randomBytes(40).toString("hex"),NOVALURE_AUTH_RATE_LIMIT_SECRET:randomBytes(40).toString("hex")});
  const runtimeGrants=()=>db.admin.query("select c.relname,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity,has_table_privilege($1,c.oid,'SELECT') as can_select,has_table_privilege($1,c.oid,'INSERT') as can_insert,has_table_privilege($1,c.oid,'UPDATE') as can_update,has_table_privilege($1,c.oid,'DELETE') as can_delete from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v') order by c.relname",[db.role]).then(result=>result.rows);
  const grantsBefore=await runtimeGrants();
  // Capture only safe SQLSTATE/table diagnostics from the actual loopback runtime driver.
  // No SQL text, parameters, session material or raw database errors are printed.
  let captureSqlFailure=false;
  const sqlFailures:Array<{sqlstate:string;table:string}>=[];
  const runtimePool=await getLocalTestPool(process.env.DATABASE_URL!);
  assert.ok(runtimePool);
  runtimePool.on("connect",client=>{
   const query=client.query.bind(client);
   client.query=((...args:unknown[])=>{
    const pending:unknown=Reflect.apply(query,undefined,args);
    if(!(pending instanceof Promise))return pending;
    return pending.catch((error:unknown)=>{
     if(captureSqlFailure){
      const code=error&&typeof error==="object"&&"code"in error?String(error.code):"";
      const sql=typeof args[0]==="string"?args[0]:args[0]&&typeof args[0]==="object"&&"text"in args[0]?String(args[0].text):"";
      sqlFailures.push({sqlstate:/^[0-9A-Z]{5}$/.test(code)?code:"UNKNOWN",table:/\b(?:into|from|update)\s+(?:public\.)?([a-z_][a-z_0-9]*)/i.exec(sql)?.[1]??"UNKNOWN"});
     }
     throw error;
    });
   })as typeof client.query;
  });
  // This unit fixture seeds a synthetic persisted MFA session. Password/MFA UI is tested separately by the browser suite.
  const cookie="v2."+randomBytes(32).toString("base64url"),sessionId=randomUUID();
  await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')",[sessionId,createHash("sha256").update(cookie).digest("hex"),fixture.authIdentityId,fixture.userId,fixture.workspaceId]);
  const metadata=()=>({key:randomUUID(),correlation:randomUUID()});
  const request=(path:string,method:string,body:unknown,meta=metadata(),token?:string)=>new Request(origin+path,{method,headers:{"Content-Type":"application/json",cookie:"novalure_session="+cookie,origin,"sec-fetch-site":"same-origin","x-novalure-csrf-token":token??createCsrfToken({method,pathname:path.split("?")[0],secret,sessionCookie:cookie})!.token,"Idempotency-Key":meta.key,"X-Correlation-Id":meta.correlation},body:JSON.stringify(body)});
  async function execute(handler:Handler,path:string,method:string,body:unknown,meta=metadata()) {const response=await handler(request(path,method,body,meta));assert.equal(response.status,200,await response.clone().text());return response.json();}
  async function replay(handler:Handler,path:string,method:string,body:unknown) {const meta=metadata(),first=await execute(handler,path,method,body,meta),again=await execute(handler,path,method,body,meta);assert.equal(first.commandId,again.commandId);assert.equal(again.replayed,true);return {data:first,meta};}
  let contact:{id:string;version:number},task:{id:string;version:number},project:{id:string;version:number},lead:{id:string;version:number},deal:{id:string;version:number};
  await t.test("one CSRF consumption permits contact create; nonce replay denies; fresh nonce command retry replays",async()=>{
   const path="/api/crm/contacts",body={contact:{name:"SYNTHETIC route contact",projectId:fixture.projectId,source:"Manual",role:"Bauträger"}},meta=metadata();const token=createCsrfToken({method:"POST",pathname:path,secret,sessionCookie:cookie})!.token;
   const first=await contacts.POST(request(path,"POST",body,meta,token));assert.equal(first.status,200,await first.clone().text());const result=await first.json();contact=result.contact;
   assert.equal((await contacts.POST(request(path,"POST",body,meta,token))).status,403);
   const again=await execute(contacts.POST,path,"POST",body,meta);assert.equal(again.commandId,result.commandId);assert.equal(again.replayed,true);
   assert.equal(Number((await db.admin.query("select count(*) from contacts where workspace_id=$1 and name='SYNTHETIC route contact'",[fixture.workspaceId])).rows[0].count),1);
   assert.equal((await contacts.POST(request(path,"POST",{contact:{...body.contact,name:"changed"}},meta))).status,409);
   const recovered=await execute(reconcile,"/api/crm/commands/reconcile","POST",{target:path,method:"POST",body},meta);assert.equal(recovered.status,"COMMITTED");assert.equal(recovered.response.body.contact.id,contact.id);
  });
  await t.test("task/project/lead/deal creates and stage change each return one durable result",async stageTest=>{
   task=(await replay(tasks.POST,"/api/crm/tasks","POST",{task:{title:"SYNTHETIC route task",projectId:fixture.projectId,contactId:contact.id}})).data.task;
   project=(await replay(projects.POST,"/api/crm/projects","POST",{project:{name:"SYNTHETIC route project"}})).data.project;
   lead=(await replay(leads.POST,"/api/crm/leads","POST",{lead:{contactId:contact.id,projectId:fixture.projectId,type:"Bauträger",source:"Manual",intent:"SYNTHETIC service inquiry"}})).data.lead;
   deal=(await replay(deals.POST,"/api/crm/deals","POST",{deal:{contactId:contact.id,leadId:lead.id,projectId:fixture.projectId,name:"SYNTHETIC route deal",stage:"Neu",value:"9900",expectedCloseDate:"2030-12-31"}})).data.deal;
   const path="/api/crm/deals/"+deal.id+"/stage",context={params:Promise.resolve({dealId:deal.id})};
   deal=(await replay(req=>stages.POST(req,context),path,"POST",{toStage:"Qualifizieren",expectedVersion:deal.version})).data.deal;
   assert.equal(Number((await db.admin.query("select count(*) from deal_stage_history where deal_id=$1 and to_stage='Qualifizieren'",[deal.id])).rows[0].count),1);
   let historyBefore=Number((await db.admin.query("select count(*) from deal_stage_history where deal_id=$1",[deal.id])).rows[0].count);
   const missing=await stages.POST(request(path,"POST",{toStage:"Neu"}),context);assert.equal(missing.status,409,await missing.clone().text());assert.equal((await missing.json()).code,"VERSION_CONFLICT");
   const stale=await stages.POST(request(path,"POST",{toStage:"Neu",expectedVersion:deal.version-1}),context);assert.equal(stale.status,409,await stale.clone().text());assert.equal((await stale.json()).code,"VERSION_CONFLICT");
   const analyticsResponse=await analytics.GET(new Request(origin+"/api/crm/analytics-events?eventTypes=deal_created,deal_stage_changed&limit=100",{headers:{cookie:"novalure_session="+cookie}}));assert.equal(analyticsResponse.status,200,await analyticsResponse.clone().text());const events=(await analyticsResponse.json()).events;assert.ok(events.some((event:{dealId:string;eventType:string})=>event.dealId===deal.id&&event.eventType==="deal_created"));assert.ok(events.some((event:{dealId:string;eventType:string})=>event.dealId===deal.id&&event.eventType==="deal_stage_changed"));
   await stageTest.test("lost stage rejects a missing structured reason without mutating the deal or history",async()=>{
    const stateSql="select stage,version,lost_reason_category,lost_reason_detail,lost_at,closed_at,(select count(*) from deal_stage_history where deal_id=d.id) as history_count from deals d where id=$1";
    const before=(await db.admin.query(stateSql,[deal.id])).rows;
    const response=await stages.POST(request(path,"POST",{toStage:"Verloren",expectedVersion:deal.version}),context),body=await response.json();
    stageTest.diagnostic(JSON.stringify({case:"lost-without-reason",status:response.status,code:body.code??null}));
    assert.equal(response.status,400);assert.equal(body.code,"WRITE_REJECTED");assert.equal(body.error,"WRITE_REJECTED: Structured lost reason is required");
    assert.deepEqual((await db.admin.query(stateSql,[deal.id])).rows,before);
   });
   await stageTest.test("lost stage persists the allowed timing reason under actual runtime ACL/RLS",async()=>{
    // applySalesSchema retains actual 080 ACL/FORCE RLS, but its documented
    // portable fixture omits optional vector and the dedicated manual cutovers.
    const before=(await db.admin.query("select stage,version,lost_reason_category,lost_reason_detail,lost_at,closed_at from deals where id=$1",[deal.id])).rows;
    sqlFailures.length=0;captureSqlFailure=true;
    let response:Response;
    try{response=await stages.POST(request(path,"POST",{toStage:"Verloren",expectedVersion:deal.version,reason:"SYNTHETIC timing does not fit",reasonCategory:"timing",reasonDetail:"SYNTHETIC customer wants to sell later"}),context)}
    finally{captureSqlFailure=false}
    const body=await response.json();
    stageTest.diagnostic(JSON.stringify({case:"lost-with-structured-reason",status:response.status,code:body.code??null,sqlFailures}));
    if(response.status!==200){
     assert.deepEqual((await db.admin.query("select stage,version,lost_reason_category,lost_reason_detail,lost_at,closed_at from deals where id=$1",[deal.id])).rows,before);
     assert.equal(Number((await db.admin.query("select count(*) from deal_stage_history where deal_id=$1",[deal.id])).rows[0].count),historyBefore);
     stageTest.diagnostic(JSON.stringify({case:"rejected-lost-transaction",dealAndHistoryUnchanged:true}));
    }
    assert.equal(response.status,200,"structured timing reason must persist");
    assert.equal(body.deal.version,deal.version+1);assert.equal(body.deal.lostReasonCategory,"timing");assert.equal(body.deal.lostReasonDetail,"SYNTHETIC customer wants to sell later");
    assert.equal(sqlFailures.length,0);
    deal=body.deal;
    const historyAfter=Number((await db.admin.query("select count(*) from deal_stage_history where deal_id=$1",[deal.id])).rows[0].count);
    assert.equal(historyAfter,historyBefore+1);historyBefore=historyAfter;
    const persistedHistory=(await db.admin.query("select reason_category,reason_detail from deal_stage_history where deal_id=$1 and to_stage='Verloren'",[deal.id])).rows;
    assert.deepEqual(persistedHistory,[{reason_category:"timing",reason_detail:"SYNTHETIC customer wants to sell later"}]);
    const outcome=(await db.admin.query("select event_type,count(*)::int as n from analytics_events where deal_id=$1 and event_type in ('deal_lost','deal_stage_changed') group by event_type order by event_type",[deal.id])).rows;
    assert.deepEqual(outcome,[{event_type:"deal_lost",n:1},{event_type:"deal_stage_changed",n:2}]);
    assert.deepEqual(await runtimeGrants(),grantsBefore);
   });
   const invalid=await stages.POST(request(path,"POST",{toStage:"Invalid",expectedVersion:deal.version}),context);assert.equal(invalid.status,400,await invalid.clone().text());
   const unknownId=randomUUID(),unknownPath="/api/crm/deals/"+unknownId+"/stage",unknown=await stages.POST(request(unknownPath,"POST",{toStage:"Neu",expectedVersion:1}),{params:Promise.resolve({dealId:unknownId})});assert.equal(unknown.status,404,await unknown.clone().text());
   const beforeDenied=(await db.admin.query("select stage,version from deals where id=$1",[deal.id])).rows;
   await db.admin.query("update workspace_users set role='assistant',product_role='viewer' where id=$1",[fixture.userId]);
   const denied=await stages.POST(request(path,"POST",{toStage:"Neu",expectedVersion:deal.version}),context);assert.equal(denied.status,403,await denied.clone().text());
   await db.admin.query("update workspace_users set role='owner',product_role='novalureAdmin' where id=$1",[fixture.userId]);
   const unchanged=await db.admin.query("select stage,version from deals where id=$1",[deal.id]);assert.deepEqual(unchanged.rows,beforeDenied);assert.equal(Number(unchanged.rows[0].version),deal.version);assert.equal(Number((await db.admin.query("select count(*) from deal_stage_history where deal_id=$1",[deal.id])).rows[0].count),historyBefore);
  });
  await t.test("both optional queue preflights require every grant without changing application privileges",async()=>{
   const client=await db.admin.connect(),probeRole="queue_acl_"+randomUUID().replaceAll("-","");
   const jobCounts=()=>db.admin.query("select (select count(*) from teams_notification_jobs) as teams,(select count(*) from google_notification_jobs) as google").then(result=>result.rows);
   const jobsBefore=await jobCounts();
   try{
    await client.query("begin");
    await client.query(`create role ${probeRole} nologin inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await client.query(`grant usage on schema public to ${probeRole}`);
    await client.query(`grant novalure_tenant_app to ${probeRole}`);
    await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",[fixture.workspaceId,fixture.userId]);
    const port:TenantTransaction={
     query:async(sql,params=[])=>{return(await client.query(sql,[...params])).rows},
     queryOne:async(sql,params=[])=>{return(await client.query(sql,[...params])).rows[0]??null},
     execute:async(sql,params=[])=>{await client.query(sql,[...params])},
    };
    for(const provider of ["teams","google"]as const){
     const targets=`public.${provider}_notification_targets`,jobs=`public.${provider}_notification_jobs`;
     const allowed=async()=>{
      await client.query(`set local role ${probeRole}`);
      try{
       assert.equal((await client.query("select current_user as role")).rows[0].role,probeRole);
       return await runWithTenantTransaction({workspaceId:fixture.workspaceId,actorId:fixture.userId},port,()=>hasNotificationQueueAccess(provider));
      }finally{await client.query("reset role")}
     };
     assert.equal(await allowed(),false,"no queue grants");
     await client.query(`grant select on ${targets},${jobs} to ${probeRole}`);
     assert.equal(await allowed(),false,"SELECT alone must not imply INSERT/UPDATE");
     await client.query(`grant insert,update on ${jobs} to ${probeRole}`);
     assert.equal(await allowed(),true,"legitimate complete queue privileges");
     await client.query(`set local role ${probeRole}`);
     try{
      const session:AppSession={authenticated:true,userId:fixture.userId,workspaceId:fixture.workspaceId,workspaceName:"SYNTHETIC SALES QA",email:fixture.email,name:"Synthetic sales owner",role:"owner",permissions:["crm:read","crm:write"],productRole:"novalureAdmin",productPermissions:[],source:"database"};
      const input={alertType:"deal_stage_changed"as const,entityType:"deal_stage_history",entityId:randomUUID(),idempotencyKey:"synthetic-pending-"+randomUUID(),projectId:fixture.projectId,session,title:"SYNTHETIC queue access",summary:"SYNTHETIC absent target"};
      const queued=await runWithTenantTransaction({workspaceId:fixture.workspaceId,actorId:fixture.userId},port,()=>provider==="teams"?queueTeamsNotification(input):queueGoogleNotification(input));
      assert.equal(queued.queued,false);assert.equal(queued.job?.status,"pending_config");assert.ok(queued.job?.id);
      const saved=(await client.query(`select status,target_id,workspace_id,project_id from ${jobs} where id=$1`,[queued.job.id])).rows;
      assert.deepEqual(saved,[{status:"pending_config",target_id:null,workspace_id:fixture.workspaceId,project_id:fixture.projectId}]);
     }finally{await client.query("reset role")}
     for(const privilege of ["select","insert","update"]){
      await client.query(`revoke ${privilege} on ${jobs} from ${probeRole}`);
      assert.equal(await allowed(),false,`missing job ${privilege} must deny`);
      await client.query(`grant ${privilege} on ${jobs} to ${probeRole}`);
     }
     await client.query(`revoke select on ${targets} from ${probeRole}`);
     assert.equal(await allowed(),false,"missing target SELECT must deny");
    }
   }finally{try{await client.query("rollback")}finally{client.release()}}
   assert.deepEqual(await jobCounts(),jobsBefore);
   assert.deepEqual(await runtimeGrants(),grantsBefore);
  });
  await t.test("CAS updates replay without version increment; stale intent cannot overwrite",async()=>{
   const operations:Array<[Handler,string,Record<string,unknown>,string]>=[
    [contacts.PATCH,"contacts",{contact:{id:contact.id,name:"SYNTHETIC revised contact"},expectedVersion:contact.version},"contact"],
    [tasks.PATCH,"tasks",{task:{id:task.id,title:"SYNTHETIC revised task"},expectedVersion:task.version},"task"],
    [projects.PATCH,"projects",{project:{id:project.id,name:"SYNTHETIC revised project"},expectedVersion:project.version},"project"],
    [leads.PATCH,"leads",{lead:{id:lead.id,intent:"SYNTHETIC revised lead",version:lead.version}},"lead"],
    [deals.PATCH,"deals",{expectedVersion:deal.version,deal:{id:deal.id,name:"SYNTHETIC revised deal"}},"deal"]
   ];
   for(const [handler,name,body,field] of operations){const response=await replay(handler,"/api/crm/"+name,"PATCH",body);assert.ok(response.data[field].version>1);const stale=await handler(request("/api/crm/"+name,"PATCH",body));assert.equal(stale.status,409,await stale.clone().text());}
  });
  await t.test("current role, revoked session and foreign tenant deny both writes and receipt reads",async()=>{
   const foreign=await seedSalesBrowser(db),foreignBody={contact:{id:foreign.developerContactId,name:"unauthorized"},expectedVersion:1};
   assert.equal((await contacts.PATCH(request("/api/crm/contacts","PATCH",foreignBody))).status,404);
   const meta=metadata(),body={contact:{name:"SYNTHETIC authority replay",projectId:fixture.projectId,source:"Manual"}};await execute(contacts.POST,"/api/crm/contacts","POST",body,meta);
   await db.admin.query("update workspace_users set role='assistant',product_role='viewer' where id=$1",[fixture.userId]);
   assert.equal((await contacts.POST(request("/api/crm/contacts","POST",body,meta))).status,403);
   assert.equal((await reconcile(request("/api/crm/commands/reconcile","POST",{target:"/api/crm/contacts",method:"POST",body},meta))).status,403);
   await db.admin.query("update workspace_users set role='owner',product_role='novalureAdmin' where id=$1",[fixture.userId]);await db.admin.query("update auth_sessions set revoked_at=now(),revoked_reason='SYNTHETIC test' where id=$1",[sessionId]);
   assert.equal((await contacts.POST(request("/api/crm/contacts","POST",body,meta))).status,401);
   assert.equal(Number((await db.admin.query("select version from contacts where id=$1",[foreign.developerContactId])).rows[0].version),1);
  });
 }finally{await closeLocalTestPool();for(const name of names){if(original[name]===undefined)delete process.env[name];else process.env[name]=original[name]}await db.stop()}
});
