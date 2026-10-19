-- Read-only DTO contracts for existing Design C operational history.
-- No table privileges, policies, provider configuration or business rows change.
-- 104/105 belong to Package 3; this additive contract can coexist with them.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

create function public.crm_operational_assert_scope(p_workspace uuid,p_project uuid,p_bot uuid,p_permission text)
returns void language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare actor record;
begin
  select u.role,u.product_role,w.operating_model into actor
    from public.workspace_users u join public.workspaces w on w.id=u.workspace_id
    where u.id=nullif(current_setting('app.actor_id',true),'')::uuid
      and u.workspace_id=p_workspace and u.status='active';
  if not found or p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
    or actor.product_role is null or actor.product_role not in
      ('platform_admin','novalureGrowth','novalureServiceOps','novalureAdmin','novalure_sales','novalure_onboarding',
       'novalure_customer_success','novalure_operator','customer_owner','workspace_admin','team_member','broker_agent',
       'developer_sales','project_sales_member','assistant_backoffice','external_partner','viewer')
    or actor.operating_model not in ('novalure_internal','self_service_customer','managed_by_novalure','hybrid')
    or not public.crm_classification_allowed(p_workspace,case when actor.operating_model='novalure_internal' then 'NOVALURE_INTERNAL' else 'CUSTOMER_TENANT' end,'crm_sales')
    or exists(select 1 from public.crm_service_principals s where s.workspace_id=p_workspace
      and s.actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid)
    or not ((p_permission='bots:run' and actor.role in ('owner','admin','agent','assistant'))
      or (p_permission='bots:approve' and actor.role in ('owner','admin'))
      or (p_permission='calendar:sync' and actor.role in ('owner','admin') and actor.product_role in
        ('platform_admin','novalureGrowth','novalureServiceOps','novalureAdmin','novalure_sales','novalure_onboarding',
         'novalure_customer_success','novalure_operator','customer_owner','workspace_admin','team_member',
         'broker_agent','developer_sales','project_sales_member','assistant_backoffice'))) then
    raise exception using errcode='42501',message='Operational read access denied';
  end if;
  if p_project is not null and not exists(select 1 from public.projects p where p.id=p_project and p.workspace_id=p_workspace
    and public.crm_classification_allowed(p.workspace_id,p.data_classification,p.data_purpose)
    and public.crm_project_access(p.workspace_id,p.id,false)) then
    raise exception using errcode='42501',message='Operational project access denied';
  end if;
  if p_bot is not null and not exists(select 1 from public.bots b where b.id=p_bot and b.workspace_id=p_workspace
    and (p_project is null or b.project_id=p_project)
    and public.crm_classification_allowed(b.workspace_id,b.data_classification,b.data_purpose)
    and ((b.project_id is null and public.crm_workspace_manager(p_workspace)) or exists(
      select 1 from public.projects p where p.id=b.project_id and p.workspace_id=b.workspace_id
        and public.crm_classification_allowed(p.workspace_id,p.data_classification,p.data_purpose)
        and public.crm_project_access(p.workspace_id,p.id,false)))) then
    raise exception using errcode='42501',message='Operational bot access denied';
  end if;
end $$;

create function public.crm_operational_bot_allowed(p_workspace uuid,p_bot uuid,p_project uuid,p_filter_bot uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select case when p_bot is null then p_project is null and p_filter_bot is null and public.crm_workspace_manager(p_workspace)
    else exists(select 1 from public.bots b where b.id=p_bot and b.workspace_id=p_workspace
      and (p_filter_bot is null or b.id=p_filter_bot) and (p_project is null or b.project_id=p_project)
      and public.crm_classification_allowed(b.workspace_id,b.data_classification,b.data_purpose)
      and ((b.project_id is null and public.crm_workspace_manager(p_workspace)) or exists(
        select 1 from public.projects p where p.id=b.project_id and p.workspace_id=p_workspace
          and public.crm_classification_allowed(p.workspace_id,p.data_classification,p.data_purpose)
          and public.crm_project_access(p.workspace_id,p.id,false)))) end
$$;

create function public.crm_operational_conversation_allowed(p_workspace uuid,p_conversation uuid,p_bot uuid,p_project uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.bot_conversations c where c.id=p_conversation and c.workspace_id=p_workspace
    and (p_bot is null or c.bot_id=p_bot) and (p_project is null or c.project_id=p_project)
    and public.crm_operational_bot_allowed(p_workspace,c.bot_id,p_project,p_bot)
    and (c.project_id is null and c.bot_id is null and public.crm_workspace_manager(p_workspace)
      or exists(select 1 from public.bots b where b.id=c.bot_id and b.workspace_id=c.workspace_id
        and b.project_id is not distinct from c.project_id)))
$$;

create function public.crm_operational_contact_allowed(p_workspace uuid,p_contact uuid,p_project uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.contacts c where c.id=p_contact and c.workspace_id=p_workspace
    and (p_project is null or c.project_id=p_project)
    and (public.crm_workspace_manager(p_workspace)
      or c.owner_user_id=nullif(current_setting('app.actor_id',true),'')::uuid)
    and public.crm_classification_allowed(c.workspace_id,c.data_classification,c.data_purpose)
    and (public.crm_project_access(c.workspace_id,c.project_id,false) or (c.project_id is null
      and c.owner_user_id=nullif(current_setting('app.actor_id',true),'')::uuid))
    and (c.project_id is null or exists(select 1 from public.projects p where p.id=c.project_id and p.workspace_id=c.workspace_id
      and public.crm_classification_allowed(p.workspace_id,p.data_classification,p.data_purpose))))
$$;

create function public.crm_read_bot_channels(p_workspace uuid,p_project uuid default null,p_bot uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare accounts jsonb; events jsonb;
begin
  perform public.crm_operational_assert_scope(p_workspace,p_project,p_bot,'bots:run');
  select coalesce(jsonb_agg(x.dto order by x.updated_at desc,x.id),'[]'::jsonb) into accounts from (
    select a.id,a.updated_at,jsonb_build_object('id',a.id,'active',a.active,'accountLabel',a.account_label,
      'channel',a.channel,'externalAccountId',a.external_account_id,'provider',a.provider,'setupStatus',a.setup_status,'updatedAt',a.updated_at) dto
    from public.bot_channel_accounts a where a.workspace_id=p_workspace
      and public.crm_operational_bot_allowed(p_workspace,a.bot_id,p_project,p_bot)
  ) x;
  select coalesce(jsonb_agg(x.dto order by x.received_at desc,x.id),'[]'::jsonb) into events from (
    select e.id,e.received_at,jsonb_build_object('id',e.id,'channel',e.channel,'externalMessageId',e.external_message_id,
      'contactRef',e.contact_ref,'eventType',e.event_type,'status',e.status,'receivedAt',e.received_at,
      'normalizedMessage',jsonb_strip_nulls(jsonb_build_object('text',case when jsonb_typeof(e.normalized_message->'text')='string'
        then left(e.normalized_message->>'text',8000) end))) dto
    from public.bot_channel_webhooks e join public.bot_channel_accounts a on a.id=e.channel_account_id and a.workspace_id=e.workspace_id
    where e.workspace_id=p_workspace and public.crm_operational_bot_allowed(p_workspace,a.bot_id,p_project,p_bot)
    order by e.received_at desc,e.id limit 12
  ) x;
  return jsonb_build_object('channelAccounts',accounts,'recentWebhookEvents',events,'source','database');
end $$;

create function public.crm_read_approvals(p_workspace uuid,p_project uuid default null,p_bot uuid default null,p_status text default 'pending')
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare approvals jsonb;
begin
  perform public.crm_operational_assert_scope(p_workspace,p_project,p_bot,'bots:approve');
  if p_status is null or p_status not in ('pending','approved','denied','expired') then
    raise exception using errcode='22023',message='Invalid approval status';
  end if;
  select coalesce(jsonb_agg(x.dto order by x.created_at desc,x.id),'[]'::jsonb) into approvals from (
    select a.id,a.created_at,jsonb_build_object('id',a.id,'entityType',a.entity_type,'entityId',a.entity_id,
      'action',a.action,'summary',a.summary,'status',a.status,'createdAt',a.created_at,
      'payload',jsonb_strip_nulls(jsonb_build_object(
        'botName',case when jsonb_typeof(a.payload->'botName')='string' then left(a.payload->>'botName',300) end,
        'channel',case when jsonb_typeof(a.payload->'channel')='string' then left(a.payload->>'channel',100) end,
        'prompt',case when jsonb_typeof(a.payload->'prompt')='string' then left(a.payload->>'prompt',8000) end,
        'qualification',jsonb_strip_nulls(jsonb_build_object('score',case when jsonb_typeof(a.payload->'qualification'->'score')='number'
          then a.payload->'qualification'->'score' end,'stage',case when jsonb_typeof(a.payload->'qualification'->'stage')='string'
          then left(a.payload->'qualification'->>'stage',100) end)),
        'toolCallIds',(select coalesce(jsonb_agg(t.id order by t.id),'[]'::jsonb) from public.bot_tool_calls t
          where t.workspace_id=p_workspace and a.entity_type='bot_conversation' and t.conversation_id=a.entity_id
            and public.crm_operational_conversation_allowed(p_workspace,t.conversation_id,t.bot_id,a.project_id)
            and exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(a.payload->'toolCallIds')='array'
              then a.payload->'toolCallIds' else '[]'::jsonb end) requested(id) where requested.id=t.id::text)),
        'requestedActions',jsonb_strip_nulls(jsonb_build_object('document',case when jsonb_typeof(a.payload->'requestedActions'->'document')='boolean'
          then a.payload->'requestedActions'->'document' end,'meeting',case when jsonb_typeof(a.payload->'requestedActions'->'meeting')='boolean'
          then a.payload->'requestedActions'->'meeting' end))))) dto
    from public.approval_requests a where a.workspace_id=p_workspace and a.status=p_status
      and (p_project is null or a.project_id=p_project)
      and ((a.project_id is null and public.crm_workspace_manager(p_workspace)) or exists(
        select 1 from public.projects p where p.id=a.project_id and p.workspace_id=p_workspace
          and public.crm_classification_allowed(p.workspace_id,p.data_classification,p.data_purpose)
          and public.crm_project_access(p.workspace_id,p.id,false)))
      and case a.entity_type
        when 'bot_conversation' then public.crm_operational_conversation_allowed(p_workspace,a.entity_id,p_bot,a.project_id)
          and exists(select 1 from public.bot_conversations c where c.id=a.entity_id and c.workspace_id=p_workspace and c.project_id is not distinct from a.project_id)
        when 'bot' then public.crm_operational_bot_allowed(p_workspace,a.entity_id,a.project_id,p_bot)
          and exists(select 1 from public.bots b where b.id=a.entity_id and b.workspace_id=p_workspace and b.project_id is not distinct from a.project_id)
        when 'bot_tool_call' then exists(select 1 from public.bot_tool_calls t where t.id=a.entity_id and t.workspace_id=p_workspace
          and public.crm_operational_bot_allowed(p_workspace,t.bot_id,a.project_id,p_bot)
          and (t.conversation_id is null or public.crm_operational_conversation_allowed(p_workspace,t.conversation_id,t.bot_id,a.project_id))
          and exists(select 1 from public.bots b where b.id=t.bot_id and b.workspace_id=p_workspace and b.project_id is not distinct from a.project_id))
        when 'lead_workflow_run' then p_bot is null and exists(select 1 from public.lead_workflow_runs r where r.id=a.entity_id
          and r.workspace_id=p_workspace and r.project_id is not distinct from a.project_id
          and (r.workflow_id is null or exists(select 1 from public.lead_workflows w where w.id=r.workflow_id
            and w.workspace_id=p_workspace and (w.project_id is null or w.project_id=r.project_id)))
          and (r.lead_id is null or exists(select 1 from public.leads l where l.id=r.lead_id and l.workspace_id=p_workspace
            and l.project_id is not distinct from r.project_id and public.crm_classification_allowed(l.workspace_id,l.data_classification,l.data_purpose))))
        when 'call_insight' then p_bot is null and exists(select 1 from public.call_insights i where i.id=a.entity_id
          and i.workspace_id=p_workspace and i.project_id is not distinct from a.project_id
          and (i.contact_id is null or public.crm_operational_contact_allowed(p_workspace,i.contact_id,i.project_id))
          and (i.lead_id is null or exists(select 1 from public.leads l where l.id=i.lead_id and l.workspace_id=p_workspace
            and l.project_id is not distinct from i.project_id and public.crm_classification_allowed(l.workspace_id,l.data_classification,l.data_purpose))))
        else a.entity_id is null and p_bot is null end
    order by a.created_at desc,a.id limit 100
  ) x;
  return jsonb_build_object('approvals',approvals,'status',p_status,'source','database');
end $$;

create function public.crm_read_bot_actions(p_workspace uuid,p_project uuid default null,p_bot uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare documents jsonb; meetings jsonb;
begin
  perform public.crm_operational_assert_scope(p_workspace,p_project,p_bot,'bots:run');
  select coalesce(jsonb_agg(x.dto order by x.created_at desc,x.id),'[]'::jsonb) into documents from (
    select d.id,d.created_at,jsonb_build_object('id',d.id,'channel',d.channel,'documentName',d.document_name,
      'status',d.status,'createdAt',d.created_at,'sentAt',d.sent_at,'conversationId',c.id,'conversationTitle',c.title,
      'contactId',ct.id,'contactEmail',ct.email,'contactName',ct.name,'contactPhone',ct.phone,
      'mediaAssetId',m.id,'mediaAssetName',m.name,'mediaAssetMimeType',m.mime_type,'mediaAssetIsPublic',m.is_public,
      'mediaAssetHasActivePublicShare',exists(select 1 from public.media_asset_shares s where s.asset_id=m.id and s.workspace_id=m.workspace_id
        and s.scope='public-download' and s.revoked_at is null and s.expires_at>now()),
      'mediaAssetUrl',case when m.id is not null then '/api/media/files/'||m.id::text end,
      'metadata',case when d.status='failed' then '{"delivery":{"error":"Document delivery failed"}}'::jsonb else '{}'::jsonb end) dto
    from public.bot_document_sends d
      left join public.bot_conversations c on c.id=d.conversation_id and c.workspace_id=d.workspace_id
      left join public.bots b on b.id=coalesce(d.bot_id,c.bot_id) and b.workspace_id=d.workspace_id
      left join public.contacts ct on ct.id=d.contact_id and ct.workspace_id=d.workspace_id
      left join public.media_assets m on m.id=d.media_asset_id and m.workspace_id=d.workspace_id::text
    where d.workspace_id=p_workspace
      and public.crm_operational_bot_allowed(p_workspace,coalesce(d.bot_id,c.bot_id),p_project,p_bot)
      and (d.conversation_id is null or public.crm_operational_conversation_allowed(p_workspace,d.conversation_id,d.bot_id,p_project))
      and (d.contact_id is null or public.crm_operational_contact_allowed(p_workspace,d.contact_id,b.project_id)
        and ct.project_id is not distinct from b.project_id)
      and (d.media_asset_id is null or m.id is not null)
      and (d.approval_request_id is null or exists(select 1 from public.approval_requests a where a.id=d.approval_request_id
        and a.workspace_id=p_workspace and a.project_id is not distinct from b.project_id))
    order by d.created_at desc,d.id limit 50
  ) x;
  -- This legacy table has a real contact/project relation but no authoritative bot
  -- relation. Never infer that relation from metadata or expose it in a bot filter.
  select coalesce(jsonb_agg(x.dto order by x.created_at desc,x.id),'[]'::jsonb) into meetings from (
    select m.id,m.created_at,jsonb_build_object('id',m.id,'contactEmail',m.contact_email,'contactName',m.contact_name,
      'createdAt',m.created_at,'endsAt',m.ends_at,'startsAt',m.starts_at,'slug',m.slug,'status',m.status,'title',m.title) dto
    from public.meeting_bookings m where m.workspace_id=p_workspace and p_bot is null
      and m.source in ('bot_approval','bot_autonomy','bot')
      and ((m.contact_id is null and p_project is null and public.crm_workspace_manager(p_workspace))
        or public.crm_operational_contact_allowed(p_workspace,m.contact_id,p_project))
      and (m.meeting_page_id is null or exists(select 1 from public.meeting_pages p where p.id=m.meeting_page_id and p.workspace_id=p_workspace))
    order by m.created_at desc,m.id limit 50
  ) x;
  return jsonb_build_object('documentSends',documents,'meetingBookings',meetings,'source','database',
    'meetingBookingsAvailable',p_bot is null,
    'metrics',jsonb_build_object('openDocuments',(select count(*) from jsonb_array_elements(documents) d where d->>'status'<>'sent'),
      'openMeetings',case when p_bot is null then (select count(*) from jsonb_array_elements(meetings) m where m->>'status'='requested') end));
end $$;

create function public.crm_read_calendar_connections(p_workspace uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
  perform public.crm_operational_assert_scope(p_workspace,null,null,'calendar:sync');
  -- No config, credentials, token decryption, provider I/O or OAuth side effects.
  select jsonb_object_agg(v.provider,jsonb_build_object('provider',v.provider,'accountLabel',c.account_label,
    'connected',coalesce(c.status='connected',false),'expiresAt',c.expires_at,'scopes',coalesce(c.scopes,'{}'::text[]),
    'error',case when nullif(c.error,'') is not null then 'Calendar connection requires attention' end)) into result
  from (values('google','google-calendar'),('microsoft','microsoft-calendar')) v(provider,connection_provider)
  left join public.provider_connections c on c.workspace_id=p_workspace and c.provider=v.connection_provider;
  return result || '{"source":"database"}'::jsonb;
end $$;

revoke all on function public.crm_operational_assert_scope(uuid,uuid,uuid,text),
  public.crm_operational_bot_allowed(uuid,uuid,uuid,uuid),public.crm_operational_conversation_allowed(uuid,uuid,uuid,uuid),
  public.crm_operational_contact_allowed(uuid,uuid,uuid),public.crm_read_bot_channels(uuid,uuid,uuid),
  public.crm_read_bot_actions(uuid,uuid,uuid),public.crm_read_approvals(uuid,uuid,uuid,text),
  public.crm_read_calendar_connections(uuid) from public,novalure_app,novalure_tenant_app;
grant execute on function public.crm_read_bot_channels(uuid,uuid,uuid),public.crm_read_bot_actions(uuid,uuid,uuid),
  public.crm_read_approvals(uuid,uuid,uuid,text),public.crm_read_calendar_connections(uuid) to novalure_tenant_app;
