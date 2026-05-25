create table if not exists bot_channel_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  bot_id uuid references bots(id) on delete set null,
  channel text not null,
  provider text not null,
  account_label text,
  external_account_id text,
  setup_status text not null default 'not_connected',
  active boolean not null default false,
  inbound_mode text,
  outbound_mode text,
  webhook_path text,
  compliance_note text,
  credentials_ref text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bot_channel_webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  channel_account_id uuid references bot_channel_accounts(id) on delete set null,
  channel text not null,
  external_message_id text,
  contact_ref text,
  event_type text not null default 'message',
  payload jsonb not null default '{}'::jsonb,
  normalized_message jsonb not null default '{}'::jsonb,
  status text not null default 'received',
  received_at timestamptz not null default now()
);

create table if not exists bot_document_sends (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  bot_id uuid references bots(id) on delete set null,
  conversation_id uuid references bot_conversations(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  media_asset_id uuid references media_assets(id) on delete set null,
  channel text not null,
  document_name text not null,
  status text not null default 'approval_required',
  approval_request_id uuid references approval_requests(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists bot_channel_accounts_workspace_channel_idx on bot_channel_accounts(workspace_id, channel);
create index if not exists bot_channel_webhooks_workspace_received_idx on bot_channel_webhooks(workspace_id, received_at desc);
create index if not exists bot_channel_webhooks_external_idx on bot_channel_webhooks(channel, external_message_id);
create index if not exists bot_document_sends_workspace_created_idx on bot_document_sends(workspace_id, created_at desc);
