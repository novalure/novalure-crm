import 'server-only';
import { hasMailboxReadScope, mailboxAddress, mailboxProviderId, mailboxText, type MailboxProvider } from '../crm-mailbox';
import { hasMailboxSendScope, personalInternetId, personalMailAddress, personalReplyMime, MAX_PERSONAL_ATTACHMENT_BYTES, type PersonalReplyAttachment } from '../crm-mailbox-reply';
import { MailboxProviderError, mailboxProviderJson, type MailboxTransport } from './mailbox-provider';
const transportDefault: MailboxTransport = (url, init) => fetch(url, init);
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const auth = (token: string, immutable: boolean) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json', ...(immutable ? { Prefer: 'IdType="ImmutableId"' } : {}) });
export type PersonalReplySource = {
    providerId: string;
    threadId: string;
    internetMessageId: string;
    subject: string;
    from: string;
    replyTo: string;
};
export async function fetchPersonalReplySource(provider: MailboxProvider, token: string, id: string, immutable: boolean, transport: MailboxTransport = transportDefault): Promise<PersonalReplySource> {
    const encoded = encodeURIComponent(mailboxProviderId(id));
    const url = provider === 'google' ? `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encoded}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID`
        : `https://graph.microsoft.com/v1.0/me/messages/${encoded}?$select=id,conversationId,internetMessageId,subject,from,replyTo`;
    const raw = await mailboxProviderJson(url, { headers: auth(token, immutable) }, transport, 65536);
    if (raw.id !== id)
        throw new MailboxProviderError('MAIL_MESSAGE_ID_CHANGED');
    if (provider === 'microsoft') {
        const from = personalMailAddress(object(object(raw.from).emailAddress).address);
        if (raw.replyTo !== undefined && (!Array.isArray(raw.replyTo) || raw.replyTo.length > 1))
            throw new MailboxProviderError('MAIL_REPLY_RECIPIENT_AMBIGUOUS');
        const reply = Array.isArray(raw.replyTo) && raw.replyTo.length ? personalMailAddress(object(object(raw.replyTo[0]).emailAddress).address) : from;
        return { providerId: id, threadId: mailboxProviderId(raw.conversationId), internetMessageId: personalInternetId(raw.internetMessageId), subject: mailboxText(raw.subject, 1000), from, replyTo: reply };
    }
    const headers = object(raw.payload).headers;
    if (!Array.isArray(headers) || headers.length > 200)
        throw new MailboxProviderError('MAIL_HEADERS_INVALID');
    const header = (name: string) => {
        const values = headers.map(object).filter(row => String(row.name).toLowerCase() === name.toLowerCase());
        if (values.length > 1)
            throw new MailboxProviderError('MAIL_HEADERS_INVALID');
        return values.length ? mailboxText(values[0].value, 2000) : '';
    };
    const from = mailboxAddress(header('From'));
    const reply = header('Reply-To');
    if (!from || reply && !mailboxAddress(reply))
        throw new MailboxProviderError('MAIL_REPLY_RECIPIENT_AMBIGUOUS');
    return { providerId: id, threadId: mailboxProviderId(raw.threadId), internetMessageId: personalInternetId(header('Message-ID')), subject: header('Subject'), from, replyTo: reply ? mailboxAddress(reply)! : from };
}
function decoded(value: unknown): Buffer {
    if (typeof value !== 'string' || value.length > Math.ceil(MAX_PERSONAL_ATTACHMENT_BYTES / 3) * 4 + 8 || !/^[A-Za-z0-9+/_=-]*$/u.test(value))
        throw new MailboxProviderError('MAIL_ATTACHMENT_INVALID');
    const bytes = Buffer.from(value, 'base64');
    if (!bytes.length || bytes.length > MAX_PERSONAL_ATTACHMENT_BYTES)
        throw new MailboxProviderError('MAIL_ATTACHMENT_TOO_LARGE');
    return bytes;
}
export async function fetchPersonalAttachment(input: {
    provider: MailboxProvider;
    token: string;
    messageId: string;
    attachmentId: string;
    immutable: boolean;
    scopes: string[];
}, transport: MailboxTransport = transportDefault) {
    if (!hasMailboxReadScope(input.provider, input.scopes))
        throw new MailboxProviderError('MAIL_SCOPE_REQUIRED');
    const message = encodeURIComponent(mailboxProviderId(input.messageId)), attachment = encodeURIComponent(mailboxProviderId(input.attachmentId));
    if (input.provider === 'microsoft') {
        const raw = await mailboxProviderJson(`https://graph.microsoft.com/v1.0/me/messages/${message}/attachments/${attachment}`, { headers: auth(input.token, input.immutable) }, transport, 3 * 1024 * 1024);
        if (raw.id !== input.attachmentId || raw['@odata.type'] !== '#microsoft.graph.fileAttachment')
            throw new MailboxProviderError('MAIL_ATTACHMENT_TYPE_UNSUPPORTED');
        return { bytes: decoded(raw.contentBytes), fileName: mailboxText(raw.name, 180), mimeType: mailboxText(raw.contentType, 100) };
    }
    const raw = await mailboxProviderJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${message}?format=full`, { headers: auth(input.token, false) }, transport, 3 * 1024 * 1024);
    if (raw.id !== input.messageId)
        throw new MailboxProviderError('MAIL_MESSAGE_ID_CHANGED');
    let nodes = 0, found: Record<string, unknown> | null = null;
    const walk = (part: Record<string, unknown>, depth: number) => {
        if (++nodes > 200 || depth > 10)
            throw new MailboxProviderError('MAIL_MIME_TOO_COMPLEX');
        const body = object(part.body), name = mailboxText(part.filename, 180);
        if (name || body.attachmentId) {
            const id = body.attachmentId || part.partId || `inline-${nodes}`;
            if (id === input.attachmentId) {
                if (found)
                    throw new MailboxProviderError('MAIL_ATTACHMENT_AMBIGUOUS');
                found = part;
            }
            return;
        }
        if (Array.isArray(part.parts)) {
            if (part.parts.length > 100)
                throw new MailboxProviderError('MAIL_MIME_TOO_COMPLEX');
            for (const child of part.parts)
                walk(object(child), depth + 1);
        }
    };
    walk(object(raw.payload), 0);
    if (!found)
        throw new MailboxProviderError('MAIL_ATTACHMENT_NOT_FOUND');
    const part = found as Record<string, unknown>, body = object(part.body);
    const payload = body.attachmentId ? await mailboxProviderJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${message}/attachments/${attachment}`, { headers: auth(input.token, false) }, transport, 3 * 1024 * 1024) : body;
    return { bytes: decoded(payload.data), fileName: mailboxText(part.filename, 180), mimeType: mailboxText(part.mimeType, 100) };
}
export type PersonalSendResult = {
    status: 'accepted' | 'rejected' | 'uncertain';
    providerMessageId: string | null;
    receipt: Record<string, unknown> | null;
    errorCode: string | null;
};
export async function dispatchPersonalReply(input: {
    provider: MailboxProvider;
    token: string;
    scopes: string[];
    source: PersonalReplySource;
    from: string;
    to: string;
    body: string;
    internetMessageId: string;
    jobId: string;
    attachments: PersonalReplyAttachment[];
}, transport: MailboxTransport = transportDefault): Promise<PersonalSendResult> {
    if (!hasMailboxSendScope(input.provider, input.scopes))
        throw new MailboxProviderError('MAIL_SEND_CONSENT_REQUIRED');
    if (personalMailAddress(input.to) !== input.source.replyTo)
        throw new MailboxProviderError('MAIL_REPLY_RECIPIENT_CHANGED');
    const mime = personalReplyMime({ from: input.from, to: input.to, subject: input.source.subject, body: input.body, internetMessageId: input.internetMessageId, inReplyTo: input.source.internetMessageId, attachments: input.attachments });
    const url = input.provider === 'google' ? 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send' : `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(input.source.providerId)}/reply`;
    try {
        const response = await transport(url, { method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': input.provider === 'google' ? 'application/json' : 'text/plain', 'client-request-id': input.jobId }, body: input.provider === 'google' ? JSON.stringify({ threadId: input.source.threadId, raw: mime.toString('base64url') }) : mime.toString('base64') });
        if (!response.ok)
            return { status: response.status >= 400 && response.status < 500 && response.status !== 408 ? 'rejected' : 'uncertain', providerMessageId: null, receipt: null, errorCode: response.status === 401 || response.status === 403 ? 'MAIL_REAUTH_REQUIRED' : 'MAIL_PROVIDER_NOT_ACCEPTED' };
        if (input.provider === 'microsoft')
            return response.status === 202 ? { status: 'accepted', providerMessageId: null, receipt: { provider: 'microsoft', httpStatus: 202, internetMessageId: input.internetMessageId, acceptedByProvider: true, deliveryVerified: false }, errorCode: null } : { status: 'uncertain', providerMessageId: null, receipt: null, errorCode: 'MAIL_PROVIDER_RESPONSE_UNPROVEN' };
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error('missing');
        let length = 0;
        const chunks: Uint8Array[] = [];
        try {
            for (;;) {
                const value = await reader.read();
                if (value.done)
                    break;
                length += value.value.byteLength;
                if (length > 65536)
                    throw new Error('large');
                chunks.push(value.value);
            }
        }
        finally {
            await reader.cancel().catch(() => { });
            reader.releaseLock();
        }
        const data = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (typeof data.id !== 'string' || !data.id || data.id.length > 1024 || data.threadId !== input.source.threadId)
            throw new Error('unproven');
        return { status: 'accepted', providerMessageId: data.id, receipt: { provider: 'google', httpStatus: response.status, providerMessageId: data.id, threadId: data.threadId, internetMessageId: input.internetMessageId, acceptedByProvider: true, deliveryVerified: false }, errorCode: null };
    }
    catch {
        return { status: 'uncertain', providerMessageId: null, receipt: null, errorCode: 'MAIL_PROVIDER_OUTCOME_UNKNOWN' };
    }
}
