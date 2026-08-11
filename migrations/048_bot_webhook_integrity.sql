-- Fail closed if one verified provider account currently resolves to more than one workspace.
-- Creating this index intentionally aborts the migration instead of choosing or mutating a tenant.
create unique index if not exists bot_channel_accounts_active_mapping_uidx
  on bot_channel_accounts(lower(channel), external_account_id)
  where active = true
    and setup_status in ('ready', 'connected')
    and workspace_id is not null
    and external_account_id is not null;

-- Provider event IDs are idempotent only within their verified provider-account mapping.
create unique index if not exists bot_channel_webhooks_account_event_uidx
  on bot_channel_webhooks(channel_account_id, external_message_id)
  where channel_account_id is not null
    and external_message_id is not null;

-- The former workspace/channel key was too broad for workspaces with multiple provider accounts.
drop index if exists bot_channel_webhooks_workspace_message_uidx;
