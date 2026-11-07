// Actual mounted component, synthetic HTTP only; no API/auth/database/provider acceptance.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const repository=resolve(".");
const root=await mkdtemp(join(tmpdir(),"crm-grant-ui-"));
const ids={workspace:"11111111-1111-4111-8111-111111111111",project:"22222222-2222-4222-8222-222222222222",access:"33333333-3333-4333-8333-333333333333",a:"44444444-4444-4444-8444-444444444444",b:"55555555-5555-4555-8555-555555555555"};
function install(payload,ids){
 const pending=[],calls=[],csrf=[];
 const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
 window.syntheticGrant={inspect:()=>({pending:pending.map(p=>p.scope),calls,csrf}),release:(index,overrides={})=>{
  const request=pending[index];
  request.resolve(json({source:"database",state:{version:"customer-project-grant-state-v1",...request.scope,digest:(request.scope.userId===ids.a?"a":"b").repeat(64),projectionOwnership:"missing",activeOtherGrantCount:0,current:{accessLevel:"viewer",projectRole:"agent",status:"suspended",canViewProject:false,canEditProject:false,canViewContacts:false,canExportData:false},...overrides}}));
 }};
 window.fetch=async(input,init={})=>{
  const url=new URL(String(input),location.href),method=init.method??"GET";
  if(url.origin!==location.origin)throw Error("External fetch forbidden");
  if(url.pathname==="/api/auth/csrf") {const token=`synthetic-csrf-${csrf.length}`;csrf.push(token);return json({csrfToken:token});}
  if(url.pathname!=="/api/crm/customer-access")throw Error("Unexpected API path");
  if(method==="GET"&&url.searchParams.get("operation")==="project_grant_state")return new Promise(resolve=>pending.push({resolve,scope:{accessId:url.searchParams.get("accessId"),projectId:url.searchParams.get("targetProjectId"),userId:url.searchParams.get("userId")}}));
  if(method==="GET")return json(structuredClone(payload));
  if(method!=="PATCH")throw Error("Unexpected mutation");
  const headers=new Headers(init.headers);
  calls.push({body:JSON.parse(init.body),key:headers.get("idempotency-key"),correlation:headers.get("x-correlation-id"),csrf:headers.get("x-novalure-csrf-token")});
  // A lost/unknown response must keep the same command identity on manual retry.
  return calls.length===1?json({error:"SYNTHETIC unknown outcome"},503):json({payload:structuredClone(payload),persisted:true});
 };
}
let browser,server;
const errors=[],blocked=[];
try{
 await mkdir(root,{recursive:true});
 const entry=`import {createRoot} from "react-dom/client";
 import {CustomerAccessCockpit} from ${JSON.stringify(join(repository,"src/components/customer-access-cockpit.tsx"))};
 import {customerWorkspaceAccess,projects,users} from ${JSON.stringify(join(repository,"src/lib/crm-data.ts"))};
 const ids=${JSON.stringify(ids)};
 const payload={source:"database",audits:[],grants:[],projects:[{...projects[0],id:ids.project,workspaceId:ids.workspace,name:"SYNTHETIC project"}],customerAccess:[{...customerWorkspaceAccess[0],id:ids.access,workspaceId:ids.workspace,projectId:ids.project,ownerUserId:ids.a,customerName:"SYNTHETIC customer",risks:[]}],users:[{...users[0],id:ids.a,workspaceId:ids.workspace,name:"SYNTHETIC A",email:"a@example.invalid",role:"agent",productRole:"project_sales_member",status:"active"},{...users[0],id:ids.b,workspaceId:ids.workspace,name:"SYNTHETIC B",email:"b@example.invalid",role:"agent",productRole:"project_sales_member",status:"active"}]};
 (${install.toString()})(payload,ids);
 createRoot(document.getElementById("root")).render(<CustomerAccessCockpit language="en" projectLabel="SYNTHETIC" activeProjectId={ids.project} customerAccess={[]} users={[]} projects={[]}/>);`;
 await build({stdin:{contents:entry,loader:"tsx",resolveDir:repository,sourcefile:"synthetic-grant.tsx"},absWorkingDir:repository,bundle:true,platform:"browser",format:"iife",jsx:"automatic",tsconfig:join(repository,"tsconfig.json"),define:{"process.env.NODE_ENV":'"production"'},outfile:join(root,"fixture.js"),logLevel:"silent"});
 await writeFile(join(root,"index.html"),'<!doctype html><html><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script></html>');
 const [html,bundle]=await Promise.all([readFile(join(root,"index.html")),readFile(join(root,"fixture.js"))]);
 server=createServer((request,response)=>{const path=new URL(request.url,"http://127.0.0.1").pathname;if(path==="/"||path==="/fixture.js"){response.writeHead(200,{"content-type":path==="/"?"text/html":"text/javascript"});response.end(path==="/"?html:bundle);}else{response.writeHead(204);response.end();}});
 server.listen(0,"127.0.0.1");await once(server,"listening");
 const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.CRM_QA_CHROMIUM_PATH?{executablePath:process.env.CRM_QA_CHROMIUM_PATH}:{})});
 const context=await browser.newContext({serviceWorkers:"block"});
 await context.route("**/*",route=>{const url=new URL(route.request().url());if(url.origin===origin&&["/","/fixture.js","/favicon.ico"].includes(url.pathname))return route.continue();blocked.push(url.pathname);return route.abort();});
 const page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));await page.goto(origin);
 const inspect=()=>page.evaluate(()=>window.syntheticGrant.inspect());
 const section=page.getByRole("heading",{name:"Workspace and project access",exact:true}).locator("..");
 const save=section.getByRole("button",{name:"Save access",exact:true});
 await expect.poll(async()=>(await inspect()).pending.length).toBe(1);await expect(save).toBeDisabled();
 await section.getByRole("combobox",{name:"User",exact:true}).selectOption(ids.b);
 await expect.poll(async()=>(await inspect()).pending.length).toBe(2);await expect(save).toBeDisabled();
 await page.evaluate(()=>window.syntheticGrant.release(1));await expect(save).toBeEnabled();
 await page.evaluate(()=>window.syntheticGrant.release(0,{current:{accessLevel:"admin",projectRole:"owner",status:"active",canViewProject:true,canEditProject:true,canViewContacts:true,canExportData:true}}));
 await expect(section.getByRole("combobox",{name:"User",exact:true})).toHaveValue(ids.b);
 await expect(section.getByRole("checkbox",{name:"View project",exact:true})).not.toBeChecked();
 await save.click();await expect(save).toBeEnabled();await save.click();
 await expect.poll(async()=>(await inspect()).calls.length).toBe(2);
 const state=await inspect();
 assert.equal(state.calls[0].body.userId,ids.b);assert.equal(state.calls[0].body.expectedStateDigest,"b".repeat(64));
 assert.equal(state.calls[0].key,state.calls[1].key);assert.equal(state.calls[0].correlation,state.calls[1].correlation);assert.notEqual(state.calls[0].csrf,state.calls[1].csrf);assert.deepEqual(state.calls[0].body,state.calls[1].body);
 await expect.poll(async()=>(await inspect()).pending.length).toBe(3);await expect(save).toBeDisabled();
 await page.evaluate(()=>window.syntheticGrant.release(2,{projectionOwnership:"independent"}));await expect(save).toBeDisabled();await expect(section.getByRole("alert")).toBeVisible();
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 console.log(JSON.stringify({classification:"LOCAL_UI_WITH_STUBBED_HTTP_NOT_AUTH_OR_PROVIDER_ACCEPTANCE",passed:4,failed:0,cases:["pending snapshot disables writes","late selection response ignored","unknown retry preserves command identity with fresh CSRF","payload refresh and independent source block writes"],browserErrors:errors.length,unexpectedNetwork:blocked.length}));
 await context.close();
}finally{
 if(browser)await browser.close();
 if(server)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 const resolved=resolve(root);assert.ok(resolved.startsWith(resolve(tmpdir())+"\\")||resolved.startsWith(resolve(tmpdir())+"/"));
 await rm(resolved,{recursive:true,force:true});
}
