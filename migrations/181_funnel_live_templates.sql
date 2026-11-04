-- The legacy designer's public runtime uses only an explicit published blueprint.
-- No anonymous tenant enumeration, name matching or project fallback.
-- Historical responses must not silently disappear behind newly forced RLS.
-- Unknown classification/binding requires a separately reviewed data migration.
do $legacy_guard$
declare prior_row_security text:=current_setting('row_security');
begin
 perform set_config('row_security','off',true);
 if exists(
  select 1 from funnel_submissions s
  left join workspaces w on w.id=s.workspace_id
  left join funnels f on f.id=s.funnel_id and f.workspace_id=s.workspace_id and f.project_id=s.project_id
  where f.id is null or s.project_id is null or w.id is null or w.operating_model is null or w.operating_model not in('self_service_customer','managed_by_novalure','hybrid','novalure_internal')
   or coalesce(to_jsonb(s)->>'data_purpose','')<>'crm_sales'
   or coalesce(to_jsonb(s)->>'data_classification','') is distinct from
    case when w.operating_model='novalure_internal' then 'NOVALURE_INTERNAL' else 'CUSTOMER_TENANT' end
 ) then
  raise exception using errcode='23514',message='Historical funnel responses require reviewed classification and original scope before forced RLS';
 end if;
 perform set_config('row_security',prior_row_security,true);
end $legacy_guard$;
create policy funnel_runtime_owner_read on funnels for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.funnels'::regclass)));
create policy funnel_runtime_grant_owner_read on project_pipeline_permissions for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.project_pipeline_permissions'::regclass)));
create policy funnel_runtime_owner_read on workspaces for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.workspaces'::regclass)));
create policy funnel_runtime_owner_read on projects for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.projects'::regclass)));
create policy funnel_runtime_owner_read on workspace_users for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.workspace_users'::regclass)));
-- An old Active flag is not a reviewed versioned publication. Preserve all old
-- tracking keys and version history, but make the actual need for review explicit.
-- These migration-owner-only policies exist only inside this atomic migration.
create policy funnel_release_owner_update on funnels for update
 using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.funnels'::regclass)))
 with check(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.funnels'::regclass)));
create policy funnel_release_owner_audit on audit_logs for insert
 with check(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.audit_logs'::regclass))
 and actor_user_id is null and action='funnel.legacy_publication_review_required'
 and after->>'releaseMigration'='181_funnel_live_templates');
with previous as (
 select id,status from funnels
 where status in('aktiv','eingebaut') and (
  jsonb_typeof(tracking->'livePublication') is distinct from 'object'
  or coalesce(tracking#>>'{livePublication,schemaVersion}','')<>'1'
  or coalesce(tracking#>>'{livePublication,tokenHash}','') !~ '^[a-f0-9]{64}$'
  or coalesce(tracking#>>'{livePublication,versionId}','')=''
  or coalesce(tracking#>>'{livePublication,blueprint,status}','')<>'aktiv'
 ) for update
), changed as (
 update funnels f set status='entwurf',updated_at=clock_timestamp(),
  tracking=coalesce(f.tracking,'{}'::jsonb)||jsonb_build_object('publicationReview',jsonb_build_object(
   'required',true,'reason','legacy_unreviewed_publication','releaseMigration','181_funnel_live_templates',
   'previousStatus',previous.status,'recordedAt',clock_timestamp())),
  blueprint=case
   when jsonb_typeof(f.blueprint->'funnel')='object' then jsonb_set(f.blueprint,'{funnel,status}','"entwurf"'::jsonb)
   when jsonb_typeof(f.blueprint->'blueprint')='object' then jsonb_set(f.blueprint,'{blueprint,status}','"entwurf"'::jsonb)
   when jsonb_typeof(f.blueprint)='object' then jsonb_set(f.blueprint,'{status}','"entwurf"'::jsonb)
   else f.blueprint
  end
 from previous where f.id=previous.id
 returning f.id,f.workspace_id,f.project_id,previous.status as previous_status
)
insert into audit_logs(workspace_id,actor_user_id,project_id,action,entity_type,entity_id,before,after)
 select workspace_id,null,project_id,'funnel.legacy_publication_review_required','funnel',id,
  jsonb_build_object('status',previous_status,'reviewedPublication',false),
  jsonb_build_object('status','entwurf','publicationReviewRequired',true,'originalTrackingPreserved',true,
   'versionHistoryPreserved',true,'releaseMigration','181_funnel_live_templates','migrationRole',session_user)
 from changed;
drop policy funnel_release_owner_update on funnels;
drop policy funnel_release_owner_audit on audit_logs;
create or replace function crm_funnel_live_lookup(p_id text,p_hash text) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('funnelId',f.id,'workspaceId',f.workspace_id,'projectId',f.project_id,'ownerUserId',u.id,'workspaceName',w.name,'role',u.role,'productRole',u.product_role,'blueprint',f.tracking->'livePublication'->'blueprint','versionId',f.tracking->'livePublication'->>'versionId')
 from funnels f join workspaces w on w.id=f.workspace_id join projects p on p.id=f.project_id and p.workspace_id=f.workspace_id
 join workspace_users u on u.id=f.owner_user_id and u.workspace_id=f.workspace_id and u.status='active'
 where (f.id::text=p_id or f.tracking->>'legacyId'=p_id) and p_hash ~ '^[0-9a-f]{64}$'
 and f.status='aktiv' and f.tracking->'livePublication'->>'tokenHash'=p_hash
 and f.tracking->'livePublication'->'blueprint'->>'status'='aktiv'
 and f.tracking->'livePublication'->'blueprint'->>'workspaceId'=f.workspace_id::text
 and f.tracking->'livePublication'->'blueprint'->>'projectId'=f.project_id::text
 and f.data_purpose='crm_sales' and p.data_purpose='crm_sales'
 and ((w.operating_model in ('self_service_customer','managed_by_novalure','hybrid') and f.data_classification='CUSTOMER_TENANT' and p.data_classification='CUSTOMER_TENANT')
 or (w.operating_model='novalure_internal' and f.data_classification='NOVALURE_INTERNAL' and p.data_classification='NOVALURE_INTERNAL' and u.product_role in ('platform_admin','novalureGrowth','novalureServiceOps','novalureAdmin','novalure_sales','novalure_onboarding','novalure_customer_success','novalure_operator')))
 and coalesce(f.tracking->>'synthetic','false')<>'true' and coalesce(p.setup_defaults->'onboardingExample'->>'synthetic','false')<>'true'
 and u.role in('owner','admin','agent') and u.product_role<>'external_partner'
 and (u.role in('owner','admin') or u.product_role in('platform_admin','novalureGrowth','novalureAdmin','novalure_sales','novalure_onboarding','novalure_customer_success','novalure_operator','customer_owner','workspace_admin') or exists(select 1 from project_pipeline_permissions g where g.workspace_id=f.workspace_id and g.project_id=f.project_id and g.user_id=u.id and g.can_read and g.can_edit_deals))
 limit 1
$$;
revoke all on function crm_funnel_live_lookup(text,text) from public;
grant execute on function crm_funnel_live_lookup(text,text) to novalure_app;

alter table funnel_submissions add column if not exists data_classification text not null default 'UNCLASSIFIED';
alter table funnel_submissions add column if not exists data_purpose text not null default 'crm_sales';
create trigger funnel_submission_classification before insert or update on funnel_submissions for each row execute function crm_set_sales_classification();
alter table funnel_submissions enable row level security;
alter table funnel_submissions force row level security;
create policy funnel_submission_read on funnel_submissions for select to novalure_tenant_app using(crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false));
create policy funnel_submission_insert on funnel_submissions for insert to novalure_tenant_app with check(crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true) and exists(select 1 from funnels f where f.id=funnel_id and f.workspace_id=funnel_submissions.workspace_id and f.project_id=funnel_submissions.project_id));
revoke all on funnel_submissions from novalure_tenant_app;
grant select,insert on funnel_submissions to novalure_tenant_app;
