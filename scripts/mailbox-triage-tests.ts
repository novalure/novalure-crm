import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {applySalesSchema,startLocalSalesDb} from './lib/local-sales-db.mjs';
import {withCrmRead,type TenantTransaction} from '../src/lib/crm-command';
import type {AppSession} from '../src/lib/auth/session';
import type {TenantPool} from '../src/lib/db/tenant-client';
import {loadMailboxTriage,saveMailboxTriage} from '../src/lib/db/mailbox-triage-repository';
let db:Awaited<ReturnType<typeof startLocalSalesDb>>;
const w=randomUUID(),fw=randomUUID(),actor=randomUUID(),manager=randomUUID(),foreign=randomUUID(),project=randomUUID(),contact=randomUUID(),lead=randomUUID(),message=randomUUID(),linked=randomUUID(),other=randomUUID();
const options=()=>({pool:db.pool as unknown as TenantPool}),metadata=()=>({idempotencyKey:randomUUID(),correlationId:randomUUID()});
const session=(id=actor,workspace=w,role:AppSession['role']='agent',productRole:AppSession['productRole']='project_sales_member'):AppSession=>({authenticated:true,workspaceId:workspace,userId:id,name:'SYNTHETIC',workspaceName:'SYNTHETIC',email:'synthetic@example.invalid',role,productRole,permissions:[],productPermissions:[],source:'database'});
const run=<T>(work:(tx:TenantTransaction,session:AppSession)=>Promise<T>,s=session())=>withCrmRead(s,work,options());
before(async()=>{db=await startLocalSalesDb();await applySalesSchema(db,{maxMigrationNumber:106});for(const file of ['170_crm_personal_mailbox.sql','178_personal_mailbox_triage.sql'])await db.admin.query(await readFile('migrations/'+file,'utf8'));
 await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Mail triage','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')",[w,fw]);
 for(const[id,workspace,role,productRole]of[[actor,w,'agent','project_sales_member'],[manager,w,'owner','customer_owner'],[foreign,fw,'owner','customer_owner']])await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC',$3,$4,$5,'active')",[id,workspace,id+'@example.invalid',role,productRole]);
 await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC Project','Service')",[project,w]);await db.admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)',[w,project,actor]);
 await db.admin.query("insert into contacts(id,workspace_id,project_id,name,role) values($1,$2,$3,'SYNTHETIC contact','Käufer')",[contact,w,project]);await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type) values($1,$2,$3,$4,$5,'Käufer')",[lead,w,project,contact,actor]);
 for(const[user,ids]of[[actor,[message,linked]],[manager,[other]]] as const){const connection=randomUUID();await db.admin.query("insert into crm_mailbox_connections(id,workspace_id,user_id,provider,account_label,status,granted_scopes) values($1,$2,$3,'google',$4,'disconnected','[]')",[connection,w,user,user+'@example.invalid']);for(const id of ids)await db.admin.query("insert into crm_mailbox_messages(id,workspace_id,user_id,connection_id,provider_id,subject,from_label,received_at,body_text,content_hash) values($1,$2,$3,$4,$5,'SYNTHETIC enquiry','SYNTHETIC sender',now(),'SYNTHETIC private body',$6)",[id,w,user,connection,id,'a'.repeat(64)]);}
 await run(tx=>tx.query("insert into crm_mailbox_links(workspace_id,user_id,message_id,project_id,lead_id,contact_id,review_reason) values($1,$2,$3,$4,$5,$6,'SYNTHETIC personally checked association')",[w,actor,linked,project,lead,contact]));
});
after(async()=>{if(db)await db.stop();});
test('personal work queue shows only own imported copies, exact project associations, and no message bodies',async()=>{
 const all=await run(load=>loadMailboxTriage(load,session(),null));assert.equal(all.total,2);assert.ok(all.items.every(item=>item.status==='unreviewed'&&item.revision===0));assert.doesNotMatch(JSON.stringify(all),/private body/);
 const scoped=await run((tx,fresh)=>loadMailboxTriage(tx,fresh,project));assert.deepEqual(scoped.items.map(item=>item.id),[linked]);assert.equal(scoped.items[0].leadId,lead);
 const ownManager=await run((tx,fresh)=>loadMailboxTriage(tx,fresh,null),session(manager,w,'owner','customer_owner'));assert.deepEqual(ownManager.items.map(item=>item.id),[other]);
 assert.equal((await run((tx,fresh)=>loadMailboxTriage(tx,fresh,null),session(foreign,fw,'owner','customer_owner'))).total,0);
});
test('manual state changes are atomic, versioned, replay-safe and never claim a send',async()=>{
 const input={messageId:message,status:'needs_reply' as const,expectedRevision:0},meta=metadata(),first=await saveMailboxTriage(session(),input,meta,options()),replay=await saveMailboxTriage(session(),input,meta,options());assert.equal(first.data.sent,false);assert.equal(replay.replayed,true);assert.equal(first.data.revision,1);
 const results=await Promise.allSettled([saveMailboxTriage(session(),{messageId:message,status:'waiting',expectedRevision:1},metadata(),options()),saveMailboxTriage(session(),{messageId:message,status:'done',expectedRevision:1},metadata(),options())]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 const history=await run(tx=>tx.query('select revision,status from crm_mailbox_triage_history where message_id=$1 order by revision',[message]));assert.equal(history.length,2);assert.deepEqual(history.map(item=>item.revision),[1,2]);
 await assert.rejects(run(tx=>tx.execute("update crm_mailbox_triage_history set status='done' where message_id=$1",[message])));
});
test('handled entries leave open work and can be deliberately reopened; deleted copies cannot replay a state change',async()=>{
 const input={messageId:linked,status:'done' as const,expectedRevision:0},meta=metadata();await saveMailboxTriage(session(),input,meta,options());assert.equal((await run((tx,fresh)=>loadMailboxTriage(tx,fresh,project))).total,0);assert.equal((await run((tx,fresh)=>loadMailboxTriage(tx,fresh,project,true))).total,1);
 await saveMailboxTriage(session(),{messageId:linked,status:'needs_reply',expectedRevision:1},metadata(),options());assert.equal((await run((tx,fresh)=>loadMailboxTriage(tx,fresh,project))).items[0].status,'needs_reply');
 await db.admin.query('update crm_mailbox_messages set deleted_at=now() where id=$1',[linked]);await assert.rejects(saveMailboxTriage(session(),input,meta,options()),/Nachricht nicht verfügbar/);
});
test('another personal owner and withdrawn project rights cannot change or reveal the linked work state',async()=>{
 await assert.rejects(saveMailboxTriage(session(manager,w,'owner','customer_owner'),{messageId:message,status:'done',expectedRevision:2},metadata(),options()),/Nachricht nicht verfügbar/);
 await db.admin.query('update crm_mailbox_messages set deleted_at=null where id=$1',[linked]);await db.admin.query('update project_pipeline_permissions set can_read=false,can_edit_deals=false where user_id=$1',[actor]);
 await assert.rejects(run((tx,fresh)=>loadMailboxTriage(tx,fresh,project)));assert.equal((await run((tx,fresh)=>loadMailboxTriage(tx,fresh,null))).items.some(item=>item.id===linked),false);
 await assert.rejects(saveMailboxTriage(session(),{messageId:linked,status:'done',expectedRevision:2},metadata(),options()));
});
