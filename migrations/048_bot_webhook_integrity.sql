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

-- Keep the former workspace/channel key during the expand phase so the
-- currently deployed application retains its original idempotency contract.
-- Migration 057 removes it only after the provider-account-aware code is live.
