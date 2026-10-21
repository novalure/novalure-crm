import "server-only";
import type { AppSession } from "@/lib/auth/session";
import { isLanguagePreference, type LanguagePreference } from "@/lib/crm-language";
import { withTenantTransaction, type TenantTransactionOptions } from "@/lib/db/tenant-client";

type PreferenceRow = { preference: LanguagePreference };

function personalScope(session: AppSession) {
  if (!session.authIdentityId || session.serviceIdentity) throw new Error("Personal account required");
  return { actorId: session.userId, workspaceId: session.workspaceId };
}

export async function readAccountLanguagePreference(session: AppSession, options: TenantTransactionOptions = {}) {
  const scope = personalScope(session);
  return withTenantTransaction(scope, async transaction => {
    const row = await transaction.queryOne<PreferenceRow>(
      `select language_preference as preference from public.account_ui_preferences
       where auth_identity_id = $1::uuid`,
      [session.authIdentityId],
    );
    return row && isLanguagePreference(row.preference) ? row.preference : "auto";
  }, options);
}

export async function saveAccountLanguagePreference(
  session: AppSession,
  preference: LanguagePreference,
  options: TenantTransactionOptions = {},
) {
  const scope = personalScope(session);
  if (!isLanguagePreference(preference)) throw new Error("Invalid language preference");
  return withTenantTransaction(scope, async transaction => {
    const row = await transaction.queryOne<PreferenceRow>(
      `with saved as (
         insert into public.account_ui_preferences (auth_identity_id, language_preference)
         values ($1::uuid, $2)
         on conflict (auth_identity_id) do update
           set language_preference = excluded.language_preference, updated_at = now()
         returning language_preference as preference
       ), audited as (
         insert into public.auth_audit_events
           (event_type, outcome, auth_identity_id, workspace_user_id, workspace_id, session_id, metadata)
         select 'auth.language_preference.updated', 'success', $1::uuid, $3::uuid, $4::uuid, $5::uuid,
           jsonb_build_object('preference', saved.preference) from saved
         returning id
       )
       select saved.preference from saved where exists (select 1 from audited)`,
      [session.authIdentityId, preference, session.userId, session.workspaceId, session.authSessionId ?? null],
    );
    if (!row || row.preference !== preference) throw new Error("Language preference was not persisted");
    return row.preference;
  }, options);
}
