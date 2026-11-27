import "server-only";
import { assertCrmUuid, CrmCommandError, type TenantTransaction } from "@/lib/crm-command";
import type { MailboxProvider } from "@/lib/crm-mailbox";
import { normalizeMicrosoftMailboxGuid } from "@/lib/integrations/microsoft-oidc-identity";

const productionPoolHost = "ep-wandering-union-alem0781-pooler.c-3.eu-central-1.aws.neon.tech";

function productionPoolConfigured() {
  try {
    // DATABASE_URL has precedence in the tenant pool. Require it explicitly
    // so a legacy alias cannot move this production flow to another target.
    const url = new URL(process.env.DATABASE_URL ?? "");
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname === productionPoolHost && (!url.port || url.port === "5432") &&
      url.username === "novalure_app" && Boolean(url.password) && url.pathname === "/neondb" && !url.hash &&
      url.searchParams.getAll("sslmode").length === 1 &&
      ["require", "verify-full"].includes(url.searchParams.get("sslmode") ?? "") &&
      url.searchParams.getAll("channel_binding").length <= 1 &&
      [...url.searchParams].every(([key, value]) => key === "sslmode" || (key === "channel_binding" && value === "require"));
  } catch {
    return false;
  }
}

function databaseUnavailable() {
  return new CrmCommandError("MAIL_PRODUCTION_DATABASE_UNAVAILABLE", "Die Postfachverbindung wartet auf die geprüfte CRM-Datenbank.", 409);
}

export function isProductionMicrosoftMailbox(provider: MailboxProvider): boolean {
  return provider === "microsoft" && process.env.MICROSOFT_MAILBOX_IDENTITY_MODE?.trim() === "verified-production";
}

export function assertProductionMailboxPilot(
  provider: MailboxProvider,
  session: { workspaceId: string; userId: string },
  identity?: { tenantId: string | null; objectId: string | null },
) {
  if (!isProductionMicrosoftMailbox(provider)) return null;
  try {
    const raw = process.env.NOVALURE_MICROSOFT_MAILBOX_PILOT_SCOPE ?? "";
    if (!raw || raw.length > 16_384) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join() !== "actorId,contactAddressHashes,microsoftObjectId,microsoftTenantId,projectId,workspaceId") throw new Error();
    const scope = value as Record<string, unknown>;
    const workspaceId = assertCrmUuid(scope.workspaceId).toLowerCase();
    const actorId = assertCrmUuid(scope.actorId).toLowerCase();
    const projectId = assertCrmUuid(scope.projectId).toLowerCase();
    const tenantId = normalizeMicrosoftMailboxGuid(scope.microsoftTenantId);
    const objectId = normalizeMicrosoftMailboxGuid(scope.microsoftObjectId);
    if (workspaceId !== session.workspaceId.toLowerCase() || actorId !== session.userId.toLowerCase() || !tenantId || !objectId ||
        identity && (tenantId !== normalizeMicrosoftMailboxGuid(identity.tenantId) || objectId !== normalizeMicrosoftMailboxGuid(identity.objectId))) throw new Error();
    const pairs = scope.contactAddressHashes;
    if (!pairs || typeof pairs !== "object" || Array.isArray(pairs)) throw new Error();
    const entries = Object.entries(pairs);
    if (entries.length < 1 || entries.length > 100) throw new Error();
    const normalized = entries.map(([id, hash]) => {
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error();
      return [assertCrmUuid(id).toLowerCase(), hash] as const;
    }).sort(([first], [second]) => first.localeCompare(second));
    const contactAddressHashes = Object.fromEntries(normalized);
    if (Object.keys(contactAddressHashes).length !== entries.length ||
        new Set(Object.values(contactAddressHashes)).size !== entries.length) throw new Error();
    return { workspaceId, actorId, projectId, tenantId, objectId, contactAddressHashes };
  } catch {
    throw new CrmCommandError("MAIL_PILOT_SCOPE_UNAVAILABLE", "Dieser persönliche Outlook-Test ist für den gewählten Umfang nicht verfügbar.", 403);
  }
}

export function productionMailboxPilotAvailable(provider: MailboxProvider, session: { workspaceId: string; userId: string }) {
  try { assertProductionMailboxPilot(provider, session); return true; }
  catch { return false; }
}

export async function productionMailboxImportStart(tx: TenantTransaction, provider: MailboxProvider, connectionId: string): Promise<number | null> {
  if (!isProductionMicrosoftMailbox(provider)) return null;
  const row = await tx.queryOne<{ start: number }>(`select ceil(extract(epoch from activated_at)*1000)::double precision as start from crm_mailbox_auto_settings where connection_id=$1::uuid`, [connectionId]);
  if (!row || !Number.isSafeInteger(row.start) || row.start <= 0 || row.start > 8.64e15) {
    throw new CrmCommandError("MAIL_IMPORT_START_UNAVAILABLE", "Der Startzeitpunkt des Outlook-Abrufs ist nicht bestätigt.", 409);
  }
  return row.start;
}

export async function assertProductionMailboxDatabase(tx: TenantTransaction, provider: MailboxProvider) {
  if (!isProductionMicrosoftMailbox(provider)) return;
  if (!productionPoolConfigured()) throw databaseUnavailable();

  const result = await tx.queryOne<{ ready: boolean }>(`
    select (
      current_setting('neon.project_id', true) = $1
      and current_setting('neon.branch_id', true) = $2
      and current_database() = 'neondb'
      and current_user = 'novalure_app'
      and session_user = current_user
      and current_setting('session_replication_role') = 'origin'
      and exists (
        select 1 from pg_catalog.pg_roles r
        where r.rolname = current_user and not r.rolsuper and not r.rolbypassrls
          and not r.rolcreaterole and not r.rolcreatedb and not r.rolreplication
      )
      and exists (
        select 1
        from pg_catalog.pg_class c
        where c.oid = pg_catalog.to_regclass('public.crm_mailbox_connections')
          and c.relrowsecurity and c.relforcerowsecurity
          and exists (
            select 1 from pg_catalog.pg_constraint
            where conrelid = c.oid and conname = 'mailbox_verified_identity_complete'
              and contype = 'c' and convalidated
          )
          and exists (
            select 1 from pg_catalog.pg_trigger
            where tgrelid = c.oid and tgname = 'mailbox_verified_identity_guard'
              and not tgisinternal and tgenabled in ('O', 'A')
              and tgfoid = pg_catalog.to_regprocedure('public.crm_mailbox_verified_identity_guard()')
          )
      )
    ) as ready
  `, ["misty-cloud-70835427", "br-spring-night-alyu48yp"]);
  if (result?.ready !== true) throw databaseUnavailable();
}
