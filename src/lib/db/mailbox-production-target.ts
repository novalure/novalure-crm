import "server-only";
import { CrmCommandError, type TenantTransaction } from "@/lib/crm-command";
import type { MailboxProvider } from "@/lib/crm-mailbox";

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

export async function assertProductionMailboxDatabase(tx: TenantTransaction, provider: MailboxProvider) {
  if (provider !== "microsoft" || process.env.MICROSOFT_MAILBOX_IDENTITY_MODE?.trim() !== "verified-production") return;
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
