alter table lead_workflows
  alter column human_approval_required set default false;

update lead_workflows
set human_approval_required = false,
    steps = coalesce(
      (
        select jsonb_agg(step.value)
        from jsonb_array_elements(lead_workflows.steps) as step(value)
        where step.value <> '"human_approval"'::jsonb
      ),
      '[]'::jsonb
    ),
    updated_at = now()
where trigger in ('chat_qualified', 'webhook', 'funnel_submit')
  and human_approval_required = true;

alter table bot_document_sends
  alter column status set default 'queued';

create index if not exists bot_document_sends_workspace_status_idx
  on bot_document_sends(workspace_id, status, created_at desc);

create index if not exists bot_tool_calls_workspace_tool_status_idx
  on bot_tool_calls(workspace_id, tool_name, status, created_at desc);

with duplicate_bot_webhooks as (
  select id,
         row_number() over (
           partition by workspace_id, channel, external_message_id
           order by received_at asc, id asc
         ) as duplicate_rank
  from bot_channel_webhooks
  where external_message_id is not null
)
delete from bot_channel_webhooks
where id in (
  select id
  from duplicate_bot_webhooks
  where duplicate_rank > 1
);

create unique index if not exists bot_channel_webhooks_workspace_message_uidx
  on bot_channel_webhooks(workspace_id, channel, external_message_id)
  where external_message_id is not null;
