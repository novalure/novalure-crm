import assert from 'node:assert/strict';
import { test } from 'node:test';
import {spawn} from 'node:child_process';
import {importExactQaMailboxMessage} from '../src/lib/db/crm-mailbox-exact-import';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import pg from 'pg';
import { startLocalSalesDb, applySalesSchema } from './lib/local-sales-db.mjs';
import type { AppSession } from '../src/lib/auth/session';
import { getRolePermissions } from '../src/lib/auth/permissions';
import { getProductRoleCapabilities } from '../src/lib/product-model';
import { crmPayloadDigest, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from '../src/lib/crm-command';
import type { TenantPool } from '../src/lib/db/tenant-client';
import { hasMailboxSendScope, personalReplyMime, personalSha256, parsePersonalReplyInput, mailboxReplyScopes } from '../src/lib/crm-mailbox-reply';
import { inspectPersonalMailAttachment } from '../src/lib/crm-mailbox-attachment';
import { readPersonalMailJson } from '../src/lib/crm-mailbox-request';
import { mailboxAuthorizationUrl, type MailboxTransport } from '../src/lib/integrations/mailbox-provider';
import { dispatchPersonalReply } from '../src/lib/integrations/mailbox-reply-provider';
import { associateCrmMailboxMessage, beginCrmMailboxOAuth, finishCrmMailboxOAuth, saveCrmMailboxConnection, eraseCrmMailboxCopy } from '../src/lib/db/crm-mailbox-repository';
import { cancelPreparedPersonalReply, dispatchPreparedPersonalReply, erasePersonalAttachment, personalReplyState, previewPersonalReply, readPersonalAttachment, savePersonalAttachment, sendPersonalReply } from '../src/lib/db/crm-mailbox-reply-repository';
process.env.OAUTH_STATE_SECRET = 'synthetic-personal-mail-state-20261104';
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = 'synthetic-personal-mail-encryption-20261104';
process.env.GOOGLE_CLIENT_ID = 'synthetic-google';
process.env.GOOGLE_CLIENT_SECRET = 'synthetic-google-secret';
process.env.MICROSOFT_CLIENT_ID = 'synthetic-ms';
process.env.MICROSOFT_CLIENT_SECRET = 'synthetic-ms-secret';
process.env.NOVALURE_APP_ORIGIN = 'https://synthetic.example.invalid';
const metadata = () => ({ idempotencyKey: randomUUID(), correlationId: randomUUID() });
const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const readScope = 'https://www.googleapis.com/auth/gmail.readonly';
test('personal send consent is explicit and MIME is a bounded plain text reply, never raw HTML', async () => {
    assert.equal(hasMailboxSendScope('google', [readScope, 'https://www.googleapis.com/auth/gmail.modify']), false);
    assert.equal(hasMailboxSendScope('microsoft', ['Mail.ReadWrite']), false);
    for (const provider of ['google', 'microsoft'] as const) {
        const url = new URL(mailboxAuthorizationUrl({ provider, state: 'synthetic', codeChallenge: 'synthetic', requestUrl: 'https://synthetic.example.invalid' }));
        assert.doesNotMatch(url.searchParams.get('scope')!, /Mail.Send|gmail.send/);
        const explicit = new URL(mailboxAuthorizationUrl({ provider, state: 'synthetic', codeChallenge: 'synthetic', requestUrl: 'https://synthetic.example.invalid', enableReply: true }));
        assert.match(explicit.searchParams.get('scope')!, /Mail.Send|gmail.send/);
    }
    assert.throws(() => parsePersonalReplyInput({ messageId: randomUUID(), body: 'text', attachmentIds: [], to: 'other@example.invalid' }));
    const bytes = Buffer.from('<script>untrusted inert text</script>');
    const mime = personalReplyMime({ from: 'own@example.invalid', to: 'lead@example.invalid', subject: 'Anfrage ü', body: '<b>plain text</b>', internetMessageId: '<new@example.invalid>', inReplyTo: '<source@example.invalid>', attachments: [{ id: randomUUID(), fileName: "safe's.txt", mimeType: 'text/plain', bytes, sha256: personalSha256(bytes) }] }).toString();
    assert.match(mime, /In-Reply-To: <source@example.invalid>/);
    assert.match(mime, /text\/plain/);
    assert.doesNotMatch(mime, /text\/html|<script>|<b>/);
    assert.match(mime, /safe%27s.txt/);
    assert.throws(() => personalReplyMime({ from: 'own@example.invalid', to: 'lead@example.invalid\r\nBcc:evil@example.invalid', subject: 'A', body: 'test', internetMessageId: '<new@example.invalid>', inReplyTo: '<source@example.invalid>', attachments: [] }));
});
test('actual streamed request limit rejects chunked oversize, invalid UTF8 and arrays', async () => {
    assert.deepEqual(await readPersonalMailJson(new Request('https://synthetic.invalid',{method:'POST',body:new Uint8Array()}),512,true),{});
    await assert.rejects(readPersonalMailJson(new Request('https://synthetic.invalid',{method:'POST',body:'enableReply=true'}),512,true),{code:'CONTENT_TYPE_REQUIRED'});
    assert.deepEqual(await readPersonalMailJson(new Request('https://synthetic.invalid',{method:'POST',headers:{'Content-Type':'application/json'},body:'{\"enableReply\":true}'}),512,true),{enableReply:true});
    await assert.rejects(readPersonalMailJson(new Request('https://synthetic.invalid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ large: 'x'.repeat(100) }) }), 20), { code: 'REQUEST_TOO_LARGE' });
    await assert.rejects(readPersonalMailJson(new Request('https://synthetic.invalid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' }), 20), { code: 'INVALID_JSON' });
    assert.deepEqual(await readPersonalMailJson(new Request('https://synthetic.invalid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}' }), 20), { ok: true });
});
test('private file inspection rejects executable/mismatch/active PDF and normalizes safe image bytes', async () => {
    const text = await inspectPersonalMailAttachment({ fileName: 'note.txt', mimeType: 'text/plain', bytes: Buffer.from('private inert text') });
    assert.equal(text.sizeBytes, 18);
    await assert.rejects(inspectPersonalMailAttachment({ fileName: 'run.exe', mimeType: 'application/octet-stream', bytes: Buffer.from('MZ executable') }), { code: 'MAIL_ATTACHMENT_QUARANTINED' });
    await assert.rejects(inspectPersonalMailAttachment({ fileName: 'invalid.txt', mimeType: 'text/plain', bytes: Uint8Array.from([0xff, 0xfe]) }), { code: 'MAIL_ATTACHMENT_QUARANTINED' });
    await assert.rejects(inspectPersonalMailAttachment({ fileName: 'too-big.txt', mimeType: 'text/plain', bytes: Buffer.alloc(2097153, 65) }), { code: 'MAIL_ATTACHMENT_QUARANTINED' });
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const checked = await inspectPersonalMailAttachment({ fileName: 'safe.png', mimeType: 'image/png', bytes: image });
    assert.equal(checked.mimeType, 'image/png');
    await assert.rejects(inspectPersonalMailAttachment({ fileName: 'mismatch.jpg', mimeType: 'image/jpeg', bytes: image }), { code: 'MAIL_ATTACHMENT_QUARANTINED' });
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const clean = await inspectPersonalMailAttachment({ fileName: 'safe.pdf', mimeType: 'application/pdf', bytes: await doc.save() });
    assert.equal(clean.mimeType, 'application/pdf');
    doc.addJavaScript('unsafe', 'app.alert("must never run")');
    await assert.rejects(inspectPersonalMailAttachment({ fileName: 'active.pdf', mimeType: 'application/pdf', bytes: await doc.save() }), { code: 'MAIL_ATTACHMENT_QUARANTINED' });
});
test('provider POST failure is never treated as delivered or automatically retried', async () => {
    const input = { provider: 'microsoft' as const, token: 'SYNTHETIC', scopes: ['Mail.Send'], source: { providerId: 'source', threadId: 'thread', internetMessageId: '<parent@example.invalid>', subject: 'Subject', from: 'lead@example.invalid', replyTo: 'lead@example.invalid' }, from: 'own@example.invalid', to: 'lead@example.invalid', body: 'inert text', internetMessageId: '<new@example.invalid>', jobId: randomUUID(), attachments: [] };
    const timeout = await dispatchPersonalReply(input, async () => { throw new Error('lost acknowledgement'); });
    assert.equal(timeout.status, 'uncertain');
    const denied = await dispatchPersonalReply(input, async () => respond({}, 403));
    assert.equal(denied.status, 'rejected');
    const accepted = await dispatchPersonalReply(input, async (url, init) => { assert.equal(url, 'https://graph.microsoft.com/v1.0/me/messages/source/reply'); assert.equal(init.method, 'POST'); assert.equal(new Headers(init.headers).get('Content-Type'), 'text/plain'); assert.match(Buffer.from(String(init.body), 'base64').toString(), /In-Reply-To/); return new Response(null, { status: 202 }); });
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.receipt?.deliveryVerified, false);
});
test('personal replies and attachments use actual two-tenant PostgreSQL auth, source binding, receipts and restart-safe no-resend', { timeout: 180000 }, async (t) => {
    const db = await startLocalSalesDb();
    try {
        await applySalesSchema(db, { maxMigrationNumber: 106 });
        for (const name of ['154_automation_graph.sql', '161_crm_notification_preferences.sql', '170_crm_personal_mailbox.sql', '177_crm_notification_email.sql', '178_personal_mailbox_triage.sql', '182_personal_mailbox_sync.sql', '192_personal_mail_reply_and_attachments.sql'])
            await db.admin.query(await readFile(`migrations/${name}`, 'utf8'));
        const options: TenantTransactionOptions = { pool: db.pool as unknown as TenantPool };
        async function fixture(provider: 'google' | 'microsoft' = 'google', workspace?: string) {
            const workspaceId = workspace ?? randomUUID(), userId = randomUUID(), projectId = randomUUID(), contactId = randomUUID(), leadId = randomUUID(), authSessionId = randomUUID(), messageId = randomUUID(), providerId = `source-${messageId}`, label = `own-${userId}@example.invalid`, recipient = 'lead@example.invalid';
            if (!workspace)
                await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC personal mail','self_service_customer','real_estate_broker')", [workspaceId]);
            await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC',$3,'agent','broker_agent','active')", [userId, workspaceId, `${userId}@example.invalid`]);
            const identity = (await db.admin.query('select auth_identity_id as id from workspace_users where id=$1', [userId])).rows[0].id;
            await db.admin.query("update auth_identities set credential_state='active',password_hash='synthetic-never-authenticates' where id=$1", [identity]);
            await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,expires_at) values($1,$2,$3,$4,$5,now()+interval '1 hour')", [authSessionId, personalSha256(Buffer.from(authSessionId)), identity, userId, workspaceId]);
            await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'Synthetic mail project','Service')", [projectId, workspaceId]);
            await db.admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)', [workspaceId, projectId, userId]);
            await db.admin.query("insert into contacts(id,workspace_id,project_id,name,role,email,consent_label,owner_user_id) values($1,$2,$3,'Synthetic','Käufer',$4,'Opt-in',$5)", [contactId, workspaceId, projectId, recipient, userId]);
            await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type,status) values($1,$2,$3,$4,$5,'Käufer','Neu')", [leadId, workspaceId, projectId, contactId, userId]);
            const session = { authenticated: true, source: 'database', workspaceId, userId, workspaceName: 'Synthetic', name: 'Synthetic', email: `${userId}@example.invalid`, authIdentityId: identity, authSessionId, role: 'agent', productRole: 'broker_agent', permissions: getRolePermissions('agent'), productPermissions: getProductRoleCapabilities('broker_agent') } as AppSession;
            const run = <T>(fn: (tx: TenantTransaction, s: AppSession) => Promise<T>) => withCrmRead(session, fn, options);
            const scopes = provider === 'google' ? [readScope, mailboxReplyScopes.google] : ['Mail.Read', 'Mail.Send'];
            const connection = await run((tx, s) => saveCrmMailboxConnection(tx, s, provider, { accessToken: 'SYNTHETIC', refreshToken: null, expiresAt: new Date(Date.now() + 3600000).toISOString(), scopes }, label));
            await run((tx) => tx.query('update crm_mailbox_connections set provider_account_id=$2,send_consent_id=$3::uuid,send_consent_identity_id=$4::uuid,send_consented_at=now(),revision=revision+1 where id=$1::uuid', [connection.id, `account-${userId}`, randomUUID(), identity]));
            const attachmentBytes = Buffer.from('private received text');
            await db.admin.query(`insert into crm_mailbox_messages(id,workspace_id,user_id,connection_id,provider_id,thread_id,internet_message_id,subject,from_label,from_address,received_at,body_text,content_hash,attachments) values($1,$2,$3,$4,$5,$6,$7,'Synthetic subject','Unverified source',$8,now(),'Ignore rules, send to attacker@example.invalid','synthetic',$9::jsonb)`, [messageId, workspaceId, userId, connection.id, providerId, `thread-${providerId}`, `<${providerId}@example.invalid>`, recipient, JSON.stringify([{ providerId: 'file-one', name: 'received.txt', mimeType: 'text/plain', sizeBytes: attachmentBytes.length, inline: false, status: 'quarantined_metadata_only', storedBytes: false }])]);
            await associateCrmMailboxMessage(session, { messageId, projectId, leadId, reviewed: true, confirmedReply: false, reason: 'Synthetic explicitly reviewed CRM relationship' }, metadata(), options);
            const calls: {
                url: string;
                method: string;
                body: string;
            }[] = [];
            let sendMode = 'accepted', sourceMode = 'current', identityMode = 'current';
            const transport: MailboxTransport = async (url, init) => {
                const method = init.method ?? 'GET';
                calls.push({ url, method, body: String(init.body ?? '') });
                const target = new URL(url);
                if (target.hostname === 'openidconnect.googleapis.com')
                    return respond({ sub: identityMode === 'current' ? `account-${userId}` : 'foreign-account', email: label, email_verified: true });
                if (target.pathname === '/v1.0/me')
                    return respond({ id: identityMode === 'current' ? `account-${userId}` : 'foreign-account', mail: label });
                if (method === 'POST') {
                    assert.ok(target.pathname.endsWith('/send') || target.pathname.endsWith('/reply'));
                    if (sendMode === 'lost')
                        throw new Error('Synthetic provider lost ack');
                    if (sendMode === 'rejected')
                        return respond({}, 403);
                    const encoded = provider === 'google' ? JSON.parse(String(init.body)).raw : String(init.body), mime = Buffer.from(encoded, provider === 'google' ? 'base64url' : 'base64').toString();
                    assert.match(mime, new RegExp(`To: ${recipient.replaceAll('.', '\\.')}`));
                    assert.doesNotMatch(mime, /attacker@example.invalid/);
                    return provider === 'google' ? respond({ id: `sent-${messageId}`, threadId: `thread-${providerId}` }) : new Response(null, { status: 202 });
                }
                if (target.pathname.endsWith('/attachments/file-one'))
                    return provider === 'google' ? respond({ data: attachmentBytes.toString('base64url') }) : respond({ id: 'file-one', '@odata.type': '#microsoft.graph.fileAttachment', name: 'received.txt', contentType: 'text/plain', contentBytes: attachmentBytes.toString('base64') });
                const sender = sourceMode === 'current' ? recipient : 'foreign@example.invalid';
                if (provider === 'microsoft')
                    return respond({ id: providerId, conversationId: `thread-${providerId}`, internetMessageId: `<${providerId}@example.invalid>`, subject: 'Synthetic subject', from: { emailAddress: { address: sender } }, replyTo: [] });
                return respond({ id: providerId, threadId: `thread-${providerId}`, payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: sender }, { name: 'Subject', value: 'Synthetic subject' }, { name: 'Message-ID', value: `<${providerId}@example.invalid>` }], parts: [{ filename: 'received.txt', mimeType: 'text/plain', body: { attachmentId: 'file-one', size: attachmentBytes.length } }] } });
            };
            const opts = { ...options, transport }, input = { messageId, body: 'Synthetic approved personal reply', attachmentIds: [] as string[] };
            return { session, workspaceId, userId, projectId, contactId, leadId, messageId, connectionId: connection.id, identity, run, transport, opts, input, calls, sendMode: (value: string) => { sendMode = value; }, sourceMode: (value: string) => { sourceMode = value; }, identityMode: (value: string) => { identityMode = value; }, posts: () => calls.filter(c => c.method === 'POST').length };
        }
        await t.test('known-ID-only QA import checks test marker and participant metadata before content for both providers; business mail is never fetched',async()=>{
            for(const provider of ['google','microsoft'] as const){
                const f=await fixture(provider),batchId=randomUUID(),knownId='qa-'+randomUUID(),label=`own-${f.userId}@example.invalid`,subject=`[NOVALURE-QA:${batchId}] Synthetic test only`;
                let mode='test',full=0;const requests:string[]=[];const hostScope={workspaceId:f.workspaceId,actorId:f.userId,identityId:f.identity,connectionId:f.connectionId,provider,providerAccountId:`account-${f.userId}`,accountLabel:label,qaBatchId:batchId,providerMessageId:knownId,participantAddresses:[label,'lead@example.invalid'],expectedBodySha256:personalSha256(Buffer.from('Synthetic isolated test body')),expectedAttachmentManifestSha256:crmPayloadDigest([]),allowedReferenceIds:[],verificationReference:'sha256:'+'0'.repeat(64),expiresAt:new Date(Date.now()+1800000).toISOString()};
                const transport:MailboxTransport=async(url,init)=>{requests.push(url);const target=new URL(url);assert.equal(init.method??'GET','GET');if(target.pathname==='/v1.0/me'||target.hostname==='openidconnect.googleapis.com')return f.transport(url,init);assert.ok(target.pathname.endsWith('/messages/'+knownId),'No mailbox listing or unrelated ID');const isFull=provider==='google'?target.searchParams.get('format')==='full':target.searchParams.get('$select')?.split(',').includes('body');if(isFull)full++;if(isFull&&mode==='late-revoke')await db.admin.query("update crm_mailbox_connections set status='disconnected',access_token_encrypted=null,refresh_token_encrypted=null,revision=revision+1 where id=$1",[f.connectionId]);
                    const currentSubject=mode==='business'?'Real business subject':subject,from=mode==='unknown'?'uncontrolled@example.invalid':'lead@example.invalid',cc=mode==='changed-cc'&&isFull?'uncontrolled@example.invalid':null;
                    if(provider==='google')return respond({id:knownId,threadId:'qa-thread',internalDate:'1793000000000',labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:from},{name:'To',value:label},{name:'Subject',value:currentSubject},{name:'Message-ID',value:'<qa-source@example.invalid>'},...(mode==='bcc'?[{name:'Bcc',value:'uncontrolled@example.invalid'}]:[]),...(mode==='reply-to'?[{name:'Reply-To',value:'uncontrolled@example.invalid'}]:[]),...(mode==='reference'?[{name:'References',value:'<unregistered-business-original@example.invalid>'}]:[]),...(cc?[{name:'Cc',value:cc}]:[])],...(isFull?{body:{data:Buffer.from(mode==='quoted-business'?'Unexpected original business content':'Synthetic isolated test body').toString('base64url')}}:{})}});
                    return respond({id:knownId,conversationId:'qa-thread',internetMessageId:'<qa-source@example.invalid>',subject:currentSubject,from:{emailAddress:{address:from}},toRecipients:[{emailAddress:{address:label}}],ccRecipients:cc?[{emailAddress:{address:cc}}]:[],bccRecipients:mode==='bcc'?[{emailAddress:{address:'uncontrolled@example.invalid'}}]:[],replyTo:mode==='reply-to'?[{emailAddress:{address:'uncontrolled@example.invalid'}}]:[],internetMessageHeaders:mode==='reference'?[{name:'References',value:'<unregistered-business-original@example.invalid>'}]:[],receivedDateTime:'2026-11-04T10:00:00Z',...(isFull?{body:{contentType:'text',content:mode==='quoted-business'?'Unexpected original business content':'Synthetic isolated test body'},hasAttachments:false}:{})});
                };
                const input={connectionId:f.connectionId,providerMessageId:knownId,qaBatchId:batchId,approvedAddresses:[label,'lead@example.invalid'],reviewed:true};
                await assert.rejects(importExactQaMailboxMessage(f.session,input,metadata(),{...options,transport}),{code:'MAIL_QA_HOST_SCOPE_REQUIRED'});assert.equal(requests.length,0);
                await assert.rejects(importExactQaMailboxMessage(f.session,{...input,approvedAddresses:[label,'lead@example.invalid','uncontrolled@example.invalid']},metadata(),{...options,transport,qaHostRegistry:JSON.stringify([hostScope])}),{code:'MAIL_QA_HOST_SCOPE_REQUIRED'});assert.equal(requests.length,0);
                await assert.rejects(importExactQaMailboxMessage(f.session,input,metadata(),{...options,transport,qaHostRegistry:JSON.stringify([{...hostScope,expiresAt:new Date(Date.now()-1000).toISOString()}])}),{code:'MAIL_QA_HOST_SCOPE_REQUIRED'});assert.equal(requests.length,0);
                for(mode of ['bcc','reply-to']){const previous=full;await assert.rejects(importExactQaMailboxMessage(f.session,input,metadata(),{...options,transport,qaHostRegistry:JSON.stringify([hostScope])}),{code:'MAIL_QA_UNVERIFIED_HEADER'});assert.equal(full,previous);}
                mode='reference';const referencePrevious=full;await assert.rejects(importExactQaMailboxMessage(f.session,input,metadata(),{...options,transport,qaHostRegistry:JSON.stringify([hostScope])}),{code:'MAIL_QA_REFERENCE_UNVERIFIED'});assert.equal(full,referencePrevious);
                mode='quoted-business';await assert.rejects(importExactQaMailboxMessage(f.session,input,metadata(),{...options,transport,qaHostRegistry:JSON.stringify([hostScope])}),{code:'MAIL_QA_CONTENT_UNVERIFIED'});
                for(mode of ['business','unknown']){const previous=full;await assert.rejects(importExactQaMailboxMessage(f.session,input,metadata(),{...options,transport,qaHostRegistry:JSON.stringify([hostScope])}),{code:'MAIL_QA_MARKER_REQUIRED'});assert.equal(full,previous,'uncontrolled/business content must not be fetched');}
                mode='changed-cc';await assert.rejects(importExactQaMailboxMessage(f.session,input,metadata(),{...options,transport,qaHostRegistry:JSON.stringify([hostScope])}),{code:'MAIL_QA_PARTICIPANTS_CHANGED'});
                mode='test';const meta=metadata(),singlePool=new pg.Pool({host:'127.0.0.1',port:db.port,user:db.role,database:'postgres',max:1,connectionTimeoutMillis:1000});let checkouts=0;const pinnedPool={async connect(){checkouts++;return singlePool.connect();}} as unknown as TenantPool;let result:Awaited<ReturnType<typeof importExactQaMailboxMessage>>;try{result=await importExactQaMailboxMessage(f.session,input,meta,{pool:pinnedPool,transport,qaHostRegistry:JSON.stringify([hostScope])});assert.equal(checkouts,2,'Initial snapshot plus one final transaction; no nested checkout');}finally{await singlePool.end();}assert.equal(result.data.importedCount,1);const replay=await importExactQaMailboxMessage(f.session,input,meta,{...options,transport,qaHostRegistry:JSON.stringify([hostScope])});assert.equal(replay.replayed,true);assert.equal(replay.data.id,result.data.id);assert.equal((await db.admin.query('select count(*)::int as n from crm_mailbox_messages where connection_id=$1',[f.connectionId])).rows[0].n,2);
                const stored=(await db.admin.query('select provider_id_format,body_text from crm_mailbox_messages where id=$1',[result.data.id])).rows[0];assert.equal(stored.body_text,'Synthetic isolated test body');assert.equal(stored.provider_id_format,provider==='microsoft'?'immutable':'legacy');assert.ok(requests.every(url=>!new URL(url).pathname.endsWith('/messages')));
                const foreign=await fixture(provider);const previous=requests.length;await assert.rejects(importExactQaMailboxMessage(foreign.session,input,metadata(),{...options,transport,qaHostRegistry:JSON.stringify([hostScope])}),{code:'MAIL_QA_CONNECTION_REQUIRED'});assert.equal(requests.length,previous);mode='late-revoke';await assert.rejects(importExactQaMailboxMessage(f.session,input,meta,{...options,transport,qaHostRegistry:JSON.stringify([hostScope])}),{code:'MAIL_QA_CONNECTION_REQUIRED'});
            }
        });
        await t.test('Google and Outlook replies bind original thread, send one private attachment and persist accepted-not-delivered receipt', async () => {
            for (const provider of ['google', 'microsoft'] as const) {
                const f = await fixture(provider), saved = await savePersonalAttachment(f.session, { messageId: f.messageId, source: 'upload', fileName: 'note.txt', mimeType: 'text/plain', data: Buffer.from('private attachment bytes').toString('base64'), reviewed: true }, metadata(), f.opts);
                f.input.attachmentIds = [saved.data.id];
                const preview = await previewPersonalReply(f.session, f.input, f.opts);
                assert.equal(preview.to, 'lead@example.invalid');
                const request = { ...f.input, approved: true, previewDigest: preview.digest }, meta = metadata(), result = await sendPersonalReply(f.session, request, meta, f.opts);
                assert.equal(result.data.status, 'accepted');
                assert.equal(result.data.deliveryVerified, false);
                assert.equal(f.posts(), 1);
                const replay = await sendPersonalReply(f.session, request, meta, f.opts);
                assert.equal(replay.replayed, true);
                assert.equal(f.posts(), 1);
                assert.equal(replay.data.id, result.data.id);
                assert.equal((await personalReplyState(f.session, f.messageId, f.opts)).jobs[0].acceptedByProvider, true);const history=(await personalReplyState(f.session,f.messageId,f.opts)).jobs[0];assert.equal(history.body,f.input.body);assert.equal(history.to,'lead@example.invalid');assert.equal(history.attachments[0].id,saved.data.id);
                assert.match((await db.admin.query('select content_encrypted as data from crm_mailbox_attachment_files where id=$1', [saved.data.id])).rows[0].data, /./);
                assert.doesNotMatch(JSON.stringify((await db.admin.query('select response from crm_command_receipts where id=$1', [result.commandId])).rows), /private attachment|Synthetic approved personal reply|SYNTHETIC/);
            }
        });
        await t.test('received file is personally fetched, checked, downloaded privately, erased permanently and never adopted across tenants', async () => {
            const a = await fixture(), b = await fixture(), meta = metadata(), input = { messageId: a.messageId, source: 'received', providerAttachmentId: 'file-one', reviewed: true };
            const stored = await savePersonalAttachment(a.session, input, meta, a.opts);
            assert.equal(stored.data.status, 'ready');
            assert.equal(Buffer.from((await readPersonalAttachment(a.session, a.messageId, stored.data.id, a.opts)).bytes).toString(), 'private received text');
            await assert.rejects(readPersonalAttachment(b.session, a.messageId, stored.data.id, b.opts), { code: 'NOT_FOUND' });
            assert.equal(b.calls.length, 0);
            await erasePersonalAttachment(a.session, a.messageId, stored.data.id, metadata(), a.opts);
            await assert.rejects(readPersonalAttachment(a.session, a.messageId, stored.data.id, a.opts), { code: 'NOT_FOUND' });
            const replay = await savePersonalAttachment(a.session, input, meta, a.opts);
            assert.equal(replay.replayed, true);
            assert.equal((await personalReplyState(a.session, a.messageId, a.opts)).files[0].status, 'erased');await assert.rejects(a.run(tx=>tx.query("update crm_mailbox_attachment_files set status='ready',content_encrypted='synthetic-attempted-rehydrate' where id=$1::uuid",[stored.data.id])),{code:'23514'});
        });
        await t.test('quarantined executable bytes never persist, download or enter a preview', async () => { const f = await fixture(), saved = await savePersonalAttachment(f.session, { messageId: f.messageId, source: 'upload', fileName: 'run.exe', mimeType: 'application/octet-stream', data: Buffer.from('MZ synthetic executable').toString('base64'), reviewed: true }, metadata(), f.opts); assert.equal(saved.data.status, 'rejected'); assert.equal((await db.admin.query('select content_encrypted from crm_mailbox_attachment_files where id=$1', [saved.data.id])).rows[0].content_encrypted, null); await assert.rejects(readPersonalAttachment(f.session, f.messageId, saved.data.id, f.opts), { code: 'NOT_FOUND' }); await assert.rejects(previewPersonalReply(f.session, { ...f.input, attachmentIds: [saved.data.id] }, f.opts), { code: 'MAIL_ATTACHMENT_UNAVAILABLE' }); assert.equal(f.posts(), 0); });
        await t.test('old read-only grant and missing identity/session cannot obtain send authority from the message', async () => { const f = await fixture(); await f.run(tx => tx.query('update crm_mailbox_connections set send_consent_id=null,send_consent_identity_id=null,send_consented_at=null,revision=revision+1 where id=$1', [f.connectionId])); await assert.rejects(previewPersonalReply(f.session, f.input, f.opts), { code: 'MAIL_SEND_CONSENT_REQUIRED' }); await assert.rejects(previewPersonalReply({ ...f.session, authSessionId: undefined }, f.input, f.opts), { code: 'VALIDATION_ERROR' }); assert.equal(f.calls.length, 0); });
        await t.test('explicit OAuth reply consent is identity bound; subsequent read-only OAuth removes it', async () => { const f = await fixture(); const oauth: MailboxTransport = async (url) => url.includes('/token') ? respond({ access_token: 'SYNTHETIC', expires_in: 3600, token_type: 'Bearer', scope: `${readScope} ${mailboxReplyScopes.google}` }) : respond({ sub: `account-${f.userId}`, email: `own-${f.userId}@example.invalid`, email_verified: true }); for (const enableReply of [true, false]) {
            const start = await f.run((tx, s) => beginCrmMailboxOAuth(tx, s, 'google', 'https://synthetic.example.invalid', enableReply));
            const state = new URL(start.authorizationUrl).searchParams.get('state')!;
            await finishCrmMailboxOAuth(f.session, 'google', state, 'SYNTHETIC', 'https://synthetic.example.invalid', options, oauth);
            const row = (await db.admin.query('select send_consent_id,send_consent_identity_id from crm_mailbox_connections where id=$1', [f.connectionId])).rows[0];
            assert.equal(Boolean(row.send_consent_id), enableReply);
            assert.equal(row.send_consent_identity_id, enableReply ? f.identity : null);
        } });
        await t.test('foreign tenant and different user in same tenant cannot preview or attach to another private message', async () => { const a = await fixture(), b = await fixture(), c = await fixture('google', a.workspaceId); for (const f of [b, c]) {
            await assert.rejects(previewPersonalReply(f.session, a.input, f.opts), { code: 'MAIL_SOURCE_UNAVAILABLE' });
            await assert.rejects(savePersonalAttachment(f.session, { messageId: a.messageId, source: 'upload', fileName: 'n.txt', mimeType: 'text/plain', data: 'eA==', reviewed: true }, metadata(), f.opts), { code: 'MAIL_SOURCE_UNAVAILABLE' });
            assert.equal(f.calls.length, 0);
        } });
        await t.test('unknown/unassociated source, changed provider identity and changed recipient are denied without POST', async () => { for (const mode of ['unassociated', 'account', 'recipient']) {
            const f = await fixture();
            if (mode === 'unassociated')
                await db.admin.query('delete from crm_mailbox_links where message_id=$1', [f.messageId]);
            if (mode === 'account')
                f.identityMode('foreign');
            if (mode === 'recipient')
                f.sourceMode('foreign');
            await assert.rejects(previewPersonalReply(f.session, f.input, f.opts));
            assert.equal(f.posts(), 0);
        } });
        await t.test('revoked project grant, current role, session, contact consent and recipient change deny send after preview', async () => {
            for (const mode of ['project', 'role', 'session', 'consent', 'recipient']) {
                const f = await fixture(), preview = await previewPersonalReply(f.session, f.input, f.opts);
                if (mode === 'project')
                    await db.admin.query('update project_pipeline_permissions set can_edit_deals=false where project_id=$1 and user_id=$2', [f.projectId, f.userId]);
                if (mode === 'role')
                    await db.admin.query("update workspace_users set role='assistant' where id=$1", [f.userId]);
                if (mode === 'session')
                    await db.admin.query("update auth_sessions set revoked_at=now(),revoked_reason='synthetic' where id=$1", [f.session.authSessionId]);
                if (mode === 'consent')
                    await db.admin.query("update contacts set consent_label='Opt-out' where id=$1", [f.contactId]);
                if (mode === 'recipient')
                    await db.admin.query("update contacts set email='changed@example.invalid' where id=$1", [f.contactId]);
                await assert.rejects(sendPersonalReply(f.session, { ...f.input, approved: true, previewDigest: preview.digest }, metadata(), f.opts));
                assert.equal(f.posts(), 0);
            }
        });
        await t.test('attachment erasure and stale preview digest block dispatch; prepared receipt is cancellable without resetting unknown', async () => { const f = await fixture(), preview = await previewPersonalReply(f.session, f.input, f.opts); await f.run(tx => tx.query('update crm_mailbox_messages set revision=revision+1 where id=$1', [f.messageId])); await assert.rejects(sendPersonalReply(f.session, { ...f.input, approved: true, previewDigest: preview.digest }, metadata(), f.opts), { code: 'MAIL_PREVIEW_STALE' }); assert.equal(f.posts(), 0); const state = await personalReplyState(f.session, f.messageId, f.opts); assert.equal(state.jobs[0].status, 'prepared'); await cancelPreparedPersonalReply(f.session, state.jobs[0].id, metadata(), f.opts); assert.equal((await personalReplyState(f.session, f.messageId, f.opts)).jobs[0].status, 'suppressed'); });
        for(const association of ['manual','private_filed'] as const)await t.test(`associated ${association} message without any send job denies private attachment bytes and metadata after grant revocation`,async()=>{
            const f=await fixture();if(association==='private_filed'){await db.admin.query('delete from crm_mailbox_links where message_id=$1',[f.messageId]);await f.run(tx=>tx.query("insert into crm_mailbox_private_decisions(workspace_id,user_id,connection_id,provider_id,message_id,project_id,lead_id,contact_id,status,reason) values($1,$2,$3,$4,$5,$6,$7,$8,'filed','SYNTHETIC reviewed private filing')",[f.workspaceId,f.userId,f.connectionId,`source-${f.messageId}`,f.messageId,f.projectId,f.leadId,f.contactId]));}
            const file=await savePersonalAttachment(f.session,{messageId:f.messageId,source:'upload',fileName:'bound.txt',mimeType:'text/plain',data:'cHJpdmF0ZQ==',reviewed:true},metadata(),f.opts);
            assert.equal((await personalReplyState(f.session,f.messageId,f.opts)).jobs.length,0);assert.equal(Buffer.from((await readPersonalAttachment(f.session,f.messageId,file.data.id,f.opts)).bytes).toString(),'private');
            await db.admin.query('update project_pipeline_permissions set can_read=false,can_edit_deals=false where project_id=$1 and user_id=$2',[f.projectId,f.userId]);
            const observed=await Promise.allSettled([personalReplyState(f.session,f.messageId,f.opts),readPersonalAttachment(f.session,f.messageId,file.data.id,f.opts)]);assert.deepEqual(observed.map(value=>value.status),['rejected','rejected']);for(const outcome of observed)if(outcome.status==='rejected')assert.equal(outcome.reason.code,'PROJECT_FORBIDDEN');
            const calls=f.calls.length;await assert.rejects(savePersonalAttachment(f.session,{messageId:f.messageId,source:'received',providerAttachmentId:'file-one',reviewed:true},metadata(),f.opts),{code:'PROJECT_FORBIDDEN'});assert.equal(f.calls.length,calls,'No provider bytes after scope revocation');
            await erasePersonalAttachment(f.session,f.messageId,file.data.id,metadata(),f.opts);assert.equal((await db.admin.query('select status from crm_mailbox_attachment_files where id=$1',[file.data.id])).rows[0].status,'erased');
        });
        await t.test('unassociated personal copy remains owner-readable after unrelated project grant revocation',async()=>{
            const f=await fixture();await db.admin.query('delete from crm_mailbox_links where message_id=$1',[f.messageId]);const file=await savePersonalAttachment(f.session,{messageId:f.messageId,source:'upload',fileName:'personal.txt',mimeType:'text/plain',data:'cHJpdmF0ZQ==',reviewed:true},metadata(),f.opts);await db.admin.query('update project_pipeline_permissions set can_read=false,can_edit_deals=false where project_id=$1 and user_id=$2',[f.projectId,f.userId]);assert.equal((await personalReplyState(f.session,f.messageId,f.opts)).files[0].id,file.data.id);assert.equal(Buffer.from((await readPersonalAttachment(f.session,f.messageId,file.data.id,f.opts)).bytes).toString(),'private');
        });
        await t.test('erasing an approved attachment blocks dispatch and preserves its immutable metadata',async()=>{const f=await fixture(),stored=await savePersonalAttachment(f.session,{messageId:f.messageId,source:'upload',fileName:'approved.txt',mimeType:'text/plain',data:'cHJpdmF0ZQ==',reviewed:true},metadata(),f.opts);f.input.attachmentIds=[stored.data.id];const preview=await previewPersonalReply(f.session,f.input,f.opts);await erasePersonalAttachment(f.session,f.messageId,stored.data.id,metadata(),f.opts);await assert.rejects(sendPersonalReply(f.session,{...f.input,approved:true,previewDigest:preview.digest},metadata(),f.opts),{code:'MAIL_ATTACHMENT_UNAVAILABLE'});assert.equal(f.posts(),0);});
        await t.test('lost provider acknowledgement is terminal across request replay, fresh service instance and a new idempotency key', async () => { const f = await fixture(), preview = await previewPersonalReply(f.session, f.input, f.opts), payload = { ...f.input, approved: true, previewDigest: preview.digest }, meta = metadata(); f.sendMode('lost'); const result = await sendPersonalReply(f.session, payload, meta, f.opts); assert.equal(result.data.status, 'uncertain'); const restart = await new Promise<{status:string;providerCalls:number}>((resolve,reject)=>{const child=spawn(process.execPath,['--conditions=react-server','--import','tsx','scripts/lib/personal-mail-restart-probe.ts'],{cwd:process.cwd(),windowsHide:true,stdio:['pipe','pipe','pipe'],timeout:15000,env:{NODE_ENV:'test',PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,OAUTH_TOKEN_ENCRYPTION_KEY:'synthetic-personal-mail-encryption-20261104'}});let output='',errors='';child.stdout.on('data',b=>{output+=b;if(output.length>10000)child.kill();});child.stderr.on('data',b=>{errors+=b;});child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(new Error('Synthetic restart probe failed: '+errors.slice(-1000)));else{try{resolve(JSON.parse(output));}catch(error){reject(error);}}});child.stdin.end(JSON.stringify({session:f.session,port:db.port,role:db.role,jobId:result.commandId}));});assert.equal(restart.status,'uncertain');assert.equal(restart.providerCalls,0); const freshOptions = { ...options, transport: f.transport }; assert.equal((await dispatchPreparedPersonalReply(f.session, result.commandId, freshOptions)).status, 'uncertain'); await sendPersonalReply(f.session, payload, meta, freshOptions); await assert.rejects(sendPersonalReply(f.session, payload, metadata(), freshOptions), { code: 'MAIL_REPLY_UNRESOLVED' }); await assert.rejects(cancelPreparedPersonalReply(f.session, result.commandId, metadata(), freshOptions), { code: 'MAIL_REPLY_NOT_CANCELLABLE' }); assert.equal(f.posts(), 1); });
        await t.test('lost database acknowledgement after provider call leaves durable dispatching and cannot resend', async () => { const f = await fixture(), preview = await previewPersonalReply(f.session, f.input, f.opts), payload = { ...f.input, approved: true, previewDigest: preview.digest }, meta = metadata(); let failed = false; const faultPool = { async connect() { const client = await db.pool.connect(); return new Proxy(client, { get(target, key) { if (key === 'query')
                    return (sql: unknown, ...args: unknown[]) => { if (!failed && typeof sql === 'string' && sql.startsWith('update crm_mailbox_send_jobs set status=$2')) {
                        failed = true;
                        return Promise.reject(new Error('SYNTHETIC lost outcome persistence'));
                    } return Reflect.apply(target.query, target, [sql, ...args]); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }); } } as unknown as TenantPool; await assert.rejects(sendPersonalReply(f.session, payload, meta, { pool: faultPool, transport: f.transport }), /lost outcome persistence/); const replay = await sendPersonalReply(f.session, payload, meta, f.opts); assert.equal(replay.data.status, 'dispatching'); assert.equal(f.posts(), 1); });
        await t.test('concurrent same-command calls produce one dispatch and changed payload conflicts', async () => { const f = await fixture(), preview = await previewPersonalReply(f.session, f.input, f.opts), payload = { ...f.input, approved: true, previewDigest: preview.digest }, meta = metadata(); const results = await Promise.all([sendPersonalReply(f.session, payload, meta, f.opts), sendPersonalReply(f.session, payload, meta, f.opts)]); assert.equal(results[0].commandId, results[1].commandId); assert.equal(f.posts(), 1); await assert.rejects(sendPersonalReply(f.session, { ...payload, body: 'different' }, meta, f.opts), { code: 'IDEMPOTENCY_CONFLICT' }); });
        await t.test('private-copy erasure also erases cached bytes and prevents rehydration; immutable command audit survives', async () => { const f = await fixture(), stored = await savePersonalAttachment(f.session, { messageId: f.messageId, source: 'upload', fileName: 'safe.txt', mimeType: 'text/plain', data: 'cHJpdmF0ZQ==', reviewed: true }, metadata(), f.opts); const count = (await db.admin.query('select count(*)::int as n from audit_logs')).rows[0].n; await f.run((tx, s) => eraseCrmMailboxCopy(tx, s, f.messageId)); assert.equal((await db.admin.query('select content_encrypted,status from crm_mailbox_attachment_files where id=$1', [stored.data.id])).rows[0].status, 'erased'); assert.equal((await db.admin.query('select count(*)::int as n from audit_logs')).rows[0].n, count); await assert.rejects(previewPersonalReply(f.session, f.input, f.opts), { code: 'MAIL_SOURCE_UNAVAILABLE' }); await assert.rejects(readPersonalAttachment(f.session, f.messageId, stored.data.id, f.opts), { code: 'NOT_FOUND' }); });
    }
    finally {
        await db.stop();
    }
});
