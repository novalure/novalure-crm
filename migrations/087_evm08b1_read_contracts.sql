-- EVM-08B.1: additive Preview-only Deal/Search read vocabulary.
-- This migration creates no principal, credential, grant, or business data.
alter table crm_service_principals
  drop constraint if exists crm_service_principals_scopes_check;
alter table crm_service_principals
  add constraint crm_service_principals_scopes_check check(
    cardinality(scopes)>0 and scopes <@ array[
      'crm.contacts.read','crm.contacts.write','crm.companies.read','crm.developers.read',
      'crm.projects.read','crm.projects.write','crm.units.read','crm.leads.read',
      'crm.leads.write','crm.deals.read','crm.search.read','crm.qualifications.read',
      'crm.offers.read','crm.offers.prepare','crm.tasks.read','crm.tasks.write',
      'crm.appointments.read','crm.viewings.read','crm.reservations.read',
      'crm.reservations.prepare','crm.sales.read','crm.communications.read',
      'crm.communications.write','crm.approvals.read'
    ]::text[]
  );

alter table crm_service_resource_bindings
  drop constraint if exists crm_service_resource_bindings_entity_check;
alter table crm_service_resource_bindings
  add constraint crm_service_resource_bindings_entity_check check(entity in (
    'Contact','Company','Developer','Project','Unit','BuyerLead','Deal','Qualification',
    'Offer','Task','Appointment','Viewing','Reservation','Sale','Communication',
    'ApprovalReference'
  ));

comment on constraint crm_service_principals_scopes_check on crm_service_principals is
  'Closed CRM integration scope vocabulary; Deal/Search additions remain simulation-only through principal authentication.';
comment on constraint crm_service_resource_bindings_entity_check on crm_service_resource_bindings is
  'Closed resource-binding entity vocabulary for CRM integration contracts v1 and v1.1.';
