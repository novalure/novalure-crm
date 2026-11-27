import assert from 'node:assert/strict';
import {test} from 'node:test';
import {emptyMailboxCheckpoint} from '../src/lib/crm-mailbox-sync';
import {fetchMailboxInboxId,fetchMailboxKnownContent,fetchMailboxMetadata,fetchMailboxSyncPage} from '../src/lib/integrations/mailbox-sync-provider';
import {MailboxProviderError, type MailboxTransport} from '../src/lib/integrations/mailbox-provider';

const inbox='synthetic-inbox-id';
const messageId='synthetic-message-id';
const message=(parentFolderId: unknown)=>({
 id:messageId,conversationId:'synthetic-thread',subject:'Synthetic',
 receivedDateTime:'2026-11-25T12:00:00.000Z',parentFolderId,
 from:{emailAddress:{address:'sender@example.invalid'}},toRecipients:[],ccRecipients:[],internetMessageHeaders:[],
});
const respond=(value: unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const invalidFolder=(error:unknown)=>error instanceof MailboxProviderError && error.code==='MAIL_INVALID_FOLDER_ID';

test('invalid Graph inbox identity and continuation have typed, bounded errors',async()=>{
 await assert.rejects(fetchMailboxInboxId('SYNTHETIC',async()=>respond({id:'synthetic malformed folder id'})),invalidFolder);
 let calls=0;
 const transport:MailboxTransport=async()=>{
  calls++;
  return respond({value:[],'@odata.nextLink':'synthetic malformed cursor'});
 };
 await assert.rejects(fetchMailboxSyncPage('microsoft','SYNTHETIC',emptyMailboxCheckpoint(),transport,inbox),
  (error:unknown)=>error instanceof MailboxProviderError && error.code==='MAIL_INVALID_DELTA_CURSOR' && error.status===undefined);
 assert.equal(calls,1);
});

test('Microsoft marks folder movement only for valid, case-sensitive parent and inbox IDs',async()=>{
 const run=(parent:unknown)=>fetchMailboxMetadata('microsoft','SYNTHETIC',messageId,async()=>respond(message(parent)),inbox);
 assert.equal((await run(inbox))?.inInbox,true);
 assert.equal((await run('synthetic-archive-id'))?.inInbox,false);
 assert.equal((await run('SYNTHETIC-INBOX-ID'))?.inInbox,false);
 for(const value of [undefined,null,'',false,0,{},'has space','line\nbreak','x'.repeat(1025)])
  await assert.rejects(run(value),invalidFolder);
});

test('Microsoft refuses missing or malformed inbox identity before provider I/O',async()=>{
 let calls=0;
 const transport:MailboxTransport=async()=>{calls++;return respond(message(inbox));};
 for(const value of [undefined,'','white space','x'.repeat(1025)])
  await assert.rejects(fetchMailboxMetadata('microsoft','SYNTHETIC',messageId,transport,value),invalidFolder);
 assert.equal(calls,0);
});

test('Microsoft preserves 404 and mismatched-message handling',async()=>{
 const missing:MailboxTransport=async()=>new Response('{}',{status:404,headers:{'content-type':'application/json'}});
 assert.equal(await fetchMailboxMetadata('microsoft','SYNTHETIC',messageId,missing,inbox),null);
 await assert.rejects(fetchMailboxMetadata('microsoft','SYNTHETIC',messageId,async()=>respond({...message(inbox),id:'other-message'}),inbox),/MAIL_MESSAGE_ID_CHANGED/);
});

test('Google label behavior is unchanged and does not require a Microsoft inbox ID',async()=>{
 const gmail=(labels:string[])=>({id:messageId,internalDate:'1795608000000',labelIds:labels,payload:{headers:[]}});
 assert.equal((await fetchMailboxMetadata('google','SYNTHETIC',messageId,async()=>respond(gmail(['INBOX']))))?.inInbox,true);
 assert.equal((await fetchMailboxMetadata('google','SYNTHETIC',messageId,async()=>respond(gmail([]))))?.inInbox,false);
});

test('automatic Microsoft reads use only Inbox-scoped detail and attachment routes',async()=>{
 const paths:string[]=[];
 const scoped=`/v1.0/me/mailFolders/${inbox}/messages/${messageId}`;
 const transport:MailboxTransport=async(url,request)=>{
  const path=new URL(url).pathname;
  paths.push(path);
  assert.match(new Headers(request.headers).get('Prefer')??'',/IdType="ImmutableId"/);
  if(path===scoped)return respond({...message(inbox),body:{contentType:'text',content:'Synthetic body'},hasAttachments:true});
  assert.equal(path,`${scoped}/attachments`);
  return respond({value:[{id:'synthetic-attachment',name:'synthetic.txt',contentType:'text/plain',size:10,isInline:false}]});
 };
 const content=await fetchMailboxKnownContent('microsoft','SYNTHETIC',messageId,transport,inbox);
 assert.equal(content.bodyText,'Synthetic body');
 assert.equal(content.attachments.length,1);
 assert.deepEqual(paths,[scoped,`${scoped}/attachments`]);
});

test('automatic Microsoft does not return content for a message moved during a read',async()=>{
 const scoped=`/v1.0/me/mailFolders/${inbox}/messages/${messageId}`;
 const paths:string[]=[];
 const moved:MailboxTransport=async(url)=>{
  const path=new URL(url).pathname;
  paths.push(path);
  if(path===`/v1.0/me/messages/${messageId}`)return respond(message(inbox));
  assert.equal(path,scoped);
  return new Response('{}',{status:404});
 };
 assert.equal((await fetchMailboxMetadata('microsoft','SYNTHETIC',messageId,moved,inbox))?.inInbox,true);
 await assert.rejects(fetchMailboxKnownContent('microsoft','SYNTHETIC',messageId,moved,inbox),/MAIL_MICROSOFT_DETAIL_CHANGED/);
 assert.deepEqual(paths,[`/v1.0/me/messages/${messageId}`,scoped]);

 const attachmentMoved:MailboxTransport=async(url)=>{
  const path=new URL(url).pathname;
  if(path===scoped)return respond({...message(inbox),hasAttachments:true});
  assert.equal(path,`${scoped}/attachments`);
  return new Response('{}',{status:404});
 };
 await assert.rejects(fetchMailboxKnownContent('microsoft','SYNTHETIC',messageId,attachmentMoved,inbox),/MAIL_MICROSOFT_DETAIL_CHANGED/);
});

test('automatic Microsoft rejects an unexpected detail folder or message before attachment access',async()=>{
 for(const [detail,error] of [
  [{...message('synthetic-archive-id'),hasAttachments:true},/MAIL_INVALID_FOLDER_ID/],
  [{...message(inbox),id:'another-message',hasAttachments:true},/MAIL_MICROSOFT_DETAIL_CHANGED/],
 ] as const){
  let calls=0;
  const transport:MailboxTransport=async()=>{calls++;return respond(detail);};
  await assert.rejects(fetchMailboxKnownContent('microsoft','SYNTHETIC',messageId,transport,inbox),error);
  assert.equal(calls,1);
 }
 let calls=0;
 const transport:MailboxTransport=async()=>{calls++;return respond(message(inbox));};
 for(const invalid of [undefined,'..','has space'])await assert.rejects(fetchMailboxKnownContent('microsoft','SYNTHETIC',messageId,transport,invalid),invalidFolder);
 assert.equal(calls,0);
});
