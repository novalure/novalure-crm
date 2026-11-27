import assert from 'node:assert/strict';
import test from 'node:test';
import type {AppSession} from '../src/lib/auth/session';
import type {TenantTransaction} from '../src/lib/db/tenant-client';
import {mailboxAutoControls,mailboxConnectionPresentation,mailboxConnectionPresentationLabel,mailboxPresentationWhileUncertain,microsoftMailboxBindingReady} from '../src/lib/crm-mailbox';
import {applyMailboxView,createMailboxViewFence} from '../src/lib/mailbox-view-fence';
import {loadCrmMailbox} from '../src/lib/db/crm-mailbox-repository';
import {saveMailboxAutoSettings} from '../src/lib/db/crm-mailbox-sync-repository';

const base={provider:'microsoft' as const,status:'connected',scopes:['Mail.Read','User.Read'],verifiedMicrosoft:true,microsoftBindingReady:true,hasSubject:true,hasAccountId:true,checkPending:false};
test('presentations never call stored permission or an unfinished check a provider confirmation',()=>{
 assert.equal(mailboxConnectionPresentation(base),'configured');
 assert.equal(mailboxConnectionPresentation({...base,checkPending:true}),'check_unconfirmed');
 assert.equal(mailboxConnectionPresentation({...base,scopes:['Mail.Read','Mail.Send'],checkPending:true}),'scope_review');
 assert.equal(mailboxConnectionPresentation({...base,scopes:['Mail.ReadWrite']}),'scope_review');
 assert.equal(mailboxConnectionPresentation({...base,scopes:null}),'scope_review');
 assert.equal(mailboxConnectionPresentation({...base,status:'reauthorization_required'}),'not_connected');
 assert.equal(mailboxConnectionPresentation({...base,verifiedMicrosoft:false,scopes:['Mail.ReadWrite']}),'extra_permissions');
 assert.equal(mailboxConnectionPresentation({...base,verifiedMicrosoft:false,scopes:['Mail.Read','Mail.Send']}),'extra_permissions');
 assert.equal(mailboxConnectionPresentation({...base,verifiedMicrosoft:false,scopes:['Mail.Read','Mail.Send'],checkPending:true}),'extra_permissions_check_unconfirmed');
 assert.equal(mailboxConnectionPresentation({...base,microsoftBindingReady:false}),'binding_review');
 assert.equal(microsoftMailboxBindingReady(true,true,false,true),false);
 assert.equal(microsoftMailboxBindingReady(true,true,true,false),false);
 assert.equal(microsoftMailboxBindingReady(true,false,false,false),false);
 assert.equal(microsoftMailboxBindingReady(false,false,false,false),true);
 assert.equal(microsoftMailboxBindingReady(null,true,true,true),false);
 assert.equal(mailboxPresentationWhileUncertain('extra_permissions',true),'extra_permissions_check_unconfirmed');
 assert.equal(mailboxConnectionPresentationLabel('configured',true),'Verbindung eingerichtet');
 assert.equal(mailboxConnectionPresentationLabel('check_unconfirmed',true),'Abgleich nicht bestätigt');
 assert.equal(mailboxConnectionPresentationLabel('scope_review',false),'Review mail permissions');
});

test('a delayed older read cannot restore a discarded state after an action fails',async()=>{
 const fence=createMailboxViewFence();let resolve!:(value:string)=>void;const delayed=new Promise<string>(done=>{resolve=done;});
 let shown='initial';const old=fence.begin();const oldRead=applyMailboxView(fence,old,delayed,value=>{shown=value;});
 fence.begin();fence.invalidate();shown='unconfirmed';resolve('stale configured result');await oldRead;
 assert.equal(shown,'unconfirmed');
 const current=fence.begin();await applyMailboxView(fence,current,Promise.resolve('fresh result'),value=>{shown=value;});assert.equal(shown,'fresh result');
});

test('disconnected or review-required automatic checking can be turned off without permitting reactivation',()=>{
 for(const needsReview of [false,true]){
  const before=mailboxAutoControls({connected:false,needsReview,enabled:true,settingEnabled:true,disabled:false});
  assert.equal(before.canToggle,true);assert.equal(before.canSave,false);assert.equal(before.canSync,false);
  const after=mailboxAutoControls({connected:false,needsReview,enabled:false,settingEnabled:true,disabled:false});
  assert.equal(after.canSave,true);assert.equal(after.canToggle,false);assert.equal(after.canSync,false);
 }
});

test('mailbox reader projects stored scopes and an active wall-clock lease without writes',async()=>{
 const queries:string[]=[];
 const fake={
  query:async(sql:string)=>{queries.push(sql); if(sql.includes('from crm_mailbox_connections c')) return [{id:'synthetic-1',...base,checkPending:true},{id:'synthetic-2',...base,scopes:['Mail.Read','Mail.Send']},{id:'synthetic-3',...base,hasSubject:false},{id:'synthetic-4',...base,verifiedMicrosoft:false}]; return [];},
  queryOne:async(sql:string)=>{queries.push(sql);if(sql.includes("to_regclass('public.crm_mailbox_auto_settings')"))return {ready:false};throw new Error('unexpected query');},
 } as unknown as TenantTransaction;
 const session={authenticated:true,workspaceId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',permissions:[],productRole:'customer_owner',source:'database'} as unknown as AppSession;
 const keys=['MICROSOFT_MAILBOX_CLIENT_ID','MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD','MICROSOFT_MAILBOX_CLIENT_SECRET','MICROSOFT_MAILBOX_IDENTITY_MODE','MICROSOFT_MAILBOX_ALLOW_LEGACY','MICROSOFT_CLIENT_ID','VERCEL','VERCEL_ENV'] as const;
 const saved=new Map(keys.map(key=>[key,process.env[key]]));
 try{
  for(const key of keys)delete process.env[key];Object.assign(process.env,{MICROSOFT_MAILBOX_CLIENT_ID:'synthetic-mail',MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD:'client-secret',MICROSOFT_MAILBOX_CLIENT_SECRET:'synthetic-secret',MICROSOFT_MAILBOX_IDENTITY_MODE:'verified-preview',VERCEL:'1',VERCEL_ENV:'preview'});
  const result=await loadCrmMailbox(fake,session);
  assert.deepEqual(result.connections.map(row=>row.presentation),['check_unconfirmed','scope_review','binding_review','binding_review']);
  assert.ok(queries.some(sql=>sql.includes('coalesce(c.sync_lease_until>clock_timestamp(),false) as "checkPending"')));
  assert.ok(!queries.some(sql=>sql.includes("sync_lease_until is not null")||sql.includes("r.status='running'")));
  assert.ok(!queries.some(sql=>/^\s*(insert|update|delete)\b/i.test(sql)));
 }finally{for(const key of keys){const value=saved.get(key);if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('an overprivileged verified connection cannot enable automatic checking but can be disabled',async()=>{
 const keys=['MICROSOFT_MAILBOX_CLIENT_ID','MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD','MICROSOFT_MAILBOX_CLIENT_SECRET','MICROSOFT_MAILBOX_IDENTITY_MODE','MICROSOFT_MAILBOX_ALLOW_LEGACY','MICROSOFT_CLIENT_ID','VERCEL','VERCEL_ENV'] as const;
 const saved=new Map(keys.map(key=>[key,process.env[key]]));
 const session={authenticated:true,workspaceId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',permissions:[],productRole:'customer_owner',source:'database'} as unknown as AppSession;
 const connectionId='33333333-3333-4333-8333-333333333333';const statements:string[]=[];
 const fake={
  queryOne:async(sql:string)=>{statements.push(sql);if(sql.includes("to_regclass('public.crm_mailbox_auto_settings')"))return {ready:true};if(sql.includes('from crm_mailbox_connections'))return {id:connectionId,connected:true,provider:'microsoft',tenantId:'55555555-5555-4555-8555-555555555555',subject:'synthetic',accountId:'synthetic',scopes:['Mail.Read','Mail.Send']};if(sql.includes('crm_lock_active_member'))return {id:'44444444-4444-4444-8444-444444444444'};if(sql.includes('to_regprocedure'))return {ready:false};if(sql.includes('select revision,'))return {revision:0,contactReview:false};if(sql.includes('insert into crm_mailbox_auto_settings'))return {revision:1,enabled:false,status:'disabled'};throw new Error('unexpected query');},
  query:async(sql:string)=>{statements.push(sql);return [];},
 } as unknown as TenantTransaction;
 try{
  for(const key of keys)delete process.env[key];Object.assign(process.env,{MICROSOFT_MAILBOX_CLIENT_ID:'synthetic-mail',MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD:'client-secret',MICROSOFT_MAILBOX_CLIENT_SECRET:'synthetic-secret',MICROSOFT_MAILBOX_IDENTITY_MODE:'verified-preview',VERCEL:'1',VERCEL_ENV:'preview'});
  await assert.rejects(saveMailboxAutoSettings(fake,session,{connectionId,enabled:true,autoFile:false,expectedRevision:0}),/Nur Postfach-Lesezugriff/);
  assert.ok(!statements.some(sql=>/^\s*(insert|update|delete)\b/i.test(sql)));
  const result=await saveMailboxAutoSettings(fake,session,{connectionId,enabled:false,autoFile:false,expectedRevision:0});
  assert.equal(result?.enabled,false);assert.ok(!statements.some(sql=>/token_encrypted/i.test(sql)));
 }finally{for(const key of keys){const value=saved.get(key);if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
