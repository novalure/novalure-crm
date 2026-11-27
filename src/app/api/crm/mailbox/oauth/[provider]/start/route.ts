import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { crmCommandErrorResponse, withCrmRead } from "@/lib/crm-command";
import { mailboxProvider } from "@/lib/crm-mailbox";
import { beginCrmMailboxOAuth } from "@/lib/db/crm-mailbox-repository";
export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try { const provider = mailboxProvider((await context.params).provider), data = await withCrmRead(auth.session, (tx, session) => beginCrmMailboxOAuth(tx, session, provider, request.url)); return Response.json({ data }, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } }); }
  catch (error) { return crmCommandErrorResponse(error); }
}
