import { queryOne } from "@/lib/db/client";

/** Check optional provider storage without first issuing an unauthorized table query. */
export async function hasNotificationQueueAccess(provider: "teams" | "google") {
  const row = await queryOne<{ allowed: boolean }>(
    `select
      coalesce(has_table_privilege(current_user, to_regclass($1), 'SELECT'), false)
      and coalesce(has_table_privilege(current_user, to_regclass($2), 'SELECT'), false)
      and coalesce(has_table_privilege(current_user, to_regclass($2), 'INSERT'), false)
      and coalesce(has_table_privilege(current_user, to_regclass($2), 'UPDATE'), false)
      as allowed`,
    [`public.${provider}_notification_targets`, `public.${provider}_notification_jobs`],
  );
  return row?.allowed === true;
}
