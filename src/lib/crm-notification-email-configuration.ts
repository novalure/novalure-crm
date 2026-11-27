import "server-only";
import { assertCrmUuid, CrmCommandError } from "./crm-command";
import { getTrustedAppOrigin } from "./auth/app-origin";
import { areQueueWorkersPaused } from "./cron/runtime";
export type CrmNotificationEmailScope = { workspaceId: string; actorId: string };
export function configuredCrmNotificationEmailScopes(env: NodeJS.ProcessEnv = process.env): CrmNotificationEmailScope[] {
  let value: unknown;
  try { value = JSON.parse(env.NOVALURE_NOTIFICATION_DIGEST_SCOPES?.trim() || "[]"); } catch { throw new CrmCommandError("DIGEST_SCOPE_INVALID", "Digest-Zeitplankonfiguration ungültig", 503); }
  if (!Array.isArray(value) || value.length > 50) throw new CrmCommandError("DIGEST_SCOPE_INVALID", "Höchstens 50 explizite Digest-Konten zulässig", 503);
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join() !== "actorId,workspaceId") throw new CrmCommandError("DIGEST_SCOPE_INVALID", "Explizites Workspace- und Benutzerkonto erforderlich", 503);
    const row = item as Record<string, unknown>, scope = { workspaceId: assertCrmUuid(row.workspaceId), actorId: assertCrmUuid(row.actorId) }, key = `${scope.workspaceId}:${scope.actorId}`;
    if (seen.has(key)) throw new CrmCommandError("DIGEST_SCOPE_INVALID", "Digest-Konto doppelt konfiguriert", 503); seen.add(key); return scope;
  });
}
export function notificationEmailAddress(value: string) { return value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value); }
export function crmNotificationEmailConfiguration(scope: CrmNotificationEmailScope, env: NodeJS.ProcessEnv = process.env) {
  const from = (env.NOVALURE_NOTIFICATION_DIGEST_FROM || env.RESEND_FROM || env.NOVALURE_EMAIL_FROM || "").trim();
  const sender = from.match(/^(?:[^<>\r\n]+<)?([^<>\s]+@[^<>\s]+)>?$/)?.[1] ?? "";
  const origin = env.NOVALURE_APP_ORIGIN?.trim() || getTrustedAppOrigin();
  const block = (reason: string) => ({ ready: false, reason, from, origin });
  if (areQueueWorkersPaused(env)) return block("paused");
  if (!env.CRON_SECRET?.trim()) return block("cron_not_configured");
  try { if (!configuredCrmNotificationEmailScopes(env).some(row => row.workspaceId === scope.workspaceId && row.actorId === scope.actorId)) return block("actor_not_configured"); } catch { return block("invalid_scope_configuration"); }
  if (!env.RESEND_API_KEY?.trim()) return block("provider_not_configured");
  if (!notificationEmailAddress(sender) || /@(?:resend\.dev|localhost)$/i.test(sender) || /[\r\n]/.test(from)) return block("sender_not_configured");
  try { const url = new URL(origin); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return block("origin_not_configured"); } catch { return block("origin_not_configured"); }
  return { ready: true, reason: "configured_not_delivery_verified", from, origin };
}
