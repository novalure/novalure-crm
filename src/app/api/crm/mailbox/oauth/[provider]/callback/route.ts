import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { mailboxProvider } from "@/lib/crm-mailbox";
import { parseSignedOAuthState } from "@/lib/integrations/calendar-oauth-state";
import { mailboxOrigin } from "@/lib/integrations/mailbox-provider";
import { finishCrmMailboxOAuth } from "@/lib/db/crm-mailbox-repository";
export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const target = new URL("/#communication", mailboxOrigin(request.url));
  try {
    const provider = mailboxProvider((await context.params).provider), url = new URL(request.url), state = url.searchParams.get("state"), parsed = parseSignedOAuthState(state, provider);
    if (!state || !parsed || url.searchParams.has("error") || !url.searchParams.get("code")) throw new Error("MAIL_OAUTH_DENIED");
    // The signed state selects the intended workspace; the normal session resolver
    // independently verifies current membership instead of trusting that identifier.
    const scopedUrl = new URL(request.url); scopedUrl.searchParams.set("workspaceId", parsed.workspaceId);
    const auth = await resolveWorkspaceScopedSession(new Request(scopedUrl, { headers: request.headers }), { permission: "crm:read" });
    if (!auth.ok || auth.session.userId !== parsed.userId) throw new Error("MAIL_OAUTH_IDENTITY");
    await finishCrmMailboxOAuth(auth.session, provider, state, url.searchParams.get("code")!, request.url); target.searchParams.set("mailbox", "connected");
  } catch { target.searchParams.set("mailbox", "authorization_required"); }
  return Response.redirect(target, 303);
}
