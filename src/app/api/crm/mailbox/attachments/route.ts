import { resolveWorkspaceScopedSession } from '@/lib/auth/session';
import { assertCrmFields, assertCrmUuid, crmCommandErrorResponse, crmRequestMetadata, CrmCommandError } from '@/lib/crm-command';
import { erasePersonalAttachment, readPersonalAttachment, savePersonalAttachment } from '@/lib/db/crm-mailbox-reply-repository';
import { readPersonalMailJson } from '@/lib/crm-mailbox-request';
export const runtime = 'nodejs';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
export async function GET(request: Request) {
    const auth = await resolveWorkspaceScopedSession(request, { permission: 'crm:read' });
    if (!auth.ok)
        return auth.response;
    try {
        const params = new URL(request.url).searchParams, file = await readPersonalAttachment(auth.session, assertCrmUuid(params.get('messageId')), assertCrmUuid(params.get('id')));
        return new Response(new Uint8Array(file.bytes), { headers: { ...headers, 'Content-Type': file.mimeType, 'Content-Length': String(file.bytes.length), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}` } });
    }
    catch (error) {
        return crmCommandErrorResponse(error);
    }
}
export async function POST(request: Request) {
    const auth = await resolveWorkspaceScopedSession(request, { permission: 'crm:write' });
    if (!auth.ok)
        return auth.response;
    try {
        const { action, ...body } = await readPersonalMailJson(request, 2800000), metadata = crmRequestMetadata(request, {});
        if (action === 'store')
            return Response.json({ ...await savePersonalAttachment(auth.session, body, metadata), persisted: true, sent: false }, { headers });
        if (action === 'erase') {
            assertCrmFields(body, ['messageId', 'id']);
            return Response.json({ ...await erasePersonalAttachment(auth.session, assertCrmUuid(body.messageId), assertCrmUuid(body.id), metadata), persisted: true, sent: false }, { headers });
        }
        throw new CrmCommandError('INVALID_ACTION', 'Private Dateiaktion prüfen.');
    }
    catch (error) {
        return crmCommandErrorResponse(error);
    }
}
