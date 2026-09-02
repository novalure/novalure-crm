import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { canManagePrivacyLifecycle } from "@/lib/db/privacy-lifecycle-repository";

/**
 * Resolves the requested workspace (including membership, MFA, CSRF and
 * managed-service checks) before applying the privacy-specific role policy.
 * The generic settings permission cannot be used here because workspace
 * administrators intentionally do not receive that broader app permission.
 */
export async function resolvePrivacyScopedSession(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth;
  if (!canManagePrivacyLifecycle(auth.session)) {
    return {
      ok: false as const,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return auth;
}
