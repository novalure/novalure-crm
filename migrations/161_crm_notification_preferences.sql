-- Personal in-app preferences and read receipts. No external delivery is activated.
create table crm_notification_preferences (
 workspace_id uuid not null references workspaces(id), user_id uuid not null,
 preferences jsonb not null check(jsonb_typeof(preferences)='object'), revision integer not null default 1,
 last_request_id uuid not null,last_request_hash text not null,updated_at timestamptz not null default now(),
 primary key(workspace_id,user_id), foreign key(workspace_id,user_id) references workspace_users(workspace_id,id)
);
create table crm_notification_reads (
 workspace_id uuid not null references workspaces(id),user_id uuid not null,notification_key text not null check(length(notification_key) between 1 and 180),
 read_at timestamptz not null default now(),primary key(workspace_id,user_id,notification_key),
 foreign key(workspace_id,user_id) references workspace_users(workspace_id,id)
);
create table crm_notification_digests (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id),user_id uuid not null,
 project_id uuid,request_id uuid not null,fingerprint text not null,notification_keys jsonb not null check(jsonb_typeof(notification_keys)='array'),
 status text not null default 'prepared' check(status='prepared'),created_at timestamptz not null default now(),
 unique(workspace_id,user_id,request_id),unique(workspace_id,user_id,fingerprint),
 foreign key(workspace_id,user_id) references workspace_users(workspace_id,id),foreign key(workspace_id,project_id) references projects(workspace_id,id)
);
do $$ declare target text; begin
 foreach target in array array['crm_notification_preferences','crm_notification_reads','crm_notification_digests'] loop
 execute format('alter table %I enable row level security',target);
 execute format('alter table %I force row level security',target);
 execute format('create policy notification_self on %1$I to novalure_tenant_app using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid and exists(select 1 from workspace_users u where u.id=%1$I.user_id and u.workspace_id=%1$I.workspace_id and u.status=''active'')) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid and exists(select 1 from workspace_users u where u.id=%1$I.user_id and u.workspace_id=%1$I.workspace_id and u.status=''active''))',target);
 execute format('grant select,insert,update on %I to novalure_tenant_app',target);
 end loop;
end $$;
