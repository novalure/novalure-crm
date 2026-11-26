import assert from "node:assert/strict";
import test from "node:test";
import { assessMailboxObjectionReview } from "../src/lib/mailbox-objection-review";
import type { MailboxImportedMessage } from "../src/lib/crm-mailbox";
import type { MailboxMetadata, MailboxSyncDecision } from "../src/lib/crm-mailbox-sync";

const metadata: MailboxMetadata = { providerId:"synthetic-1",threadId:null,internetMessageId:null,inReplyTo:null,references:[],fromAddress:"contact@example.invalid",toAddresses:["owner@example.invalid"],participants:[],subject:"Synthetic",receivedAt:"2026-11-25T12:00:00Z",inInbox:true };
const decision: MailboxSyncDecision = { status:"known",reason:"exact_address_unique_contact_unverified_sender",projectId:"synthetic-project",leadId:null,contactId:"synthetic-contact",automatic:false };
const message: MailboxImportedMessage = { providerId:"synthetic-1",threadId:null,internetMessageId:null,subject:"Synthetic",fromLabel:"",fromAddress:"contact@example.invalid",toAddresses:["owner@example.invalid"],receivedAt:metadata.receivedAt,bodyText:"",bodyTruncated:false,attachments:[],senderIdentityVerified:false };

test("every matched incoming message needs review without asserting an objection or sender identity", () => {
  for (const text of ["Please stop emailing me", "Thank you", "", "quoted or truncated text"]) {
    const result=assessMailboxObjectionReview({metadata,decision,message:{...message,bodyText:text,bodyTruncated:true}});
    assert.deepEqual(result,{state:"review_required",contactId:decision.contactId,projectId:decision.projectId,address:metadata.fromAddress,senderIdentityVerified:false});
  }
});

test("an unmatched or ambiguous sender is not described as cleared", () => {
  assert.deepEqual(assessMailboxObjectionReview({metadata,decision:{...decision,status:"review",contactId:null},message}),{state:"unmatched",senderIdentityVerified:false});
  assert.deepEqual(assessMailboxObjectionReview({metadata,decision:{...decision,projectId:null},message}),{state:"unmatched",senderIdentityVerified:false});
  assert.deepEqual(assessMailboxObjectionReview({metadata,decision:{...decision,reason:"reviewed_thread_same_participants"},message}),{state:"unmatched",senderIdentityVerified:false});
});

test("a missing, changed, mismatched, or non-inbox message cannot become a reviewable contact hint", () => {
  for (const altered of [null,{...message,providerId:"different"},{...message,fromAddress:"other@example.invalid"}]) {
    assert.deepEqual(assessMailboxObjectionReview({metadata,decision,message:altered}),{state:"unavailable",senderIdentityVerified:false});
  }
  assert.deepEqual(assessMailboxObjectionReview({metadata:{...metadata,inInbox:false},decision,message}),{state:"unavailable",senderIdentityVerified:false});
});
