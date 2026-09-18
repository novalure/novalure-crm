import assert from "node:assert/strict";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {test} from "node:test";
import {startLocalSalesDb,applySalesSchema} from "./lib/local-sales-db.mjs";
import {seedSalesBrowser} from "./lib/sales-browser-fixture.mjs";
import {createCsrfToken} from "../src/lib/security/csrf-core";
import {closeLocalTestPool} from "../src/lib/db/local-test-transport";
import * as contacts from "../src/app/api/crm/contacts/route";
import * as tasks from "../src/app/api/crm/tasks/route";
import * as projects from "../src/app/api/crm/projects/route";
import * as leads from "../src/app/api/crm/leads/route";
import * as deals from "../src/app/api/crm/deals/route";
import * as stages from "../src/app/api/crm/deals/[dealId]/stage/route";
import {POST as reconcile} from "../src/app/api/crm/commands/reconcile/route";
type Handler=(request:Request)=>Promise<Response>;
test("G06 actual cookie/CSRF routes: six areas, exact replay, current authority and tenant isolation",{timeout:240000},async t=>{
 const db=await startLocalSalesDb();const names=["DATABASE_URL","NODE_ENV","CRM_LOCAL_TEST_DATABASE","NOVALURE_SESSION_SECRET","NOVALURE_APP_ORIGIN","NOVALURE_AUTH_STRICT","NOVALURE_AUTH_ENCRYPTION_KEY","NOVALURE_AUTH_RATE_LIMIT_SECRET"];
 const original=Object.fromEntries(names.map(key=>[key,process.env[key]]));
 try{
  await applySalesSchema(db);const fixture=await seedSalesBrowser(db),secret=randomBytes(48).toString("base64url"),origin="http://127.0.0.1:3000";
  Object.assign(process.env,{DATABASE_URL:"postgresql://"+db.role+"@127.0.0.1:"+db.port+"/postgres",NODE_ENV:"test",CRM_LOCAL_TEST_DATABASE:"1",NOVALURE_SESSION_SECRET:secret,NOVALURE_APP_ORIGIN:origin,NOVALURE_AUTH_STRICT:"1",NOVALURE_AUTH_ENCRYPTION_KEY:randomBytes(40).toString("hex"),NOVALURE_AUTH_RATE_LIMIT_SECRET:randomBytes(40).toString("hex")});
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
  await t.test("task/project/lead/deal creates and stage change each return one durable result",async()=>{
   task=(await replay(tasks.POST,"/api/crm/tasks","POST",{task:{title:"SYNTHETIC route task",projectId:fixture.projectId,contactId:contact.id}})).data.task;
   project=(await replay(projects.POST,"/api/crm/projects","POST",{project:{name:"SYNTHETIC route project"}})).data.project;
   lead=(await replay(leads.POST,"/api/crm/leads","POST",{lead:{contactId:contact.id,projectId:fixture.projectId,type:"Bauträger",source:"Manual",intent:"SYNTHETIC service inquiry"}})).data.lead;
   deal=(await replay(deals.POST,"/api/crm/deals","POST",{deal:{contactId:contact.id,leadId:lead.id,projectId:fixture.projectId,name:"SYNTHETIC route deal",stage:"Neu",value:"9900",expectedCloseDate:"2030-12-31"}})).data.deal;
   const path="/api/crm/deals/"+deal.id+"/stage",context={params:Promise.resolve({dealId:deal.id})};
   deal=(await replay(req=>stages.POST(req,context),path,"POST",{toStage:"Qualifizieren",expectedVersion:deal.version})).data.deal;
   assert.equal(Number((await db.admin.query("select count(*) from deal_stage_history where deal_id=$1 and to_stage='Qualifizieren'",[deal.id])).rows[0].count),1);
  });
  await t.test("CAS updates replay without version increment; stale intent cannot overwrite",async()=>{
   const operations:Array<[Handler,string,Record<string,unknown>,string]>=[
    [contacts.PATCH,"contacts",{contact:{id:contact.id,name:"SYNTHETIC revised contact"},expectedVersion:contact.version},"contact"],
    [tasks.PATCH,"tasks",{task:{id:task.id,title:"SYNTHETIC revised task"},expectedVersion:task.version},"task"],
    [projects.PATCH,"projects",{project:{id:project.id,name:"SYNTHETIC revised project"},expectedVersion:project.version},"project"],
    [leads.PATCH,"leads",{lead:{id:lead.id,intent:"SYNTHETIC revised lead",version:lead.version}},"lead"],
    [deals.PATCH,"deals",{deal:{id:deal.id,name:"SYNTHETIC revised deal",version:deal.version}},"deal"]
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
