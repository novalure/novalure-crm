import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { safeSalesFetch } from "../src/lib/security/crm-safe-client";

test("G06 client reconciles a lost success using the original metadata without another write",async()=>{
 const target="/api/crm/tasks?workspaceId="+randomUUID(),init={method:"POST",body:JSON.stringify({task:{title:"SYNTHETIC lost result"}})};let writes=0,lookups=0,key="",correlation="";
 const response=await safeSalesFetch(target,init,async(path,options)=>{
  const headers=new Headers(options.headers);
  if(path===target){writes++;key=headers.get("Idempotency-Key")!;correlation=headers.get("X-Correlation-Id")!;throw Error("SYNTHETIC response lost after commit")}
  lookups++;assert.equal(headers.get("Idempotency-Key"),key);assert.equal(headers.get("X-Correlation-Id"),correlation);assert.deepEqual(JSON.parse(String(options.body)),{target,method:"POST",body:JSON.parse(init.body)});
  return Response.json({status:"COMMITTED",response:{status:200,body:{task:{id:"synthetic-task",version:1}}}});
 });
 assert.equal(writes,1);assert.equal(lookups,1);assert.equal((await response.json()).task.version,1);
});
test("G06 missing receipt stays unknown and blocks changed requests; retry is lookup only",async()=>{
 const target="/api/crm/contacts?workspaceId="+randomUUID(),init={method:"POST",body:JSON.stringify({contact:{name:"SYNTHETIC pending"}})};let writes=0,lookups=0;
 const transport=async(path:string)=>{if(path===target){writes++;return new Response("unavailable",{status:503})}lookups++;return Response.json({status:"NOT_FOUND"})};
 await assert.rejects(safeSalesFetch(target,init,transport),/CRM_RESULT_UNKNOWN/);
 await assert.rejects(safeSalesFetch(target,init,transport),/CRM_RESULT_UNKNOWN/);
 await assert.rejects(safeSalesFetch(target,{...init,body:JSON.stringify({contact:{name:"different effect"}})},transport),/CRM_RESULT_UNKNOWN/);
 assert.equal(writes,1);assert.equal(lookups,2);
});
test("G06 explicit validation rejection permits corrected intent and does not reconcile",async()=>{
 const target="/api/crm/projects?workspaceId="+randomUUID();let calls=0;const keys:string[]=[];
 const transport=async(path:string,options:RequestInit)=>{assert.equal(path,target);calls++;keys.push(new Headers(options.headers).get("Idempotency-Key")!);return Response.json({error:"validation"},{status:400})};
 await safeSalesFetch(target,{method:"POST",body:'{"project":{"name":""}}'},transport);
 await safeSalesFetch(target,{method:"POST",body:'{"project":{"name":"SYNTHETIC corrected"}}'},transport);
 assert.equal(calls,2);assert.notEqual(keys[0],keys[1]);
});

test("G06 offer retry uses original envelope even when UI creates fresh metadata",async()=>{
 const target="/api/crm/offers?workspaceId="+randomUUID(),original={operation:"queue_send",offerId:randomUUID(),payload:{},idempotencyKey:randomUUID(),correlationId:randomUUID()};let writes=0,lookups=0;
 const perform=async(path:string,options:RequestInit)=>{if(path===target){writes++;throw Error("SYNTHETIC lost")};lookups++;const query=JSON.parse(String(options.body));assert.deepEqual(query.body,original);return Response.json(lookups===1?{status:"NOT_FOUND"}:{status:"COMMITTED",response:{status:200,body:{data:{status:"QUEUED"}}}})};
 await assert.rejects(safeSalesFetch(target,{method:"POST",body:JSON.stringify(original)},perform),/CRM_RESULT_UNKNOWN/);
 const retry=await safeSalesFetch(target,{method:"POST",body:JSON.stringify({...original,idempotencyKey:randomUUID(),correlationId:randomUUID()})},perform);
 assert.equal(retry.status,200);assert.equal(writes,1);assert.equal(lookups,2);
});

test("project validator keeps an invalid 200 unknown until the original receipt becomes valid without another create",async()=>{
 const workspaceId=randomUUID(),projectId=randomUUID(),target="/api/crm/projects?workspaceId="+workspaceId;
 const body={project:{name:"SYNTHETIC validated project",workspaceId}},key=randomUUID(),correlation=randomUUID();
 const init={method:"POST",headers:{"Idempotency-Key":key,"X-Correlation-Id":correlation},body:JSON.stringify(body)};
 const invalid={persisted:true,project:{id:projectId,workspaceId:randomUUID(),name:body.project.name,version:1}};
 const valid={persisted:true,project:{id:projectId,workspaceId,name:body.project.name,version:1}};
 const calls:{path:string;method:string|undefined;body:unknown;key:string|null;correlation:string|null}[]=[],validated:unknown[]=[];
 let writes=0,lookups=0;
 const validate=async(response:Response)=>{
  const result=await response.json();validated.push(result);
  return response.ok&&result.persisted===true&&result.project?.workspaceId===workspaceId&&result.project?.id===projectId;
 };
 const perform=async(path:string,options:RequestInit)=>{
  const headers=new Headers(options.headers);
  calls.push({path,method:options.method,body:JSON.parse(String(options.body)),key:headers.get("Idempotency-Key"),correlation:headers.get("X-Correlation-Id")});
  if(path===target){writes++;return Response.json(invalid)}
  lookups++;return Response.json(lookups===1?{status:"NOT_FOUND"}:{status:"COMMITTED",response:{status:200,body:valid}});
 };
 await assert.rejects(safeSalesFetch(target,init,perform,validate),/CRM_RESULT_UNKNOWN/);
 assert.equal(writes,1);assert.equal(lookups,1);
 const recovered=await safeSalesFetch(target,init,perform,validate);
 assert.deepEqual(await recovered.json(),valid);assert.equal(writes,1);assert.equal(lookups,2);
 assert.deepEqual(validated,[invalid,valid]);
 assert.deepEqual(calls.map(call=>({path:call.path,method:call.method,body:call.body})),[
  {path:target,method:"POST",body},
  ...Array.from({length:2},()=>({path:"/api/crm/commands/reconcile?workspaceId="+workspaceId,method:"POST",body:{target,method:"POST",body}})),
 ]);
 for(const call of calls){assert.equal(call.key,key);assert.equal(call.correlation,correlation)}
});

test("project validator rejects an invalid committed receipt and keeps changed intents blocked while lookup remains possible",async()=>{
 const workspaceId=randomUUID(),projectId=randomUUID(),target="/api/crm/projects?workspaceId="+workspaceId;
 const body={project:{name:"SYNTHETIC pending validation",workspaceId}},key=randomUUID(),correlation=randomUUID();
 const init={method:"POST",headers:{"Idempotency-Key":key,"X-Correlation-Id":correlation},body:JSON.stringify(body)};
 const invalid={persisted:false,project:{id:projectId,workspaceId,name:body.project.name,version:1}};
 const valid={persisted:true,project:{id:projectId,workspaceId,name:body.project.name,version:1}};
 let writes=0,lookups=0;const calls:{path:string;body:unknown;key:string|null;correlation:string|null}[]=[],validated:unknown[]=[];
 const validate=async(response:Response)=>{
  const result=await response.json();validated.push(result);
  return response.ok&&result.persisted===true&&result.project?.workspaceId===workspaceId;
 };
 const perform=async(path:string,options:RequestInit)=>{
  const headers=new Headers(options.headers);
  calls.push({path,body:JSON.parse(String(options.body)),key:headers.get("Idempotency-Key"),correlation:headers.get("X-Correlation-Id")});
  if(path===target){writes++;throw Error("SYNTHETIC response lost after commit")}
  lookups++;return Response.json({status:"COMMITTED",response:{status:200,body:lookups<3?invalid:valid}});
 };
 await assert.rejects(safeSalesFetch(target,init,perform,validate),/CRM_RESULT_UNKNOWN/);
 await assert.rejects(safeSalesFetch(target,{...init,body:JSON.stringify({project:{...body.project,name:"SYNTHETIC changed intent"}})},perform,validate),/CRM_RESULT_UNKNOWN/);
 assert.equal(calls.length,2,"the changed intent must not issue a write or lookup");
 await assert.rejects(safeSalesFetch(target,init,perform,validate),/CRM_RESULT_UNKNOWN/);
 assert.equal(writes,1);assert.equal(lookups,2);
 const recovered=await safeSalesFetch(target,init,perform,validate);
 assert.deepEqual(await recovered.json(),valid);assert.equal(writes,1);assert.equal(lookups,3);
 assert.deepEqual(validated,[invalid,invalid,valid]);
 assert.equal(calls[0].path,target);assert.deepEqual(calls[0].body,body);
 for(const call of calls){
  assert.equal(call.key,key);assert.equal(call.correlation,correlation);
  if(call.path!==target){assert.equal(call.path,"/api/crm/commands/reconcile?workspaceId="+workspaceId);assert.deepEqual(call.body,{target,method:"POST",body})}
 }
});
