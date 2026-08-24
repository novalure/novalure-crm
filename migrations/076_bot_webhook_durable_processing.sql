-- Durable, retry-safe Bot channel webhook processing.
--
-- A provider event is claimed with a fenced lease. Internal effects carry the
-- webhook_event_id as their idempotency key. Provider replies use a durable
-- attempt state because Meta's messaging APIs do not accept our application
-- idempotency key: an interrupted attempt is therefore "uncertain" and must
-- never be resent automatically.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

do $migration$
begin
  if to_regclass('public.public_funnel_visit_events') is null then
    raise exception 'migration 075_public_funnel_visit_truth is required before 076';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.public_funnel_visit_events'::regclass
      and conname = 'public_funnel_visit_events_scope_key'
      and contype = 'u'
      and convalidated
  ) then
    raise exception 'validated public Funnel visit uniqueness from migration 075 is required before 076';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.public_funnel_visit_events'::regclass
      and conname = 'public_funnel_visit_events_funnel_fk'
      and contype = 'f'
      and convalidated
  ) then
    raise exception 'validated public Funnel visit tenant FK from migration 075 is required before 076';
  end if;
  if to_regclass('public.bot_channel_webhooks_workspace_message_uidx') is not null then
    raise exception 'migration 057_bot_webhook_legacy_index_cutover is required before 076';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_index index_state
    where index_state.indexrelid = to_regclass('public.bot_channel_webhooks_account_event_uidx')
      and index_state.indrelid = to_regclass('public.bot_channel_webhooks')
      and index_state.indisunique
      and index_state.indisvalid
      and index_state.indisready
      and index_state.indpred is not null
      and index_state.indnkeyatts = 2
      and pg_catalog.pg_get_indexdef(index_state.indexrelid, 1, true) = 'channel_account_id'
      and pg_catalog.pg_get_indexdef(index_state.indexrelid, 2, true) = 'external_message_id'
      and pg_catalog.regexp_replace(
        lower(pg_catalog.pg_get_expr(index_state.indpred, index_state.indrelid, true)),
        '[()[:space:]]', '', 'g'
      ) = 'channel_account_idisnotnullandexternal_message_idisnotnull'
  ) then
    raise exception 'valid account-scoped webhook idempotency index from migration 048/057 is required before 076';
  end if;
end;
$migration$;

alter table public.bot_channel_webhooks
  add column if not exists payload_sha256 text,
  add column if not exists processing_attempt integer not null default 0,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists processing_result jsonb,
  add column if not exists last_error text,
  add column if not exists completed_at timestamptz,
  add column if not exists reply_state text not null default 'not_requested',
  add column if not exists reply_attempt_token uuid,
  add column if not exists reply_attempted_at timestamptz,
  add column if not exists reply_completed_at timestamptz,
  add column if not exists reply_result jsonb,
  add column if not exists quarantine_reason text,
  add column if not exists quarantined_at timestamptz,
  add column if not exists conflict_count integer not null default 0;

-- Fixed opaque identities keep both the provider-account unique index and the
-- legacy channel lookup index below PostgreSQL's B-tree tuple-size ceiling.
-- Inbound message replays remain compatible because the application applies
-- the same SHA-256 transform before claiming a provider event.
update public.bot_channel_webhooks
set external_message_id = 'evt_' || encode(digest(external_message_id, 'sha256'), 'hex')
where external_message_id is not null;

-- Legacy "routed" rows were already acknowledged by the previous code. They
-- are completed instead of replayed to avoid duplicate customer replies.
update public.bot_channel_webhooks
set status = case
      when status = 'ignored' then 'ignored'
      when status = 'routed' then 'completed'
      -- No legacy processor owned a fenced lease, so an old processing value
      -- must be reclaimable rather than passing the new lease invariant.
      when status = 'processing' then 'failed'
      when status in ('received', 'completed', 'failed') then status
      else 'failed'
    end,
    completed_at = case
      when status in ('routed', 'completed', 'ignored') then coalesce(completed_at, received_at)
      else completed_at
    end,
    processing_attempt = case
      when status = 'routed' then greatest(processing_attempt, 1)
      else processing_attempt
    end,
    reply_state = case
      when status = 'ignored' then 'not_applicable'
      -- The legacy code did not persist provider acknowledgement. Treat it as
      -- uncertain rather than claiming a delivery guarantee or resending.
      when status = 'routed' then 'uncertain'
      else reply_state
    end,
    reply_completed_at = case
      when status in ('routed', 'ignored') then coalesce(reply_completed_at, received_at)
      else reply_completed_at
    end;

alter table public.bot_channel_webhooks
  drop constraint if exists bot_channel_webhooks_external_message_id_check,
  drop constraint if exists bot_channel_webhooks_payload_sha256_check,
  drop constraint if exists bot_channel_webhooks_processing_attempt_check,
  drop constraint if exists bot_channel_webhooks_processing_state_check,
  drop constraint if exists bot_channel_webhooks_processing_lease_check,
  drop constraint if exists bot_channel_webhooks_reply_state_check,
  drop constraint if exists bot_channel_webhooks_conflict_count_check,
  add constraint bot_channel_webhooks_external_message_id_check
    check (external_message_id is null or external_message_id ~ '^evt_[0-9a-f]{64}$') not valid,
  add constraint bot_channel_webhooks_payload_sha256_check
    check (payload_sha256 is null or payload_sha256 ~ '^[0-9a-f]{64}$') not valid,
  add constraint bot_channel_webhooks_processing_attempt_check
    check (processing_attempt >= 0) not valid,
  add constraint bot_channel_webhooks_processing_state_check
    check (status in ('received', 'processing', 'completed', 'failed', 'ignored')) not valid,
  add constraint bot_channel_webhooks_processing_lease_check
    check (
      (status = 'processing' and lease_token is not null and lease_expires_at is not null)
      or status <> 'processing'
    ) not valid,
  add constraint bot_channel_webhooks_reply_state_check
    check (reply_state in (
      'not_requested',
      'attempting',
      'completed',
      'blocked',
      'not_applicable',
      'uncertain'
    )) not valid,
  add constraint bot_channel_webhooks_conflict_count_check
    check (conflict_count >= 0) not valid;

alter table public.bot_channel_webhooks
  validate constraint bot_channel_webhooks_external_message_id_check,
  validate constraint bot_channel_webhooks_payload_sha256_check,
  validate constraint bot_channel_webhooks_processing_attempt_check,
  validate constraint bot_channel_webhooks_processing_state_check,
  validate constraint bot_channel_webhooks_processing_lease_check,
  validate constraint bot_channel_webhooks_reply_state_check,
  validate constraint bot_channel_webhooks_conflict_count_check;

create unique index if not exists bot_channel_webhooks_workspace_id_uidx
  on public.bot_channel_webhooks (workspace_id, id);

create index if not exists bot_channel_webhooks_reclaim_idx
  on public.bot_channel_webhooks (status, lease_expires_at)
  where status in ('received', 'processing', 'failed');

create index if not exists bot_channel_webhooks_account_received_idx
  on public.bot_channel_webhooks (channel_account_id, received_at desc)
  where channel_account_id is not null;

-- Oversized signed provider envelopes are referenced as one terminal
-- quarantine record. No raw payload or tenant/customer identifier is stored;
-- the verified raw-body hash is sufficient for replay/operations evidence.
create table if not exists public.bot_channel_webhook_envelopes (
  id uuid primary key default gen_random_uuid(),
  payload_sha256 text not null,
  provider text not null,
  event_count integer not null,
  status text not null default 'quarantined',
  quarantine_reason text not null,
  delivery_count integer not null default 1,
  received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  constraint bot_channel_webhook_envelopes_payload_key unique (payload_sha256),
  constraint bot_channel_webhook_envelopes_payload_check
    check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint bot_channel_webhook_envelopes_provider_check
    check (provider in ('custom', 'meta', 'unknown')),
  constraint bot_channel_webhook_envelopes_event_count_check
    check (event_count > 0 and event_count <= 100000),
  constraint bot_channel_webhook_envelopes_status_check
    check (status = 'quarantined'),
  constraint bot_channel_webhook_envelopes_reason_check
    check (quarantine_reason = 'batch_event_limit_exceeded'),
  constraint bot_channel_webhook_envelopes_delivery_count_check
    check (delivery_count > 0)
);

create index if not exists bot_channel_webhook_envelopes_received_idx
  on public.bot_channel_webhook_envelopes (received_at desc);

-- The envelope ledger is global because one signed Meta request can contain
-- events for more than one account. Tenant application roles therefore get no
-- direct table access. This narrow definer function exposes only a validated
-- insert/upsert and never exposes rows from another envelope.
create or replace function public.quarantine_bot_channel_webhook_envelope(
  _payload_sha256 text,
  _provider text,
  _event_count integer,
  _reason text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  envelope_id uuid;
begin
  if _payload_sha256 is null or _payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid webhook envelope payload digest' using errcode = '22023';
  end if;
  if _provider is null or _provider not in ('custom', 'meta', 'unknown') then
    raise exception 'invalid webhook envelope provider' using errcode = '22023';
  end if;
  if _event_count is null or _event_count < 1 or _event_count > 100000 then
    raise exception 'invalid webhook envelope event count' using errcode = '22023';
  end if;
  if _reason is null or _reason <> 'batch_event_limit_exceeded' then
    raise exception 'invalid webhook envelope quarantine reason' using errcode = '22023';
  end if;

  insert into public.bot_channel_webhook_envelopes (
    payload_sha256, provider, event_count, status, quarantine_reason
  )
  values (_payload_sha256, _provider, _event_count, 'quarantined', _reason)
  on conflict (payload_sha256)
  do update set
    last_received_at = now(),
    delivery_count = public.bot_channel_webhook_envelopes.delivery_count + 1
  returning id into envelope_id;

  return envelope_id;
end;
$function$;

revoke all on table public.bot_channel_webhook_envelopes from public, novalure_tenant_app;
revoke all on function public.quarantine_bot_channel_webhook_envelope(text, text, integer, text) from public;
grant execute on function public.quarantine_bot_channel_webhook_envelope(text, text, integer, text)
  to novalure_tenant_app;

do $migration$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'novalure_app') then
    revoke all on table public.bot_channel_webhook_envelopes from novalure_app;
    grant execute on function public.quarantine_bot_channel_webhook_envelope(text, text, integer, text)
      to novalure_app;
  end if;
end;
$migration$;

comment on function public.quarantine_bot_channel_webhook_envelope(text, text, integer, text) is
  'Validated write-only quarantine boundary for the global signed Bot webhook envelope ledger.';

alter table public.bot_conversations
  add column if not exists webhook_event_id uuid;

alter table public.bot_messages
  add column if not exists webhook_event_id uuid;

alter table public.bot_tool_calls
  add column if not exists webhook_event_id uuid;

alter table public.bot_document_sends
  add column if not exists webhook_event_id uuid;

alter table public.contact_timeline_items
  add column if not exists webhook_event_id uuid;

alter table public.audit_logs
  add column if not exists webhook_event_id uuid;

alter table public.approval_requests
  add column if not exists webhook_event_id uuid;

create unique index if not exists bot_conversations_webhook_event_uidx
  on public.bot_conversations (workspace_id, webhook_event_id)
  where webhook_event_id is not null;

create unique index if not exists bot_messages_webhook_role_uidx
  on public.bot_messages (workspace_id, webhook_event_id, role)
  where webhook_event_id is not null;

create unique index if not exists bot_tool_calls_webhook_tool_uidx
  on public.bot_tool_calls (workspace_id, webhook_event_id, tool_name)
  where webhook_event_id is not null;

create unique index if not exists bot_document_sends_webhook_event_uidx
  on public.bot_document_sends (workspace_id, webhook_event_id)
  where webhook_event_id is not null;

create unique index if not exists contact_timeline_items_webhook_event_uidx
  on public.contact_timeline_items (workspace_id, webhook_event_id)
  where webhook_event_id is not null;

create unique index if not exists audit_logs_webhook_action_uidx
  on public.audit_logs (workspace_id, webhook_event_id, action)
  where webhook_event_id is not null;

create unique index if not exists approval_requests_webhook_action_uidx
  on public.approval_requests (workspace_id, webhook_event_id, action)
  where webhook_event_id is not null;

alter table public.bot_conversations
  drop constraint if exists bot_conversations_workspace_webhook_event_fk,
  add constraint bot_conversations_workspace_webhook_event_fk
    foreign key (workspace_id, webhook_event_id)
    references public.bot_channel_webhooks (workspace_id, id)
    on delete set null (webhook_event_id)
    deferrable initially deferred not valid;

alter table public.bot_messages
  drop constraint if exists bot_messages_workspace_webhook_event_fk,
  add constraint bot_messages_workspace_webhook_event_fk
    foreign key (workspace_id, webhook_event_id)
    references public.bot_channel_webhooks (workspace_id, id)
    on delete set null (webhook_event_id)
    deferrable initially deferred not valid;

alter table public.bot_tool_calls
  drop constraint if exists bot_tool_calls_workspace_webhook_event_fk,
  add constraint bot_tool_calls_workspace_webhook_event_fk
    foreign key (workspace_id, webhook_event_id)
    references public.bot_channel_webhooks (workspace_id, id)
    on delete set null (webhook_event_id)
    deferrable initially deferred not valid;

alter table public.bot_document_sends
  drop constraint if exists bot_document_sends_workspace_webhook_event_fk,
  add constraint bot_document_sends_workspace_webhook_event_fk
    foreign key (workspace_id, webhook_event_id)
    references public.bot_channel_webhooks (workspace_id, id)
    on delete set null (webhook_event_id)
    deferrable initially deferred not valid;

alter table public.contact_timeline_items
  drop constraint if exists contact_timeline_items_workspace_webhook_event_fk,
  add constraint contact_timeline_items_workspace_webhook_event_fk
    foreign key (workspace_id, webhook_event_id)
    references public.bot_channel_webhooks (workspace_id, id)
    on delete set null (webhook_event_id)
    deferrable initially deferred not valid;

-- audit_logs is retained and append-only. The webhook UUID is immutable
-- evidence, not a live FK: an ON DELETE action would either mutate the audit
-- row (and trip its guard) or block an otherwise valid QA graph cleanup.
alter table public.audit_logs
  drop constraint if exists audit_logs_workspace_webhook_event_fk;

comment on column public.audit_logs.webhook_event_id is
  'Immutable Bot webhook UUID snapshot; intentionally not a live FK because audit_logs is append-only.';

alter table public.approval_requests
  drop constraint if exists approval_requests_workspace_webhook_event_fk,
  add constraint approval_requests_workspace_webhook_event_fk
    foreign key (workspace_id, webhook_event_id)
    references public.bot_channel_webhooks (workspace_id, id)
    on delete set null (webhook_event_id)
    deferrable initially deferred not valid;

alter table public.bot_conversations
  validate constraint bot_conversations_workspace_webhook_event_fk;
alter table public.bot_messages
  validate constraint bot_messages_workspace_webhook_event_fk;
alter table public.bot_tool_calls
  validate constraint bot_tool_calls_workspace_webhook_event_fk;
alter table public.bot_document_sends
  validate constraint bot_document_sends_workspace_webhook_event_fk;
alter table public.contact_timeline_items
  validate constraint contact_timeline_items_workspace_webhook_event_fk;
alter table public.approval_requests
  validate constraint approval_requests_workspace_webhook_event_fk;

comment on column public.bot_channel_webhooks.reply_state is
  'Durable outbound reply state. uncertain requires manual provider reconciliation and is never auto-retried.';

comment on column public.bot_channel_webhooks.reply_attempt_token is
  'Fences the single provider attempt; it is not a provider-supported idempotency key.';
