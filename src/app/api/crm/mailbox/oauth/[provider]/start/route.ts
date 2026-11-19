import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmFields, CrmCommandError, crmCommandErrorResponse, withCrmRead } from "@/lib/crm-command";
import { mailboxProvider } from "@/lib/crm-mailbox";
import { beginCrmMailboxOAuth } from "@/lib/db/crm-mailbox-repository";
import { readPersonalMailJson } from "@/lib/crm-mailbox-request";
export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try {
    const input: unknown = await readPersonalMailJson(request,512,true);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CrmCommandError('INVALID_INPUT', 'Postfachfreigabe prüfen.');
    assertCrmFields(input as Record<string,unknown>, ['enableReply']);
    const enableReply = (input as Record<string,unknown>).enableReply;
    if (enableReply !== undefined && typeof enableReply !== 'boolean') throw new CrmCommandError('INVALID_INPUT', 'Antwortfreigabe ausdrücklich wählen.');
    const provider = mailboxProvider((await context.params).provider), data = await withCrmRead(auth.session, (tx, session) => beginCrmMailboxOAuth(tx, session, provider, request.url, enableReply === true));
    return Response.json({ data }, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  }
  catch (error) { return crmCommandErrorResponse(error); }
}
