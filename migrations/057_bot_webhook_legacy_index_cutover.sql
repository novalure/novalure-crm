-- Manual cutover only. Apply after the provider-account-aware webhook code is
-- live and verified. Recreating the legacy index is only possible while the
-- broader workspace/channel/event key remains unique.
do $migration$
begin
  if to_regclass('public.bot_channel_webhooks_account_event_uidx') is null then
    raise exception 'provider-account webhook idempotency index is missing';
  end if;
end;
$migration$;

drop index if exists bot_channel_webhooks_workspace_message_uidx;
