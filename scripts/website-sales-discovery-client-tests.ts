import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { discoveryPending, parseDiscoveryImport, registerDiscovery, retryDiscoveryOriginal } from "../src/lib/website-sales-discovery-client";
import type { WebsiteSalesDiscoveryRegister } from "../src/lib/website-sales-discovery";
function canonical(value: unknown): string { if(value===null||typeof value!=="object")return JSON.stringify(value)??"null";if(Array.isArray(value))return`[${value.map(canonical).join(",")}]`;const row=value as Record<string,unknown>;return`{${Object.keys(row).sort((a,b)=>a.localeCompare(b)).filter(key=>row[key]!==undefined).map(key=>`${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`; }
const digest=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
test("browser discovery reconciliation is read-only, exact-original and durable across reload/expiry", async t=>{
  const workspace=randomUUID(),actor=randomUUID(),project=randomUUID(),company=randomUUID(),location=randomUUID();
  const quote="Sourced Company. 1 Test Street, Dublin, Ireland";
  const command:WebsiteSalesDiscoveryRegister={contractVersion:"website-sales-discovery-v1",operation:"register",projectId:project,
    candidate:{candidateId:randomUUID(),countryCode:"IE",companyName:"Sourced Company",locationLabel:"1 Test Street, Dublin, Ireland",address:"1 Test Street, Dublin, Ireland",domain:null,contacts:[],
      sourceReferences:[{sourceId:"source",sourceUrl:"https://example.invalid/source",contentDigest:"a".repeat(64),quote,observedAt:"2020-01-01T00:00:00Z",validUntil:"2020-01-02T00:00:00Z"}]},
    expectedMatchDigest:"b".repeat(64),decision:{companyId:null,locationId:null,contactId:null,createCompany:true,createContact:false,reviewed:true,reason:"Reviewed exact public identity source"},idempotencyKey:randomUUID(),correlationId:randomUUID()};
  const key=`novalure.website-sales-discovery.pending.v1:${actor}:${workspace}`, storage=new Map<string,string>(), requests:Record<string,unknown>[]=[];
  const previous=Object.getOwnPropertyDescriptor(globalThis,"window"), realFetch=globalThis.fetch;
  Object.defineProperty(globalThis,"window",{configurable:true,value:{location:{href:"http://127.0.0.1:3190/",origin:"http://127.0.0.1:3190"},sessionStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)}}});
  let mode:"committed"|"missing"|"tampered"="committed";
  const receipt=()=>({contractVersion:command.contractVersion,workspaceId:workspace,projectId:project,correlationId:command.correlationId,persisted:true,replayed:true,commandId:randomUUID(),auditReference:randomUUID(),
    data:{candidateDigest:digest(command.candidate),candidate:command.candidate,decision:command.decision,identity:{workspaceId:workspace,projectId:project,companyId:company,locationId:location},contactId:null,locationVersion:1,existingLeads:[],canContact:false}});
  globalThis.fetch=async(input,init)=>{
    if(String(input).startsWith("/api/auth/csrf"))return Response.json({csrfToken:"synthetic-one-use-token"});
    const body=JSON.parse(String(init?.body));requests.push(body);
    if(mode==="missing")return Response.json({contractVersion:command.contractVersion,workspaceId:workspace,projectId:project,correlationId:command.correlationId,persisted:false,status:"NOT_FOUND"});
    const result=receipt();if(mode==="tampered")result.data.candidateDigest="c".repeat(64);
    return Response.json({...result,...(body.operation==="reconcile"?{status:"COMMITTED"}:{})});
  };
  try{
    await t.test("expired source does not prevent pure original reconciliation",async()=>{storage.set(key,JSON.stringify(command));const result=await registerDiscovery(workspace,actor);assert.equal(result.identity.companyId,company);assert.deepEqual(requests.map(request=>request.operation),["reconcile"]);assert.equal(discoveryPending(workspace,actor),null);});
    await t.test("NOT_FOUND never writes and retains original until an explicit separate retry",async()=>{storage.set(key,JSON.stringify(command));requests.length=0;mode="missing";await assert.rejects(registerDiscovery(workspace,actor),{code:"DISCOVERY_NOT_FOUND",outcome:"UNKNOWN"});assert.deepEqual(requests.map(request=>request.operation),["reconcile"]);assert.equal(discoveryPending(workspace,actor)?.idempotencyKey,command.idempotencyKey);mode="committed";await retryDiscoveryOriginal(workspace,actor);assert.deepEqual(requests[1],command);assert.equal(storage.has(key),false);});
    await t.test("tampered candidate digest leaves outcome UNKNOWN and original intact",async()=>{storage.set(key,JSON.stringify(command));mode="tampered";await assert.rejects(registerDiscovery(workspace,actor),{code:"DISCOVERY_RECEIPT_INVALID",outcome:"UNKNOWN"});assert.equal(storage.get(key),JSON.stringify(command));});
    await t.test("invalid recovery and foreign workspace imports fail closed",async()=>{storage.set(key,"broken-json");await assert.rejects(registerDiscovery(workspace,actor));assert.equal(storage.get(key),"broken-json");assert.throws(()=>parseDiscoveryImport(JSON.stringify({workspaceId:randomUUID(),projectId:project,candidates:[command.candidate]}),{workspaceId:workspace,projectId:project}),/SCOPE_MISMATCH/);assert.throws(()=>parseDiscoveryImport(" ".repeat(65537)),/TOO_LARGE/);});
  }finally{globalThis.fetch=realFetch;if(previous)Object.defineProperty(globalThis,"window",previous);else Reflect.deleteProperty(globalThis,"window");}
});
