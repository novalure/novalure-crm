-- G05: Existing internal writers must invalidate stale Contact/Task/Project views.
-- CAS is enforced by each interactive UPDATE predicate; this trigger supplies the
-- monotonic revision for all other existing writers of the same rows.
-- Transaction is owned by db-migrate.mjs so schema and ledger commit together.
create or replace function crm_advance_core_version() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.version = old.version then
    new.version := old.version + 1;
  elsif new.version is distinct from old.version + 1 then
    raise exception 'Invalid CRM version transition' using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function crm_advance_core_version() from public;
create trigger contacts_core_version before update on contacts for each row execute function crm_advance_core_version();
create trigger tasks_core_version before update on tasks for each row execute function crm_advance_core_version();
create trigger projects_core_version before update on projects for each row execute function crm_advance_core_version();
