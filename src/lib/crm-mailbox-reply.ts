import { createHash } from 'node:crypto';
import { CrmCommandError, assertCrmFields, assertCrmUuid } from './crm-command';
import { mailboxAddress, mailboxText, type MailboxProvider } from './crm-mailbox';
export const MAX_PERSONAL_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_PERSONAL_REPLY_ATTACHMENTS = 5;
export const mailboxReplyScopes = {
    microsoft: 'https://graph.microsoft.com/Mail.Send',
    google: 'https://www.googleapis.com/auth/gmail.send',
} as const;
export function hasMailboxSendScope(provider: MailboxProvider, scopes: readonly string[]) {
    return provider === 'google' ? scopes.includes(mailboxReplyScopes.google)
        : scopes.some(scope => /^(?:https:\/\/graph\.microsoft\.com\/)?Mail\.Send$/i.test(scope));
}
export type PersonalReplyInput = {
    messageId: string;
    body: string;
    attachmentIds: string[];
};
export function parsePersonalReplyInput(raw: Record<string, unknown>): PersonalReplyInput {
    assertCrmFields(raw, ['messageId', 'body', 'attachmentIds']);
    if (typeof raw.body !== 'string' || !raw.body.trim() || Buffer.byteLength(raw.body) > 65536 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw.body))
        throw new CrmCommandError('MAIL_BODY_INVALID', 'Eine begrenzte reine Textantwort ist erforderlich.');
    if (!Array.isArray(raw.attachmentIds) || raw.attachmentIds.length > MAX_PERSONAL_REPLY_ATTACHMENTS)
        throw new CrmCommandError('MAIL_ATTACHMENTS_INVALID', 'Höchstens fünf geprüfte persönliche Anhänge auswählen.');
    const attachmentIds = raw.attachmentIds.map(value => assertCrmUuid(value, 'attachmentId'));
    if (new Set(attachmentIds).size !== attachmentIds.length)
        throw new CrmCommandError('MAIL_ATTACHMENTS_INVALID', 'Anhang doppelt ausgewählt.');
    return { messageId: assertCrmUuid(raw.messageId, 'messageId'), body: raw.body.replace(/\r\n?/g, '\n').trim(), attachmentIds };
}
export function personalMailAddress(value: unknown): string {
    if (typeof value !== 'string' || /[\r\n<>\s]/u.test(value) || mailboxAddress(value) !== value.toLowerCase())
        throw new CrmCommandError('MAIL_ADDRESS_INVALID', 'Eine einzelne gültige E-Mail-Adresse ist erforderlich.');
    return value.toLowerCase();
}
export function personalInternetId(value: unknown): string {
    if (typeof value !== 'string' || value.length > 254 || !/^<[^\s<>@]+@[^\s<>@]+>$/u.test(value))
        throw new CrmCommandError('MAIL_THREAD_UNVERIFIED', 'Die ursprüngliche Message-ID ist nicht sicher bestätigt.', 409);
    return value;
}
export function attachmentName(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 180 || /[\u0000-\u001f\u007f/\\]/u.test(value))
        throw new CrmCommandError('MAIL_FILE_NAME_INVALID', 'Der Dateiname ist ungültig.');
    return value.normalize('NFC');
}
export const personalSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function encodedSubject(value: string) {
    const parts: string[] = [];
    let segment = '';
    for (const character of value) {
        if (Buffer.byteLength(segment + character) > 40) {
            parts.push(segment);
            segment = '';
        }
        segment += character;
    }
    if (segment)
        parts.push(segment);
    return parts.map(part => `=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`).join('\r\n ');
}
const encodedLines = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
export type PersonalReplyAttachment = {
    id: string;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    sha256: string;
};
export function personalReplyMime(input: {
    from: string;
    to: string;
    subject: string;
    body: string;
    internetMessageId: string;
    inReplyTo: string;
    attachments: PersonalReplyAttachment[];
}) {
    const from = personalMailAddress(input.from), to = personalMailAddress(input.to);
    const messageId = personalInternetId(input.internetMessageId), parentId = personalInternetId(input.inReplyTo);
    if (input.subject.length > 1000 || /[\r\n]/u.test(input.subject))
        throw new CrmCommandError('MAIL_SUBJECT_INVALID', 'Betreff prüfen.');
    const boundary = 'novalure-' + personalSha256(Buffer.from(messageId)).slice(0, 40);
    const parts = [`From: ${from}`, `To: ${to}`, `Subject: ${encodedSubject(mailboxText(input.subject, 1000))}`, `Message-ID: ${messageId}`, `In-Reply-To: ${parentId}`, `References: ${parentId}`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', encodedLines(Buffer.from(input.body))];
    if (input.attachments.length > MAX_PERSONAL_REPLY_ATTACHMENTS)
        throw new CrmCommandError('MAIL_ATTACHMENTS_INVALID', 'Zu viele Anhänge.');
    let total = 0;
    for (const file of input.attachments) {
        const name = attachmentName(file.fileName);
        total += file.bytes.byteLength;
        if (file.bytes.byteLength < 1 || file.bytes.byteLength > MAX_PERSONAL_ATTACHMENT_BYTES || total > 5 * MAX_PERSONAL_ATTACHMENT_BYTES || personalSha256(file.bytes) !== file.sha256 || !['application/pdf', 'image/png', 'image/jpeg', 'text/plain'].includes(file.mimeType))
            throw new CrmCommandError('MAIL_ATTACHMENT_CHANGED', 'Der geprüfte Anhang ist nicht unverändert verfügbar.', 409);
        parts.push(`--${boundary}`, `Content-Type: ${file.mimeType}`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`, '', encodedLines(file.bytes));
    }
    parts.push(`--${boundary}--`, '');
    return Buffer.from(parts.join('\r\n'), 'utf8');
}
