-- Company-profile approvals are release evidence and must never be inferred
-- from a seed or retained after an approval is withdrawn.

update public.company_profiles
set
  status = 'needs_review',
  approved_by_user_id = null,
  approved_at = null,
  updated_at = now()
where status in ('approved', 'locked')
  and (
    approved_by_user_id is null
    or approved_at is null
    or country_code not in ('AT', 'DE', 'IE')
    or btrim(legal_name) = ''
    or btrim(legal_form) = ''
    or btrim(business_address) = ''
    or btrim(public_email) = ''
    or jsonb_typeof(representatives) is distinct from 'array'
    or case
      when jsonb_typeof(representatives) = 'array' then jsonb_array_length(representatives) = 0
      else true
    end
    or (
      country_code = 'IE'
      and (
        btrim(registration_number) = ''
        or btrim(registration_authority) = ''
        or btrim(registered_office_address) = ''
      )
    )
  );

update public.company_profiles
set
  approved_by_user_id = null,
  approved_at = null,
  updated_at = now()
where status not in ('approved', 'locked')
  and (approved_by_user_id is not null or approved_at is not null);

alter table public.company_profiles
  drop constraint if exists company_profiles_approval_integrity_check;

alter table public.company_profiles
  add constraint company_profiles_approval_integrity_check
  check (
    (
      status in ('approved', 'locked')
      and approved_by_user_id is not null
      and approved_at is not null
      and country_code in ('AT', 'DE', 'IE')
      and btrim(legal_name) <> ''
      and btrim(legal_form) <> ''
      and btrim(business_address) <> ''
      and btrim(public_email) <> ''
      and jsonb_typeof(representatives) = 'array'
      and jsonb_array_length(representatives) > 0
      and (
        country_code <> 'IE'
        or (
          btrim(registration_number) <> ''
          and btrim(registration_authority) <> ''
          and btrim(registered_office_address) <> ''
        )
      )
    )
    or (
      status not in ('approved', 'locked')
      and approved_by_user_id is null
      and approved_at is null
    )
  ) not valid;

alter table public.company_profiles
  validate constraint company_profiles_approval_integrity_check;
