import "server-only";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, CrmCommandError, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { getContactVisibilityScope } from "@/lib/contact-access";
import { defaultMarketingContactRules, nextMarketingContactTime, normalizeMarketingContactRules, type MarketingContactPolicy } from "@/lib/marketing-contact-policy";

async function installed(tx: TenantTransaction) { return (await tx.queryOne<{ ready: boolean }>("select to_regclass('public.crm_marketing_contact_policy') is not null as ready"))?.ready === true; }
async function policy(tx: TenantTransaction, workspaceId: string): Promise<MarketingContactPolicy> {
  const row = await tx.queryOne<MarketingContactPolicy>("select revision,rules,updated_at::text as \"updatedAt\" from crm_marketing_contact_policy where workspace_id=$1::uuid", [workspaceId]);
  return row ? { ...row, rules: normalizeMarketingContactRules(row.rules) } : { revision: 0, rules: { ...defaultMarketingContactRules }, updatedAt: null };
}
export async function readMarketingContactPolicy(session: AppSession, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, async (tx, fresh) => {
    const ready = await installed(tx);
    const manager = await tx.queryOne<{ allowed: boolean }>("select crm_workspace_manager($1::uuid) as allowed", [fresh.workspaceId]);
    return { workspaceId: fresh.workspaceId, installed: ready, canEdit: ready && manager?.allowed === true && fresh.permissions.includes("crm:write"), policy: ready ? await policy(tx, fresh.workspaceId) : null };
  }, options);
}
export async function saveMarketingContactPolicy(session: AppSession, input: { expectedRevision: number; rules: unknown }, metadata: { idempotencyKey: string; correlationId: string }, options: TenantTransactionOptions = {}) {
  let rules;
  try { rules = normalizeMarketingContactRules(input.rules); } catch (error) { throw new CrmCommandError("INVALID_CONTACT_POLICY", error instanceof Error ? error.message : "Ungültige Versandregeln."); }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new CrmCommandError("VERSION_REQUIRED", "Gespeicherte Regelrevision fehlt.", 409);
  return executeCrmCommand(session, { operation: "marketing.contact_policy.save", capability: "workspace:operate", payload: { ...input, rules }, ...metadata }, async (tx, context) => {
    if (!await installed(tx)) throw new CrmCommandError("MIGRATION_REQUIRED", "Die Versandregeln sind im Zielsystem noch nicht installiert.", 503);
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`marketing-contact-policy:${context.workspaceId}`]);
    const current = await policy(tx, context.workspaceId);
    if (current.revision !== input.expectedRevision) throw new CrmCommandError("VERSION_CONFLICT", "Versandregeln wurden geändert. Bitte neu laden.", 409);
    await tx.execute("insert into crm_marketing_contact_policy(workspace_id,revision,rules,updated_by) values($1::uuid,1,$2::jsonb,$3::uuid) on conflict(workspace_id) do update set revision=crm_marketing_contact_policy.revision+1,rules=excluded.rules,updated_by=excluded.updated_by,updated_at=now()", [context.workspaceId, JSON.stringify(rules), context.actorId]);
    return { workspaceId: context.workspaceId, policy: await policy(tx, context.workspaceId) };
  }, options);
}

/** Same canonical contact row serializes claims across newsletters and all flows. Never changes consent. */
export async function checkMarketingContactPolicy(tx: TenantTransaction, session: AppSession, input: { contactId: string; email: string; excludeDelivery?: { kind: "newsletter" | "automation"; id: string }; lock?: boolean }, now = new Date()): Promise<{ allowed: boolean; issues: string[]; nextAllowedAt: string | null }> {
  if (!await installed(tx)) return { allowed: true, issues: [], nextAllowedAt: null };
  if (input.lock) await tx.query("select pg_advisory_xact_lock_shared(hashtextextended($1,0))", [`marketing-contact-policy:${session.workspaceId}`]);
  const current = await policy(tx, session.workspaceId);
  if (!current.rules.enabled) return { allowed: true, issues: [], nextAllowedAt: null };
  const contact = await tx.queryOne<{ email: string; ownerId: string | null }>(`select email,owner_user_id as "ownerId" from contacts where workspace_id=$1::uuid and id=$2::uuid and archived_at is null ${input.lock ? "for update" : ""}`, [session.workspaceId, assertCrmUuid(input.contactId)]);
  const visibility = getContactVisibilityScope(session);
  if (!contact || contact.email?.trim().toLowerCase() !== input.email.trim().toLowerCase() || visibility.kind === "none" || (visibility.kind === "own" && visibility.userId !== contact.ownerId)) return { allowed: false, issues: ["Der aktuelle Originalkontakt ist für die Versandprüfung nicht verfügbar."], nextAllowedAt: null };
  const tables = await tx.queryOne<{ newsletter: boolean; automation: boolean }>("select to_regclass('public.crm_newsletter_deliveries') is not null as newsletter,to_regclass('public.crm_automation_mail_deliveries') is not null as automation");
  let last = 0;
  for (const [kind, table, ready] of [["newsletter", "crm_newsletter_deliveries", tables?.newsletter], ["automation", "crm_automation_mail_deliveries", tables?.automation]] as const) {
    if (!ready) continue;
    const state = await tx.queryOne<{ pending: boolean; last: string | null }>(`select coalesce(bool_or(status in('claimed','uncertain')),false) as pending,max(accepted_at)::text as last from ${table} where workspace_id=$1::uuid and contact_id=$2::uuid and ($3::uuid is null or id<>$3::uuid)`, [session.workspaceId, input.contactId, input.excludeDelivery?.kind === kind ? assertCrmUuid(input.excludeDelivery.id) : null]);
    if (state?.pending) return { allowed: false, issues: ["Für diesen Originalkontakt ist ein anderer Versand noch in Bearbeitung oder ungeklärt."], nextAllowedAt: null };
    if (state?.last) last = Math.max(last, new Date(state.last).getTime());
  }
  const earliest = new Date(Math.max(now.getTime(), last ? last + current.rules.minHours * 3600000 : 0));
  const next = nextMarketingContactTime(earliest, current.rules);
  if (next.getTime() > now.getTime()) return { allowed: false, issues: [`Versandzeit oder Mindestabstand: nächster möglicher Zeitpunkt ${next.toISOString()} (${current.rules.timezone}).`], nextAllowedAt: next.toISOString() };
  return { allowed: true, issues: [], nextAllowedAt: null };
}

export type MarketingContactDecision = { allowed: boolean; issues: string[]; nextAllowedAt: string | null };
/** Full recipient preview in bounded SQL round trips; live dispatch still locks/checks each contact. */
export async function previewMarketingContactPolicy(tx: TenantTransaction, session: AppSession, targets: { contactId: string; email: string }[], now = new Date()): Promise<Map<string, MarketingContactDecision>> {
  if (targets.length > 10000) throw new CrmCommandError("RECIPIENT_LIMIT", "Versandvorschau bitte auf höchstens10.000 Kontakte eingrenzen.");
  const allowed = (): MarketingContactDecision => ({ allowed: true, issues: [], nextAllowedAt: null });
  const result = new Map(targets.map(target => [assertCrmUuid(target.contactId), allowed()]));
  if (!targets.length || !await installed(tx)) return result;
  const current = await policy(tx, session.workspaceId);
  if (!current.rules.enabled) return result;
  const ids = [...result.keys()];
  const contacts = await tx.query<{ id: string; email: string; ownerId: string | null }>("select id,email,owner_user_id as \"ownerId\" from contacts where workspace_id=$1::uuid and id=any($2::uuid[]) and archived_at is null", [session.workspaceId, ids]);
  const byId = new Map(contacts.map(contact => [contact.id, contact]));
  const visibility = getContactVisibilityScope(session);
  const tables = await tx.queryOne<{ newsletter: boolean; automation: boolean }>("select to_regclass('public.crm_newsletter_deliveries') is not null as newsletter,to_regclass('public.crm_automation_mail_deliveries') is not null as automation");
  const pending = new Set<string>(), latest = new Map<string, number>();
  for (const [table, ready] of [["crm_newsletter_deliveries", tables?.newsletter], ["crm_automation_mail_deliveries", tables?.automation]] as const) {
    if (!ready) continue;
    const rows = await tx.query<{ id: string; pending: boolean; last: string | null }>(`select contact_id as id,coalesce(bool_or(status in('claimed','uncertain')),false) as pending,max(accepted_at)::text as last from ${table} where workspace_id=$1::uuid and contact_id=any($2::uuid[]) group by contact_id`, [session.workspaceId, ids]);
    for (const row of rows) { if (row.pending) pending.add(row.id); if (row.last) latest.set(row.id, Math.max(latest.get(row.id) ?? 0, new Date(row.last).getTime())); }
  }
  for (const target of targets) {
    const contact = byId.get(target.contactId);
    if (!contact || contact.email?.trim().toLowerCase() !== target.email.trim().toLowerCase() || visibility.kind === "none" || (visibility.kind === "own" && visibility.userId !== contact.ownerId)) {
      result.set(target.contactId, { allowed: false, issues: ["Der aktuelle Originalkontakt ist für die Versandprüfung nicht verfügbar."], nextAllowedAt: null });
    } else if (pending.has(target.contactId)) {
      result.set(target.contactId, { allowed: false, issues: ["Für diesen Originalkontakt ist ein anderer Versand noch in Bearbeitung oder ungeklärt."], nextAllowedAt: null });
    } else {
      const last = latest.get(target.contactId) ?? 0;
      const next = nextMarketingContactTime(new Date(Math.max(now.getTime(), last ? last + current.rules.minHours * 3600000 : 0)), current.rules);
      if (next.getTime() > now.getTime()) result.set(target.contactId, { allowed: false, issues: [`Versandzeit oder Mindestabstand: nächster möglicher Zeitpunkt ${next.toISOString()} (${current.rules.timezone}).`], nextAllowedAt: next.toISOString() });
    }
  }
  return result;
}
