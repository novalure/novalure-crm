-- Local, approved export preparation. No credentials or transport activation.
alter table property_export_jobs drop constraint if exists property_export_jobs_status_check;
alter table property_export_jobs add constraint property_export_jobs_status_check check(status in ('queued','retry','running','completed','failed','dead_letter','cancelled','prepared','blocked'));

create function crm_property_portal_access(p_workspace uuid,p_property uuid,p_project uuid,p_write boolean default false)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select p_workspace=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(
  select 1 from seller_listings p where p.id=p_property and p.workspace_id=p_workspace and p.project_id is not distinct from p_project
   and crm_classification_allowed(p.workspace_id,p.data_classification,p.data_purpose) and crm_project_access(p.workspace_id,p.project_id,p_write))
$$;
revoke all on function crm_property_portal_access(uuid,uuid,uuid,boolean) from public;
grant execute on function crm_property_portal_access(uuid,uuid,uuid,boolean) to novalure_tenant_app;

alter table property_channels enable row level security;
alter table property_channels force row level security;
create policy portal_profile_read on property_channels for select to novalure_tenant_app using(crm_property_portal_access(workspace_id,property_id,project_id,false));
create policy portal_profile_write on property_channels for all to novalure_tenant_app using(crm_property_portal_access(workspace_id,property_id,project_id,true)) with check(crm_property_portal_access(workspace_id,property_id,project_id,true));
grant select,insert,update on property_channels to novalure_tenant_app;
create unique index property_portal_profile_unique on property_channels(workspace_id,property_id,channel_name) where metadata->>'kind'='openimmo_offline_profile';

alter table property_export_jobs enable row level security;
alter table property_export_jobs force row level security;
create policy portal_job_read on property_export_jobs for select to novalure_tenant_app using(crm_property_portal_access(workspace_id,property_id,project_id,false));
create policy portal_job_insert on property_export_jobs for insert to novalure_tenant_app with check(crm_property_portal_access(workspace_id,property_id,project_id,true) and started_by_user_id=nullif(current_setting('app.actor_id',true),'')::uuid);
create policy portal_job_update on property_export_jobs for update to novalure_tenant_app using(crm_property_portal_access(workspace_id,property_id,project_id,true)) with check(crm_property_portal_access(workspace_id,property_id,project_id,true));
grant select,insert,update on property_export_jobs to novalure_tenant_app;
