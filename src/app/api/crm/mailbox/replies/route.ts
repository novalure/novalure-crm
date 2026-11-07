import { resolveWorkspaceScopedSession } from '@/lib/auth/session';
import { assertCrmFields, assertCrmUuid, crmCommandErrorResponse, crmRequestMetadata, CrmCommandError } from '@/lib/crm-command';
import { cancelPreparedPersonalReply, personalReplyState, previewPersonalReply, sendPersonalReply } from '@/lib/db/crm-mailbox-reply-repository';
import { readPersonalMailJson } from '@/lib/crm-mailbox-request';
export const runtime = 'nodejs';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
export async function GET(request: Request) {
    const auth = await resolveWorkspaceScopedSession(request, { permission: 'crm:read' });
    if (!auth.ok)
        return auth.response;
    try {
        return Response.json({ data: await personalReplyState(auth.session, assertCrmUuid(new URL(request.url).searchParams.get('messageId'))) }, { headers });
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
        const { action, ...body } = await readPersonalMailJson(request, 100000);
        if (action === 'preview')
            return Response.json({ data: await previewPersonalReply(auth.session, body), sent: false }, { headers });
        if (action === 'send')
            return Response.json({ ...await sendPersonalReply(auth.session, body, crmRequestMetadata(request, {})), persisted: true }, { headers });
        if (action === 'cancel_prepared') {
            assertCrmFields(body, ['jobId']);
            return Response.json({ ...await cancelPreparedPersonalReply(auth.session, assertCrmUuid(body.jobId), crmRequestMetadata(request, {})), persisted: true, sent: false }, { headers });
        }
        throw new CrmCommandError('INVALID_ACTION', 'Antwortaktion prüfen.');
    }
    catch (error) {
        return crmCommandErrorResponse(error);
    }
}
