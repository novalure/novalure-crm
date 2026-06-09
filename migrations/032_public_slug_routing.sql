create extension if not exists pgcrypto;

alter table workspaces
  add column if not exists public_key text;

update workspaces
set public_key = replace(gen_random_uuid()::text, '-', '')
where public_key is null or public_key = '';

alter table workspaces
  alter column public_key set default replace(gen_random_uuid()::text, '-', '');

alter table workspaces
  alter column public_key set not null;

create unique index if not exists workspaces_public_key_idx
  on workspaces (public_key);

create index if not exists forms_public_route_idx
  on forms (workspace_id, slug)
  where status in ('aktiv', 'eingebaut');

create index if not exists meeting_pages_public_route_idx
  on meeting_pages (workspace_id, slug)
  where status = 'active';
