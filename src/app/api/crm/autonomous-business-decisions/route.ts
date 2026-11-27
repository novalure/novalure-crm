import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { crmCommandErrorResponse, CrmCommandError } from "@/lib/crm-command";
import { decideAutonomousBusinessAuthority } from "@/lib/crm-autonomous-business-authority";
import { readKnowledgeJson } from "@/lib/knowledge-center/http";
import { KnowledgeCenterError } from "@/lib/knowledge-center/policy";

export const runtime = "nodejs";

/** Business approval, never the machine-login route. Existing CSRF is consumed
 * by resolveWorkspaceScopedSession before a durable owner cookie is accepted. */
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
  if (!auth.ok) return auth.response;
  if (auth.session.source !== "cookie" || auth.session.serviceIdentity || auth.session.role !== "owner") {
    return Response.json({ error: "Owner authentication required" }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
  }
  try {
    const body = await readKnowledgeJson(request, ["decision", "decisionId", "grantId", "command", "expiresAt"], 16_384);
    const result = await decideAutonomousBusinessAuthority(auth.session, body);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return crmCommandErrorResponse(error instanceof KnowledgeCenterError
      ? new CrmCommandError("INVALID_REQUEST", "Invalid decision request", error.status)
      : error instanceof SyntaxError ? new CrmCommandError("INVALID_REQUEST", "Invalid decision request", 400) : error);
  }
}
