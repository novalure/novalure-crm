import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMicrosoftRecovery, emptyMailboxCheckpoint, mailboxCursorResetAllowed, mailboxSyncCurrent, mailboxSyncPosition, microsoftCheckpointUsesContinuation, microsoftContactBackfillCheckpoint, microsoftRecoveryReplay, queueMicrosoftMailboxDecision } from "../src/lib/crm-mailbox-sync";
import { actOnMailboxPrivateDecision } from "../src/lib/db/crm-mailbox-sync-repository";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantTransaction } from "../src/lib/crm-command";

const inbox="AQMkSYNTHETIC", base="https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta";
const next=`${base}?$skiptoken=SYNTHETIC`,delta=`${base}?$deltatoken=SYNTHETIC`;
const ready={...emptyMailboxCheckpoint(),phase:"ready" as const,deltaCheckpoint:delta};
const invalid={...emptyMailboxCheckpoint(),phase:"ready" as const};

test("Microsoft 410 recovery is allowed only for a delta-request expiry",()=>{
  assert.equal(mailboxCursorResetAllowed("microsoft",410,true),true);
  assert.equal(mailboxCursorResetAllowed("microsoft",410,false),false);
  assert.equal(mailboxCursorResetAllowed("microsoft",401,true),false);
  assert.equal(mailboxCursorResetAllowed("google",404,false),true);
  assert.equal(mailboxCursorResetAllowed("google",410,true),false);
});

test("a tokenless first Microsoft delta request cannot trigger cursor recovery on HTTP 410",()=>{
  const initial=emptyMailboxCheckpoint(),withCursor={...initial,pendingCursor:next};
  assert.equal(microsoftCheckpointUsesContinuation(initial,inbox),false);
  assert.equal(mailboxCursorResetAllowed("microsoft",410,microsoftCheckpointUsesContinuation(initial,inbox)),false);
  assert.equal(microsoftCheckpointUsesContinuation(withCursor,inbox),true);
  assert.equal(mailboxCursorResetAllowed("microsoft",410,microsoftCheckpointUsesContinuation(withCursor,inbox)),true);
  assert.throws(()=>microsoftCheckpointUsesContinuation({...initial,pendingCursor:`${base}?$skiptoken=`},inbox),/MAIL_CHECKPOINT_REVIEW_REQUIRED/);
});

test("Microsoft reports current only after a fresh final page is committed and its queue is drained",()=>{
  // No request because of an exhausted budget, or only an old queue drained:
  // a prior ready cursor does not prove a fresh run or allow replay completion.
  assert.equal(mailboxSyncCurrent("microsoft",ready,null),false);
  const queued={...ready,queued:[{id:"pending"}],afterQueue:mailboxSyncPosition(ready)};
  assert.equal(mailboxSyncCurrent("microsoft",queued,delta),false);
  assert.equal(mailboxSyncCurrent("microsoft",ready,`${base}?$deltatoken=other`),false);
  // Once the fetched final page's own cursor is committed and the queue drains,
  // that exact final position may complete replay and update last-success.
  assert.equal(mailboxSyncCurrent("microsoft",ready,delta),true);
  assert.equal(mailboxSyncCurrent("microsoft",{...ready,afterQueue:mailboxSyncPosition(ready)},delta),false);
  assert.equal(mailboxSyncCurrent("google",ready,null),true);
});

test("Microsoft backfill preserves the original ready cursor and refuses damaged resume state",()=>{
  const before=structuredClone(ready),start=microsoftContactBackfillCheckpoint(ready,true,null,inbox);
  assert.ok(start);assert.deepEqual(start.checkpoint,emptyMailboxCheckpoint());assert.deepEqual(start.resume,ready);assert.deepEqual(ready,before);
  const restore=microsoftContactBackfillCheckpoint(ready,false,start.resume,inbox);
  assert.ok(restore);assert.deepEqual(restore.checkpoint,ready);assert.equal(restore.resume,null);
  const damaged=structuredClone(invalid),snapshot=structuredClone(damaged);
  assert.throws(()=>microsoftContactBackfillCheckpoint(ready,false,damaged,inbox),/MAIL_CHECKPOINT_REVIEW_REQUIRED/);
  assert.deepEqual(damaged,snapshot);assert.deepEqual(ready,before);
  assert.throws(()=>microsoftContactBackfillCheckpoint(invalid,true,null,inbox),/MAIL_CHECKPOINT_REVIEW_REQUIRED/);
  const wrongInbox={...ready,deltaCheckpoint:"https://graph.microsoft.com/v1.0/me/mailFolders/other/messages/delta?$deltatoken=x"};
  assert.throws(()=>microsoftContactBackfillCheckpoint(ready,false,wrongInbox,inbox),/MAIL_CHECKPOINT_REVIEW_REQUIRED/);
});

test("410 recovery requires a valid completed baseline before replay and keeps existing values",()=>{
  const low="11111111-1111-4111-8111-111111111111",high="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  assert.doesNotThrow(()=>assertMicrosoftRecovery(null,inbox));
  assert.doesNotThrow(()=>assertMicrosoftRecovery({phase:"baseline",baseline:null,ceilingId:null,lastId:null},inbox));
  assert.doesNotThrow(()=>assertMicrosoftRecovery({phase:"baseline",baseline:null,ceilingId:high,lastId:null},inbox));
  assert.doesNotThrow(()=>assertMicrosoftRecovery({phase:"verify",baseline:ready,ceilingId:null,lastId:null},inbox));
  assert.doesNotThrow(()=>assertMicrosoftRecovery({phase:"verify",baseline:ready,ceilingId:high,lastId:low},inbox));
  assert.doesNotThrow(()=>assertMicrosoftRecovery({phase:"replay",baseline:ready,ceilingId:high,lastId:high.toUpperCase()},inbox));
  for(const record of [
    {phase:"baseline",baseline:ready,ceilingId:high,lastId:null},
    {phase:"baseline",baseline:null,ceilingId:high,lastId:low},
    {phase:"verify",baseline:null,ceilingId:high,lastId:null},
    {phase:"replay",baseline:invalid,ceilingId:high,lastId:null},
    {phase:"unknown",baseline:ready,ceilingId:high,lastId:null},
    {phase:"verify",baseline:ready,ceilingId:null,lastId:low},
    {phase:"verify",baseline:ready,ceilingId:low,lastId:high},
    {phase:"verify",baseline:ready,ceilingId:"not-a-uuid",lastId:null},
    {phase:"verify",baseline:ready,ceilingId:high,lastId:"not-a-uuid"},
  ])assert.throws(()=>assertMicrosoftRecovery(record,inbox),/MAIL_CHECKPOINT_REVIEW_REQUIRED/);
  const current={...emptyMailboxCheckpoint(),queued:[{id:"SYNTHETIC"}],afterQueue:{...mailboxSyncPosition(emptyMailboxCheckpoint()),pendingCursor:next}};
  const beforeCurrent=structuredClone(current),beforeBaseline=structuredClone(ready);
  const replay=microsoftRecoveryReplay(current,ready,inbox);
  assert.equal(replay.phase,"ready");assert.equal(replay.deltaCheckpoint,delta);assert.deepEqual(replay.queued,current.queued);assert.deepEqual(replay.afterQueue,mailboxSyncPosition(ready));
  assert.deepEqual(current,beforeCurrent);assert.deepEqual(ready,beforeBaseline);
  assert.throws(()=>microsoftRecoveryReplay(current,invalid,inbox),/MAIL_CHECKPOINT_REVIEW_REQUIRED/);
  assert.deepEqual(current,beforeCurrent);assert.deepEqual(ready,beforeBaseline);
});

test("manual Microsoft retry validates before copying, preserves queued work and does not mutate input",()=>{
  const original=structuredClone(ready),queued=queueMicrosoftMailboxDecision(ready,"SYNTHETIC-ID");
  assert.deepEqual(ready,original);assert.deepEqual(queued.queued,[{id:"SYNTHETIC-ID"}]);assert.deepEqual(queued.afterQueue,mailboxSyncPosition(ready));
  assert.equal(queueMicrosoftMailboxDecision(queued,"SYNTHETIC-ID"),queued);
  const broken=structuredClone(invalid),before=structuredClone(broken);
  assert.throws(()=>queueMicrosoftMailboxDecision(broken,"SYNTHETIC-ID"),/MAIL_CHECKPOINT_REVIEW_REQUIRED/);assert.deepEqual(broken,before);
});

test("manual retry of a damaged Microsoft checkpoint writes only the review status",async()=>{
  const writes:{sql:string;params:unknown[]}[]=[];
  const tx={queryOne:async(sql:string)=>{
    if(sql.includes("from crm_mailbox_private_decisions"))return {connectionId:"a",providerId:"SYNTHETIC-ID",status:"review",projectId:null,leadId:null};
    if(sql.includes("from crm_mailbox_connections"))return {provider:"microsoft",busy:false};
    if(sql.includes("from crm_mailbox_auto_checkpoints"))return {checkpoint:invalid};
    throw new Error("unexpected read");
  },query:async(sql:string,params:unknown[])=>{writes.push({sql,params});return [];}} as unknown as TenantTransaction;
  const session={workspaceId:"synthetic",userId:"synthetic",productRole:"owner",serviceIdentity:false} as unknown as AppSession;
  const before=structuredClone(invalid),result=await actOnMailboxPrivateDecision(tx,session,{decisionId:"11111111-1111-4111-8111-111111111111",action:"retry_private"});
  assert.equal(result.status,"checkpoint_review");assert.equal(writes.length,1);assert.match(writes[0].sql,/MAIL_CHECKPOINT_REVIEW_REQUIRED/);
  assert.doesNotMatch(writes[0].sql,/crm_mailbox_auto_checkpoints/);assert.deepEqual(invalid,before);
});
