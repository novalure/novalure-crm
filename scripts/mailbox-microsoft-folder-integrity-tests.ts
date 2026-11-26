import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fetchMailboxMetadata} from '../src/lib/integrations/mailbox-sync-provider';
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
