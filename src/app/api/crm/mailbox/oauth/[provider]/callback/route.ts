import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { mailboxProviders } from "@/lib/crm-mailbox";
import { parseSignedOAuthState } from "@/lib/integrations/calendar-oauth-state";
import { mailboxOrigin, MailboxProviderError } from "@/lib/integrations/mailbox-provider";
import { finishCrmMailboxOAuth } from "@/lib/db/crm-mailbox-repository";
export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  // OAuth callbacks belong to the signed-state and human-session flow. A bearer
  // credential is valid only at its dedicated integration endpoint.
  if (request.headers.has("authorization")) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { provider: requestedProvider } = await context.params;
  const provider = mailboxProviders.find((candidate) => candidate === requestedProvider);
  if (!provider) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  const target = new URL("/#communication", mailboxOrigin(request.url));
  try {
    const url = new URL(request.url), state = url.searchParams.get("state"), parsed = parseSignedOAuthState(state, provider);
    if (!state || !parsed || url.searchParams.has("error") || !url.searchParams.get("code")) throw new Error("MAIL_OAUTH_DENIED");
    // The signed state selects the intended workspace; the normal session resolver
    // independently verifies current membership instead of trusting that identifier.
    const scopedUrl = new URL(request.url); scopedUrl.searchParams.set("workspaceId", parsed.workspaceId);
    const auth = await resolveWorkspaceScopedSession(new Request(scopedUrl, { headers: request.headers }), { permission: "crm:read" });
    if (!auth.ok || auth.session.userId !== parsed.userId) throw new Error("MAIL_OAUTH_IDENTITY");
    await finishCrmMailboxOAuth(auth.session, provider, state, url.searchParams.get("code")!, request.url); target.searchParams.set("mailbox", "connected");
  } catch (error) {
    target.searchParams.set("mailbox", error instanceof MailboxProviderError && error.code === "MAIL_REFRESH_GRANT_REQUIRED" ? "offline_access_required" : "authorization_required");
  }
  return Response.redirect(target, 303);
}
