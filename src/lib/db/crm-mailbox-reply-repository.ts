import 'server-only';
import { randomUUID } from 'node:crypto';
import type { AppSession } from '../auth/session';
import { assertCrmFields, assertCrmUuid, assertProjectGrant, crmPayloadDigest, CrmCommandError, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from '../crm-command';
import { getContactVisibilityScope } from '../contact-access';
import { hasMailboxReadScope, type MailboxProvider } from '../crm-mailbox';
import { hasMailboxSendScope, parsePersonalReplyInput, personalMailAddress, personalSha256, type PersonalReplyInput, type PersonalReplyAttachment } from '../crm-mailbox-reply';
import { inspectPersonalMailAttachment } from '../crm-mailbox-attachment';
import { fetchMailboxAccountIdentity, type MailboxTransport } from '../integrations/mailbox-provider';
import { dispatchPersonalReply, fetchPersonalAttachment, fetchPersonalReplySource, type PersonalReplySource } from '../integrations/mailbox-reply-provider';
import { encryptSecret, decryptSecret } from '../integrations/secret-box';
import { unprotectMailboxToken } from './crm-mailbox-repository';
import { evaluateOutboundConsent } from './consent-policy';
import { checkMarketingContactPolicy } from './marketing-contact-policy-repository';
import {assertPersonalMailboxMessageAccess} from './crm-mailbox-message-access';
type Options = TenantTransactionOptions & {
    transport?: MailboxTransport;
};
type Binding = {
    id: string;
    connectionId: string;
    provider: MailboxProvider;
    accountLabel: string;
    accountId: string;
    scopes: string[];
    token: string;
    expiresAt: string;
    connectionRevision: number;
    consentId: string;
    consentIdentity: string;
    providerId: string;
    threadId: string;
    internetMessageId: string;
    subject: string;
    fromAddress: string;
    revision: number;
    contentHash: string;
    immutable: boolean;
    attachments: {
        providerId: string;
        name: string;
        mimeType: string;
        sizeBytes: number;
    }[];
    projectId: string;
    leadId: string;
    contactId: string;
    email: string;
};
type StoredFile = {
    id: string;
    fileName: string;
    mimeType: string;
    sha256: string;
    sizeBytes: number;
    encrypted: string;
    status: string;
    checkCode: string;
};
const fileColumns = 'id,file_name as "fileName",mime_type as "mimeType",content_sha256 as sha256,size_bytes as "sizeBytes",content_encrypted as encrypted,status,check_code as "checkCode"';
type Job = {
    id: string;
    messageId: string;
    projectId: string;
    status: string;
    approvalDigest: string;
    body: string;
    from: string;
    to: string;
    subject: string;
    createdAt: string;
    manifest: {
        id: string;
        sha256: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
    }[];
    sourceRevision: number;
    providerReceipt: Record<string, unknown> | null;
    errorCode: string | null;
    internetId: string;
    updatedAt: string;
};
const jobColumns = 'id,message_id as "messageId",project_id as "projectId",status,approval_digest as "approvalDigest",body_text as body,account_label as "from",recipient_email as "to",subject,created_at::text as "createdAt",attachment_manifest as manifest,source_revision as "sourceRevision",provider_receipt as "providerReceipt",error_code as "errorCode",internet_message_id as "internetId",updated_at::text as "updatedAt"';
function personal(session: AppSession, write = false) {
    if (session.serviceIdentity || session.productRole === 'external_partner')
        throw new CrmCommandError('FORBIDDEN', 'Eine aktuelle persönliche Anmeldung ist erforderlich.', 403);
    assertCrmUuid(session.authIdentityId, 'authIdentityId');
    assertCrmUuid(session.authSessionId, 'authSessionId');
    if (write && (!session.permissions.includes('crm:write') || !session.productPermissions.includes('workspace:operate')))
        throw new CrmCommandError('FORBIDDEN', 'Persönliche CRM-Schreibberechtigung fehlt.', 403);
}
async function binding(tx: TenantTransaction, s: AppSession, messageId: string, send: boolean): Promise<Binding> {
    personal(s, send);
    const row = await tx.queryOne<Binding & {
        deletedAt: string | null;
        status: string;
        access: string;
        expiresAt: string;
    }>(`select m.id,m.connection_id as "connectionId",m.provider_id as "providerId",m.thread_id as "threadId",m.internet_message_id as "internetMessageId",m.subject,m.from_address as "fromAddress",m.revision,m.content_hash as "contentHash",m.attachments,m.deleted_at as "deletedAt",m.provider_id_format='immutable' as immutable,c.provider,c.account_label as "accountLabel",c.provider_account_id as "accountId",c.granted_scopes as scopes,c.status,c.access_token_encrypted as access,c.expires_at::text as "expiresAt",c.revision as "connectionRevision",c.send_consent_id as "consentId",c.send_consent_identity_id as "consentIdentity" from crm_mailbox_messages m join crm_mailbox_connections c on c.id=m.connection_id and c.workspace_id=m.workspace_id and c.user_id=m.user_id where m.id=$1::uuid and m.workspace_id=$2::uuid and m.user_id=$3::uuid for share of m,c`, [assertCrmUuid(messageId), s.workspaceId, s.userId]);
    if (!row || row.deletedAt || row.status !== 'connected' || !row.accountId || !hasMailboxReadScope(row.provider, row.scopes))
        throw new CrmCommandError('MAIL_SOURCE_UNAVAILABLE', 'Die eigene Originalnachricht und eine verifizierte Postfachverbindung sind erforderlich.', 409);
    if(!send)await assertPersonalMailboxMessageAccess(tx,s,messageId);
    if (send && (!row.consentId || row.consentIdentity !== s.authIdentityId || !hasMailboxSendScope(row.provider, row.scopes)))
        throw new CrmCommandError('MAIL_SEND_CONSENT_REQUIRED', 'Lesen und Antworten zuerst ausdrücklich für dieses persönliche Konto freigeben.', 409);
    const token = unprotectMailboxToken(s, row.provider, row.access, row.accountLabel);
    if (!token || Date.parse(row.expiresAt) < Date.now() + 20000)
        throw new CrmCommandError('MAIL_REAUTH_REQUIRED', 'Das persönliche Konto muss erneut bestätigt werden. Es wird kein anderes Konto verwendet.', 409);
    // Reply rights come from an explicit CRM association, never from untrusted mail text.
    if (send) {
        const link = await tx.queryOne<{
            projectId: string;
            leadId: string;
            contactId: string;
        }>(`select project_id as "projectId",lead_id as "leadId",contact_id as "contactId" from crm_mailbox_links where workspace_id=$1::uuid and user_id=$2::uuid and message_id=$3::uuid`, [s.workspaceId, s.userId, messageId]);
        const privateLink = link ?? await tx.queryOne<{
            projectId: string;
            leadId: string;
            contactId: string;
        }>(`select project_id as "projectId",lead_id as "leadId",contact_id as "contactId" from crm_mailbox_private_decisions where workspace_id=$1::uuid and user_id=$2::uuid and message_id=$3::uuid and status='filed'`, [s.workspaceId, s.userId, messageId]);
        if (!privateLink)
            throw new CrmCommandError('MAIL_ASSOCIATION_REQUIRED', 'Die Nachricht zuerst einem aktuell berechtigten CRM-Kontakt zuordnen.', 409);
        await assertProjectGrant(tx, s, privateLink.projectId, true);
        const contact = await tx.queryOne<{
            email: string;
            ownerId: string | null;
        }>(`select c.email,c.owner_user_id as "ownerId" from leads l join contacts c on c.id=l.contact_id and c.workspace_id=l.workspace_id and c.project_id=l.project_id where l.workspace_id=$1::uuid and l.id=$2::uuid and l.project_id=$3::uuid and c.id=$4::uuid and c.archived_at is null for update of c`, [s.workspaceId, privateLink.leadId, privateLink.projectId, privateLink.contactId]);
        const scope = getContactVisibilityScope(s);
        if (!contact || scope.kind === 'none' || scope.kind === 'own' && scope.userId !== contact.ownerId)
            throw new CrmCommandError('MAIL_CONTACT_FORBIDDEN', 'Der aktuelle Originalkontakt ist nicht freigegeben.', 403);
        Object.assign(row, privateLink, { email: personalMailAddress(contact.email) });
    }
    return { ...row, token };
}
function stable(b: Binding) { return { messageId: b.id, connectionId: b.connectionId, provider: b.provider, accountLabel: b.accountLabel, accountId: b.accountId, connectionRevision: b.connectionRevision, consentId: b.consentId, consentIdentity: b.consentIdentity, providerId: b.providerId, threadId: b.threadId, internetMessageId: b.internetMessageId, subject: b.subject, fromAddress: b.fromAddress, revision: b.revision, contentHash: b.contentHash, immutable: b.immutable, projectId: b.projectId, leadId: b.leadId, contactId: b.contactId, email: b.email }; }
async function source(b: Binding, transport?: MailboxTransport) {
    const account = await fetchMailboxAccountIdentity(b.provider, b.token, transport);
    if (account.label !== b.accountLabel || account.accountId !== b.accountId)
        throw new CrmCommandError('MAIL_ACCOUNT_CHANGED', 'Die persönliche Anbieteridentität stimmt nicht mehr überein.', 409);
    const original = await fetchPersonalReplySource(b.provider, b.token, b.providerId, b.immutable, transport);
    if (original.threadId !== b.threadId || original.internetMessageId !== b.internetMessageId || original.subject !== b.subject || original.from !== b.fromAddress || original.replyTo !== b.email)
        throw new CrmCommandError('MAIL_REPLY_SOURCE_CHANGED', 'Originalnachricht oder Empfänger weicht ab. Quelle neu prüfen und Zuordnung bestätigen.', 409);
    // Microsoft MIME reply has no documented override of the original sender.
    if (b.provider === 'microsoft' && original.replyTo !== original.from)
        throw new CrmCommandError('MAIL_REPLY_RECIPIENT_AMBIGUOUS', 'Abweichende Reply-To-Adresse erfordert eine getrennte manuelle Prüfung.', 409);
    return original;
}
function encryptedFile(s: AppSession, messageId: string, id: string, bytes: Uint8Array) { return encryptSecret(JSON.stringify({ purpose: 'crm-personal-mail-attachment-v1', workspaceId: s.workspaceId, userId: s.userId, messageId, id, data: Buffer.from(bytes).toString('base64') })); }
function decryptedFile(s: AppSession, messageId: string, f: StoredFile): PersonalReplyAttachment {
    try {
        const data = JSON.parse(decryptSecret(f.encrypted) ?? 'null');
        if (!data || data.purpose !== 'crm-personal-mail-attachment-v1' || data.workspaceId !== s.workspaceId || data.userId !== s.userId || data.messageId !== messageId || data.id !== f.id || typeof data.data !== 'string')
            throw new Error('context');
        const bytes = Buffer.from(data.data, 'base64');
        if (bytes.length !== f.sizeBytes || personalSha256(bytes) !== f.sha256)
            throw new Error('hash');
        return { id: f.id, fileName: f.fileName, mimeType: f.mimeType, sha256: f.sha256, bytes };
    }
    catch {
        throw new CrmCommandError('MAIL_ATTACHMENT_CONTEXT', 'Die private Datei ist nicht mehr unverändert verfügbar.', 409);
    }
}
async function files(tx: TenantTransaction, s: AppSession, input: PersonalReplyInput) {
    const rows = await tx.query<StoredFile>(`select ${fileColumns} from crm_mailbox_attachment_files where workspace_id=$1::uuid and user_id=$2::uuid and message_id=$3::uuid and id=any($4::uuid[]) for share`, [s.workspaceId, s.userId, input.messageId, input.attachmentIds]);
    if (rows.length !== input.attachmentIds.length || rows.some(f => f.status !== 'ready'))
        throw new CrmCommandError('MAIL_ATTACHMENT_UNAVAILABLE', 'Ausgewählte private Dateien fehlen oder sind gesperrt.', 409);
    return input.attachmentIds.map(id => decryptedFile(s, input.messageId, rows.find(f => f.id === id)!));
}
const manifest = (all: PersonalReplyAttachment[]) => all.map(f => ({ id: f.id, fileName: f.fileName, mimeType: f.mimeType, sha256: f.sha256, sizeBytes: f.bytes.length }));
const digest = (b: Binding, original: PersonalReplySource, input: PersonalReplyInput, all: PersonalReplyAttachment[]) => crmPayloadDigest({ version: 1, purpose: 'salesFollowUp', binding: stable(b), source: original, body: input.body, attachments: manifest(all) });
async function consent(tx: TenantTransaction, s: AppSession, b: Binding) {
    const allowed = await evaluateOutboundConsent({ session: s, channel: 'E-Mail', purpose: 'salesFollowUp', contactId: b.contactId, projectId: b.projectId, email: b.email, metadata: { source: 'personal_mail_explicit_reply', messageId: b.id } });
    if (!allowed.allowed)
        throw new CrmCommandError('MAIL_OUTBOUND_CONSENT_DENIED', 'Die vorhandene Kontakt-/Widerspruchsregel erlaubt diese Antwort nicht.', 409);
    const policy = await checkMarketingContactPolicy(tx, s, { contactId: b.contactId, email: b.email, lock: true });
    if (!policy.allowed)
        throw new CrmCommandError('MAIL_CONTACT_POLICY_DENIED', 'Die aktuelle Kontaktregel sperrt den Versand.', 409);
}
export async function previewPersonalReply(s: AppSession, raw: Record<string, unknown>, options: Options = {}) {
    const input = parsePersonalReplyInput(raw), before = await withCrmRead(s, (tx, fresh) => binding(tx, fresh, input.messageId, true), options), original = await source(before, options.transport);
    return withCrmRead(s, async (tx, fresh) => { const current = await binding(tx, fresh, input.messageId, true); if (crmPayloadDigest(stable(current)) !== crmPayloadDigest(stable(before)))
        throw new CrmCommandError('MAIL_PREVIEW_STALE', 'Die Quelle wurde inzwischen geändert.', 409); await consent(tx, fresh, current); const all = await files(tx, fresh, input); return { digest: digest(current, original, input, all), from: current.accountLabel, to: current.email, subject: current.subject, body: input.body, attachments: manifest(all), purpose: 'salesFollowUp', deliveryVerified: false }; }, options);
}
function jobDto(job: Job) { return { id: job.id, messageId: job.messageId, status: job.status, acceptedByProvider: job.status === 'accepted', deliveryVerified: false, receipt: job.providerReceipt, errorCode: job.errorCode, updatedAt: job.updatedAt, retryAllowed: false }; }
async function loadJob(tx: TenantTransaction, s: AppSession, id: string) { personal(s, true); const job = await tx.queryOne<Job>(`select ${jobColumns} from crm_mailbox_send_jobs where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid for update`, [assertCrmUuid(id), s.workspaceId, s.userId]); if (!job)
    throw new CrmCommandError('NOT_FOUND', 'Eigener Antwortbeleg nicht verfügbar.', 404); await assertProjectGrant(tx, s, job.projectId, true); return job; }
export async function personalReplyState(s: AppSession, messageId: string, options: Options = {}) {
    return withCrmRead(s, async (tx, fresh) => { personal(fresh); await assertPersonalMailboxMessageAccess(tx,fresh,messageId); const all = await tx.query<StoredFile>(`select ${fileColumns} from crm_mailbox_attachment_files where workspace_id=$1::uuid and user_id=$2::uuid and message_id=$3::uuid order by created_at limit 50`, [fresh.workspaceId, fresh.userId, messageId]); const jobs = await tx.query<Job>(`select ${jobColumns} from crm_mailbox_send_jobs where workspace_id=$1::uuid and user_id=$2::uuid and message_id=$3::uuid order by created_at desc limit 20`, [fresh.workspaceId, fresh.userId, messageId]); for (const job of jobs)
        await assertProjectGrant(tx, fresh, job.projectId, true); return { files: all.map(f => ({ id: f.id, fileName: f.fileName, mimeType: f.mimeType, sha256: f.sha256, sizeBytes: f.sizeBytes, status: f.status, checkCode: f.checkCode })), jobs: jobs.map(job=>({...jobDto(job),from:job.from,to:job.to,subject:job.subject,body:job.body,createdAt:job.createdAt,attachments:job.manifest})) }; }, options);
}
export async function sendPersonalReply(s: AppSession, raw: Record<string, unknown>, metadata: {
    idempotencyKey: string;
    correlationId: string;
}, options: Options = {}) {
    assertCrmFields(raw, ['messageId', 'body', 'attachmentIds', 'approved', 'previewDigest']);
    if (raw.approved !== true || typeof raw.previewDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.previewDigest))
        throw new CrmCommandError('MAIL_APPROVAL_REQUIRED', 'Die unveränderte Vorschau ausdrücklich bestätigen.', 409);
    const input = parsePersonalReplyInput({ messageId: raw.messageId, body: raw.body, attachmentIds: raw.attachmentIds }), approved = raw.previewDigest;
    const prepared = await executeCrmCommand(s, { operation: 'mailbox.reply.prepare', capability: 'workspace:operate', resourceId: input.messageId, payload: { ...input, approved: true, previewDigest: approved }, ...metadata }, async (tx, context) => {
        const b = await binding(tx, context.session, input.messageId, true);
        await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`mailbox-reply:${b.connectionId}:${b.id}`]);
        const pending = await tx.queryOne("select id from crm_mailbox_send_jobs where connection_id=$1::uuid and message_id=$2::uuid and status in('prepared','dispatching','uncertain')", [b.connectionId, b.id]);
        if (pending)
            throw new CrmCommandError('MAIL_REPLY_UNRESOLVED', 'Eine Antwort ist vorbereitet oder ihr Versand ist ungeklärt. Den vorhandenen Beleg prüfen; keinen neuen Versand starten.', 409);
        // The real provider source is obtained after this durable, non-sending preparation.
        const all = await files(tx, context.session, input);
        await consent(tx, context.session, b);
        const internetId = `<novalure-reply-${context.commandId}@${b.accountLabel.split('@')[1]}>`;
        await tx.execute(`insert into crm_mailbox_send_jobs(id,workspace_id,user_id,connection_id,message_id,project_id,contact_id,lead_id,identity_id,send_consent_id,approval_digest,source_revision,provider,account_label,provider_account_id,recipient_email,subject,body_text,thread_id,source_provider_id,source_internet_id,internet_message_id,attachment_manifest) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::uuid,$10::uuid,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb)`, [context.commandId, s.workspaceId, s.userId, b.connectionId, b.id, b.projectId, b.contactId, b.leadId, s.authIdentityId, b.consentId, approved, b.revision, b.provider, b.accountLabel, b.accountId, b.email, b.subject, input.body, b.threadId, b.providerId, b.internetMessageId, internetId, JSON.stringify(manifest(all))]);
        return { id: context.commandId, status: 'prepared' };
    }, options);
    const job = await dispatchPreparedPersonalReply(s, prepared.data.id, options);
    return { data: job, replayed: prepared.replayed, auditReference: prepared.auditReference, commandId: prepared.commandId };
}
/** A prepared row proves no provider call has started. Dispatching/unknown can never be replayed. */
export async function dispatchPreparedPersonalReply(s: AppSession, id: string, options: Options = {}) {
    const before = await withCrmRead(s, async (tx, fresh) => { const job = await loadJob(tx, fresh, id); if (job.status !== 'prepared')
        return { job, b: null }; const b = await binding(tx, fresh, job.messageId, true); return { job, b }; }, options);
    if (!before.b)
        return jobDto(before.job);
    let original: PersonalReplySource;
    try {
        original = await source(before.b, options.transport);
    }
    catch (error) {
        await withCrmRead(s, async (tx, fresh) => { const job = await loadJob(tx, fresh, id); if (job.status === 'prepared')
            await tx.execute("update crm_mailbox_send_jobs set status='suppressed',error_code='MAIL_SOURCE_RECHECK_FAILED',updated_at=now() where id=$1::uuid", [id]); }, options);
        throw error;
    }
    const claimed = await withCrmRead(s, async (tx, fresh) => { const job = await loadJob(tx, fresh, id); if (job.status !== 'prepared')
        return false; const b = await binding(tx, fresh, job.messageId, true), input = { messageId: job.messageId, body: job.body, attachmentIds: job.manifest.map(f => f.id) }, all = await files(tx, fresh, input); await consent(tx, fresh, b); if (digest(b, original, input, all) !== job.approvalDigest)
        throw new CrmCommandError('MAIL_PREVIEW_STALE', 'Die bestätigte Vorschau ist veraltet. Kein Versand wurde ausgeführt.', 409); await tx.execute("update crm_mailbox_send_jobs set status='dispatching',updated_at=now() where id=$1::uuid", [id]); return true; }, options);
    if (!claimed)
        return withCrmRead(s, async (tx, fresh) => jobDto(await loadJob(tx, fresh, id)), options);
    // The claim is committed before I/O. A crash/lost DB acknowledgement cannot produce a second send.
    return withCrmRead(s, async (tx, fresh) => {
        const job = await loadJob(tx, fresh, id);
        if (job.status !== 'dispatching')
            return jobDto(job);
        const b = await binding(tx, fresh, job.messageId, true), input = { messageId: job.messageId, body: job.body, attachmentIds: job.manifest.map(f => f.id) }, all = await files(tx, fresh, input);
        await consent(tx, fresh, b);
        if (digest(b, original, input, all) !== job.approvalDigest)
            throw new CrmCommandError('MAIL_PREVIEW_STALE', 'Die Quelle wurde vor Versand geändert. Der Beleg bleibt vorsorglich gesperrt.', 409);
        // Keep current membership/project/contact/connection locks through the single bounded provider request.
        const result = await dispatchPersonalReply({ provider: b.provider, token: b.token, scopes: b.scopes, source: original, from: b.accountLabel, to: b.email, body: job.body, internetMessageId: job.internetId, jobId: id, attachments: all }, options.transport);
        const saved = await tx.queryOne<Job>(`update crm_mailbox_send_jobs set status=$2,provider_message_id=$3,provider_receipt=$4::jsonb,error_code=$5,accepted_at=case when $2='accepted' then now() end,updated_at=now() where id=$1::uuid returning ${jobColumns}`, [id, result.status, result.providerMessageId, result.receipt ? JSON.stringify(result.receipt) : null, result.errorCode]);
        if (!saved)
            throw new CrmCommandError('MAIL_RECEIPT_UNCONFIRMED', 'Versandausgang unklar. Den vorhandenen Beleg prüfen; nicht erneut senden.', 503);
        await tx.execute("insert into audit_logs(id,workspace_id,actor_user_id,project_id,action,entity_type,entity_id,after) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'mailbox.reply.outcome','crm_mailbox_send_job',$5::uuid,$6::jsonb)", [randomUUID(), fresh.workspaceId, fresh.userId, b.projectId, id, JSON.stringify({ commandId: id, status: result.status, deliveryVerified: false })]);
        return jobDto(saved);
    }, options);
}
export async function savePersonalAttachment(s: AppSession, raw: Record<string, unknown>, metadata: {
    idempotencyKey: string;
    correlationId: string;
}, options: Options = {}) {
    assertCrmFields(raw, ['messageId', 'source', 'providerAttachmentId', 'fileName', 'mimeType', 'data', 'reviewed']);
    const messageId = assertCrmUuid(raw.messageId);
    if (raw.reviewed !== true || !['received', 'upload'].includes(String(raw.source)))
        throw new CrmCommandError('MAIL_ATTACHMENT_REVIEW_REQUIRED', 'Die einzelne private Datei ausdrücklich auswählen.', 409);
    const before = await withCrmRead(s, (tx, fresh) => binding(tx, fresh, messageId, false), options);
    let input: {
        fileName: string;
        mimeType: string;
        bytes: Uint8Array;
    };
    if (raw.source === 'received') {
        if (typeof raw.providerAttachmentId !== 'string' || raw.data !== undefined)
            throw new CrmCommandError('INVALID_ATTACHMENT', 'Die Originaldatei eindeutig auswählen.');
        const meta = before.attachments.find(f => f.providerId === raw.providerAttachmentId);
        if (!meta)
            throw new CrmCommandError('MAIL_ATTACHMENT_NOT_FOUND', 'Datei gehört nicht zu dieser persönlichen Nachricht.', 404);
        const identity = await fetchMailboxAccountIdentity(before.provider, before.token, options.transport);
        if (identity.accountId !== before.accountId || identity.label !== before.accountLabel)
            throw new CrmCommandError('MAIL_ACCOUNT_CHANGED', 'Persönliche Kontoidentität stimmt nicht überein.', 409);
        input = await fetchPersonalAttachment({ provider: before.provider, token: before.token, messageId: before.providerId, attachmentId: raw.providerAttachmentId, immutable: before.immutable, scopes: before.scopes }, options.transport);
        if (input.fileName !== meta.name || input.mimeType !== meta.mimeType || input.bytes.length !== meta.sizeBytes)
            throw new CrmCommandError('MAIL_ATTACHMENT_SOURCE_CHANGED', 'Die Originaldatei wurde geändert. Neu importieren.', 409);
    }
    else {
        if (raw.providerAttachmentId !== undefined || typeof raw.data !== 'string' || raw.data.length > 2796204 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(raw.data))
            throw new CrmCommandError('INVALID_ATTACHMENT', 'Begrenzte Base64-Datei erforderlich.');
        input = { fileName: String(raw.fileName ?? ''), mimeType: String(raw.mimeType ?? ''), bytes: Buffer.from(raw.data, 'base64') };
    }
    // Failed checks persist only a hash/metadata quarantine record; no untrusted bytes leave quarantine.
    let inspected: Awaited<ReturnType<typeof inspectPersonalMailAttachment>> | null = null;
    try {
        inspected = await inspectPersonalMailAttachment(input);
    }
    catch (error) {
        if (!(error instanceof CrmCommandError) || error.code !== 'MAIL_ATTACHMENT_QUARANTINED')
            throw error;
    }
    if (!input.bytes.length || input.bytes.length > 2097152)
        throw new CrmCommandError('MAIL_ATTACHMENT_TOO_LARGE', 'Höchstens2 MiB je Datei.');
    const safe = inspected ?? { fileName: 'blocked-attachment', mimeType: 'application/octet-stream', sha256: personalSha256(input.bytes), sizeBytes: input.bytes.length, checkCode: 'QUARANTINED_CONTENT_NOT_RELEASED' };
    return withCrmRead(s, async (currentTx, fresh) => {
        // Provider I/O released the first transaction. Recheck/lock the current
        // association before even a matching receipt can return old metadata.
        // The nested command reuses this transaction and its scope locks.
        const now = await binding(currentTx, fresh, messageId, false);
        if (now.connectionId !== before.connectionId || now.connectionRevision !== before.connectionRevision || now.revision !== before.revision || now.contentHash !== before.contentHash)
            throw new CrmCommandError('MAIL_ATTACHMENT_SOURCE_CHANGED', 'Die Nachrichtenquelle wurde inzwischen geändert.', 409);
        return executeCrmCommand(fresh, { operation: 'mailbox.attachment.store', capability: 'workspace:operate', resourceId: messageId, payload: { messageId, source: raw.source, providerAttachmentId: raw.providerAttachmentId ?? null, sha256: safe.sha256, fileName: safe.fileName, mimeType: safe.mimeType, sizeBytes: safe.sizeBytes, status: inspected ? 'ready' : 'rejected' }, ...metadata }, async (tx, context) => {
        await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`mailbox-private-files:${s.workspaceId}:${s.userId}`]);
        const quota = await tx.queryOne<{
            files: number;
            bytes: string;
        }>("select count(*)::int as files,coalesce(sum(size_bytes) filter(where status='ready'),0)::text as bytes from crm_mailbox_attachment_files where workspace_id=$1::uuid and user_id=$2::uuid", [s.workspaceId, s.userId]);
        if (!quota || quota.files >= 1000 || Number(quota.bytes) + safe.sizeBytes > 52428800)
            throw new CrmCommandError('MAIL_ATTACHMENT_QUOTA', 'Privates Dateilimit erreicht. Geprüfte Dateien bei Bedarf löschen.', 409);
        const count = await tx.queryOne<{
            n: number;
        }>('select count(*)::int as n from crm_mailbox_attachment_files where workspace_id=$1::uuid and user_id=$2::uuid and message_id=$3::uuid', [s.workspaceId, s.userId, messageId]);
        if (!count || count.n >= 50)
            throw new CrmCommandError('MAIL_ATTACHMENT_QUOTA', 'Höchstens50 private Dateibelege je Nachricht.', 409);
        const id = randomUUID();
        await tx.execute(`insert into crm_mailbox_attachment_files(id,workspace_id,user_id,connection_id,message_id,provider_attachment_id,source_kind,file_name,mime_type,content_sha256,size_bytes,content_encrypted,status,check_code) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [id, s.workspaceId, s.userId, now.connectionId, messageId, raw.source === 'received' ? raw.providerAttachmentId : null, raw.source, safe.fileName, safe.mimeType, safe.sha256, safe.sizeBytes, inspected ? encryptedFile(context.session, messageId, id, inspected.bytes) : null, inspected ? 'ready' : 'rejected', safe.checkCode]);
        return { id, fileName: safe.fileName, mimeType: safe.mimeType, sha256: safe.sha256, sizeBytes: safe.sizeBytes, status: inspected ? 'ready' : 'rejected', checkCode: safe.checkCode };
        }, options);
    }, options);
}
export async function readPersonalAttachment(s: AppSession, messageId: string, id: string, options: Options = {}) {
    return withCrmRead(s, async (tx, fresh) => { personal(fresh); await assertPersonalMailboxMessageAccess(tx,fresh,messageId); const file = await tx.queryOne<StoredFile>(`select ${fileColumns} from crm_mailbox_attachment_files where workspace_id=$1::uuid and user_id=$2::uuid and message_id=$3::uuid and id=$4::uuid and status='ready'`, [fresh.workspaceId, fresh.userId, messageId, assertCrmUuid(id)]); if (!file)
        throw new CrmCommandError('NOT_FOUND', 'Eigene geprüfte Datei nicht verfügbar.', 404); return decryptedFile(fresh, messageId, file); }, options);
}
export async function erasePersonalAttachment(s: AppSession, messageId: string, id: string, metadata: {
    idempotencyKey: string;
    correlationId: string;
}, options: Options = {}) {
    return executeCrmCommand(s, { operation: 'mailbox.attachment.erase', resourceId: assertCrmUuid(messageId), capability: 'workspace:operate', payload: { messageId, id: assertCrmUuid(id) }, ...metadata }, async (tx, context) => { personal(context.session, true); const row = await tx.queryOne("update crm_mailbox_attachment_files set status='erased',content_encrypted=null where workspace_id=$1::uuid and user_id=$2::uuid and message_id=$3::uuid and id=$4::uuid and status='ready' returning id,status", [s.workspaceId, s.userId, messageId, id]); if (!row)
        throw new CrmCommandError('NOT_FOUND', 'Eigene freigegebene Datei nicht verfügbar.', 404); return row; }, options);
}
/** Only a prepared row proves no dispatch has started. Unknown outcomes cannot be cancelled into retryability. */
export async function cancelPreparedPersonalReply(s: AppSession, id: string, metadata: {
    idempotencyKey: string;
    correlationId: string;
}, options: Options = {}) {
    return executeCrmCommand(s, { operation: 'mailbox.reply.cancel_prepared', resourceId: assertCrmUuid(id), capability: 'workspace:operate', payload: { id }, ...metadata }, async (tx, context) => { const job = await loadJob(tx, context.session, id); if (job.status !== 'prepared')
        throw new CrmCommandError('MAIL_REPLY_NOT_CANCELLABLE', 'Nur nachweislich noch nicht gestartete Antworten können verworfen werden.', 409); await tx.execute("update crm_mailbox_send_jobs set status='suppressed',error_code='CANCELLED_BEFORE_DISPATCH',updated_at=now() where id=$1::uuid", [id]); return { id, status: 'suppressed' }; }, options);
}
