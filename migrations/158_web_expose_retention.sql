-- Analytics has a bounded purpose-specific lifetime; ordinary CRM enquiries remain separate.
create function public.crm_web_expose_prune(p_workspace uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare removed_events integer; removed_sessions integer; removed_receipts integer; session_value uuid; begin
 if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or not crm_workspace_manager(p_workspace) then raise exception using errcode='42501',message='Analytics maintenance requires a workspace manager'; end if;
 perform pg_advisory_xact_lock(hashtextextended('web-expose-automation-workspace:'||p_workspace::text,0));
 for session_value in select id from web_expose_sessions where workspace_id=p_workspace and created_at<now()-interval '90 days' order by id loop
 perform pg_advisory_xact_lock(hashtextextended('web-expose-analytics-session:'||session_value::text,0));
 if to_regprocedure('public.crm_automation_erase_exposure(uuid,uuid)') is not null then
   perform crm_automation_erase_exposure(p_workspace,session_value);
 end if;
 end loop;
 delete from web_expose_outbox o where o.workspace_id=p_workspace and o.event_type='expose_opened' and exists(select 1 from web_expose_sessions s where s.id::text=o.payload->>'exposeSessionId' and s.workspace_id=p_workspace and (s.created_at<now()-interval '90 days' or s.withdrawn_at is not null));
 delete from web_expose_events e using web_expose_sessions s where e.session_id=s.id and s.workspace_id=p_workspace and s.created_at<now()-interval '90 days'; get diagnostics removed_events=row_count;
 delete from web_expose_sessions where workspace_id=p_workspace and created_at<now()-interval '90 days'; get diagnostics removed_sessions=row_count;
 delete from web_expose_inquiries where workspace_id=p_workspace and created_at<now()-interval '30 days'; get diagnostics removed_receipts=row_count;
 return jsonb_build_object('events',removed_events,'sessions',removed_sessions,'expiredInquiryReceipts',removed_receipts);
end $$;
create function public.crm_web_expose_erase_session(p_workspace uuid,p_property uuid,p_session uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or not crm_workspace_manager(p_workspace) or not crm_web_expose_access(p_workspace,p_property,true) then raise exception using errcode='42501',message='Analytics erasure requires a workspace manager'; end if;
 perform pg_advisory_xact_lock(hashtextextended('web-expose-automation-workspace:'||p_workspace::text,0));
 if not exists(select 1 from web_expose_sessions s join web_expose_links l on l.id=s.link_id and l.workspace_id=s.workspace_id join web_expose_versions v on v.id=l.version_id and v.workspace_id=l.workspace_id where s.id=p_session and s.workspace_id=p_workspace and v.property_id=p_property) then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended('web-expose-analytics-session:'||p_session::text,0));
 if to_regprocedure('public.crm_automation_erase_exposure(uuid,uuid)') is not null then
   perform crm_automation_erase_exposure(p_workspace,p_session);
 end if;
 delete from web_expose_outbox where workspace_id=p_workspace and event_type='expose_opened' and payload->>'exposeSessionId'=p_session::text;
 delete from web_expose_events where workspace_id=p_workspace and session_id=p_session;
 delete from web_expose_sessions where workspace_id=p_workspace and id=p_session;
 return true;
end $$;
revoke all on function crm_web_expose_prune(uuid),crm_web_expose_erase_session(uuid,uuid,uuid) from public;
grant execute on function crm_web_expose_prune(uuid),crm_web_expose_erase_session(uuid,uuid,uuid) to novalure_tenant_app;
