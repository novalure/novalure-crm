import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantTransaction } from "../src/lib/db/tenant-client";
import { runWithTenantTransaction } from "../src/lib/db/transaction-context";
import { loadContactMailboxReview } from "../src/lib/db/crm-mailbox-sync-repository";

// Application-boundary tests only: these fakes do not execute SQL or prove
// PostgreSQL RLS, concurrent access, provider identity or actual suppression.
const workspaceId="11111111-1111-4111-8111-111111111111",userId="22222222-2222-4222-8222-222222222222",contactId="33333333-3333-4333-8333-333333333333";
const session:AppSession={authenticated:true,source:"cookie",workspaceId,userId,authIdentityId:"44444444-4444-4444-8444-444444444444",authSessionId:"55555555-5555-4555-8555-555555555555",workspaceName:"Synthetic",name:"Synthetic",email:"owner@example.invalid",role:"owner",productRole:"customer_owner",permissions:["crm:read"],productPermissions:[]};
const items=Array.from({length:11},(_,i)=>({id:`message-${i}`,subject:`Synthetic ${i}`,receivedAt:"2026-01-01T00:00:00Z"}));
function fake(projectId:string|null|false=null,locked=true){
 const calls:{sql:string;params:readonly unknown[]}[]=[];
 const tx={
  async queryOne(sql:string,params:readonly unknown[]=[]){calls.push({sql,params});return projectId===false?null:sql.includes("for share of c")?(locked?{id:contactId}:null):{projectId};},
  async query(sql:string,params:readonly unknown[]=[]){calls.push({sql,params});return items;},
  async execute(){throw new Error("No write is permitted");},
 } as unknown as TenantTransaction;
 return {tx,calls};
}
const scoped=<T>(tx:TenantTransaction,operation:()=>Promise<T>)=>runWithTenantTransaction({workspaceId,actorId:userId},tx,operation);

test("personal projectless address hints expose at most ten private copies with no write",async()=>{
 const {tx,calls}=fake();
 const result=await scoped(tx,()=>loadContactMailboxReview(tx,session,contactId));
 assert.equal(result.available,true);assert.ok("source" in result);assert.equal(result.source,"personal_imported_address_match");assert.equal(result.items.length,10);assert.equal(result.hasMore,true);
 assert.equal(calls.length,3);assert.deepEqual(calls[1].params,[workspaceId,contactId,userId]);assert.deepEqual(calls[2].params,[workspaceId,userId,contactId]);
 assert.doesNotMatch(calls[2].sql,/\b(insert|update|delete)\b/i);
});
test("an unauthenticated, header, service or invalid personal session never performs the private message query",async()=>{
 for(const change of [{source:"header"},{authenticated:false},{serviceIdentity:{id:"synthetic"}},{authSessionId:null},{authIdentityId:null}] as const){
  const {tx,calls}=fake();
  await assert.rejects(scoped(tx,()=>loadContactMailboxReview(tx,{...session,...change} as unknown as AppSession,contactId)));
  assert.ok(calls.length<=1);assert.ok(!calls.some(call=>/join crm_mailbox_messages/.test(call.sql)));
 }
});
test("projectless messages require the same scoped transaction and an existing visible contact",async()=>{
 const one=fake();await assert.rejects(loadContactMailboxReview(one.tx,session,contactId),/Arbeitsbereich/);assert.equal(one.calls.length,1);
 const two=fake(false);await assert.rejects(scoped(two.tx,()=>loadContactMailboxReview(two.tx,session,contactId)),/Kontakt/);assert.equal(two.calls.length,1);
});
test("a contact that is no longer accessible after locking does not reach the message query",async()=>{
 const {tx,calls}=fake(null,false);
 await assert.rejects(scoped(tx,()=>loadContactMailboxReview(tx,session,contactId)),/Kontakt/);
 assert.equal(calls.length,2);assert.ok(!calls.some(call=>/join crm_mailbox_messages/.test(call.sql)));
});
