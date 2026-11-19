create table project_sales_report_settings (
 workspace_id uuid not null references workspaces(id), project_id uuid not null,
 month text not null check(month~'^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$'),
 time_zone text not null default 'UTC', unit_sales_target integer check(unit_sales_target between 0 and 1000000),
 won_deal_value_target_cents bigint check(won_deal_value_target_cents between 0 and 9007199254740991),
 revision integer not null default 1, updated_by uuid not null, updated_at timestamptz not null default now(),
 primary key(workspace_id,project_id,month), foreign key(workspace_id,project_id) references projects(workspace_id,id),
 foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id)
);
alter table project_sales_report_settings enable row level security;
alter table project_sales_report_settings force row level security;
create policy project_report_settings_read on project_sales_report_settings for select to novalure_tenant_app using(
 workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,false));
create policy project_report_settings_write on project_sales_report_settings for all to novalure_tenant_app using(
 workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_workspace_manager(workspace_id) and crm_project_access(workspace_id,project_id,true)) with check(
 workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_workspace_manager(workspace_id) and crm_project_access(workspace_id,project_id,true) and updated_by=nullif(current_setting('app.actor_id',true),'')::uuid);
grant select,insert,update on project_sales_report_settings to novalure_tenant_app;
