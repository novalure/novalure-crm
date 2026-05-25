create unique index if not exists bot_channel_accounts_workspace_channel_external_uidx
  on bot_channel_accounts(workspace_id, channel, external_account_id)
  where external_account_id is not null;

create index if not exists bot_channel_accounts_external_active_idx
  on bot_channel_accounts(channel, external_account_id)
  where active = true and external_account_id is not null;
