-- The production migration owner's default ACLs grant novalure_app direct
-- privileges on new objects. Remove only those redundant feature grants:
-- runtime access must come from novalure_tenant_app's guarded interfaces.
-- Keep global defaults and the separate billing-writer grants unchanged.
do $$
declare relation_name text; function_signature text;
begin
 if not exists(select 1 from pg_roles where rolname='novalure_app') then
  return;
 end if;
 foreach relation_name in array array[
  'ai_credit_accounts','ai_credit_buckets','ai_credit_reservations',
  'ai_billing_requests','ai_billing_fulfillments','ai_credit_reconciliations',
  'ai_booking_status_events','ai_billing_admin_receipts'
 ] loop
  execute format('revoke all privileges on table public.%I from novalure_app',relation_name);
 end loop;
 foreach function_signature in array array[
  'public.crm_ai_can_book(uuid)',
  'public.crm_ai_assert_actor(uuid)',
  'public.crm_ai_refresh(uuid)',
  'public.crm_ai_snapshot(uuid)',
  'public.crm_ai_reserve(uuid,uuid,text,integer,text,jsonb)',
  'public.crm_ai_settle(uuid,uuid,integer,text)',
  'public.crm_ai_request_booking(uuid,uuid,text,text,text,text,text,jsonb)',
  'public.crm_ai_fulfill_booking(uuid,text,text,timestamptz)',
  'public.crm_ai_close_booking(uuid,text)',
  'public.crm_ai_reconcile_reservation(uuid,integer,text,text,text)',
  'public.crm_ai_operator_requests(uuid,text)',
  'public.crm_ai_operator_reservations(uuid)',
  'public.crm_ai_admin_receipt_immutable()',
  'public.crm_ai_admin_assert(uuid)',
  'public.crm_ai_admin_read(uuid,uuid,text)',
  'public.crm_ai_admin_action(uuid,uuid,text,jsonb)'
 ] loop
  execute format('revoke all privileges on function %s from novalure_app',function_signature);
 end loop;
end $$;
