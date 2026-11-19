/** Full-row CAS token. Epoch values make timestamps independent of the connection time zone. */
export const INTERNAL_CALENDAR_REVISION_SQL = `encode(digest((to_jsonb(calendar_events) || jsonb_build_object(
  'starts_at',extract(epoch from starts_at),'ends_at',extract(epoch from ends_at),
  'created_at',extract(epoch from created_at),'updated_at',extract(epoch from updated_at)
))::text,'sha256'),'hex')`;
