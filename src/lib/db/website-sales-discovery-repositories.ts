import { randomUUID } from "node:crypto";
import type { AppSession } from "../auth/session";
import { assertProjectGrant, CrmCommandError, crmPayloadDigest, executeCrmCommand, reconcileCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "../crm-command";
import { runWebsiteSalesIrelandCommand } from "./website-sales-ireland-repositories";
import { upsertContactRecord } from "./crm-write-repositories";
import { normalizeDiscoveryAddress, normalizeDiscoveryText, websiteSalesDiscoveryContract,
  websiteSalesDiscoveryMatchRequestSchema, websiteSalesDiscoveryRegisterSchema, type WebsiteSalesDiscoveryCandidate, type WebsiteSalesDiscoveryMatch,
  type WebsiteSalesDiscoveryReceipt, type WebsiteSalesDiscoveryRegister } from "../website-sales-discovery";

function fail(code: string, status = 409): never { throw new CrmCommandError(code, code, status); }
function personal(session: AppSession) { if (!session.authenticated || session.source === "demo" || session.serviceIdentity) fail("DISCOVERY_SESSION_REQUIRED", 401); }
async function project(tx: TenantTransaction, session: AppSession, projectId: string, write = false) {
  personal(session); await assertProjectGrant(tx, session, projectId, write);
  const row = await tx.queryOne(`select p.id from projects p join workspaces w on w.id=p.workspace_id
    where p.workspace_id=$1 and p.id=$2 and p.division='WEB_DESIGN' and p.data_classification='NOVALURE_INTERNAL' and p.data_purpose='crm_sales' and w.operating_model='novalure_internal'`, [session.workspaceId, projectId]);
  if (!row) fail("DISCOVERY_SCOPE_DENIED", 403);
}
function currentSources(candidate: WebsiteSalesDiscoveryCandidate) {
  const now = Date.now();
  if (candidate.sourceReferences.some(source => Date.parse(source.observedAt) > now || Date.parse(source.validUntil) <= now || Date.parse(source.validUntil) <= Date.parse(source.observedAt))) fail("DISCOVERY_CURRENT_SOURCE_REQUIRED");
}
async function match(tx: TenantTransaction, session: AppSession, projectId: string, candidate: WebsiteSalesDiscoveryCandidate): Promise<WebsiteSalesDiscoveryMatch> {
  currentSources(candidate);
  // Compare Unicode names in the same host normalizer as source facts. Database C/OS collations must not split accented company names.
  // Overflow fails closed rather than falsely asserting that a company does not exist.
  const catalog = await tx.query<{ companyId: string; name: string; domain: string | null; version: number }>(`select o.id as "companyId",o.name,o.domain,o.version from organizations o
    where o.workspace_id=$1 and o.project_id=$2 and o.division='WEB_DESIGN' and o.data_classification='NOVALURE_INTERNAL' and o.data_purpose='crm_sales'
    order by o.id limit 1001`, [session.workspaceId, projectId]);
  if (catalog.length > 1000) fail("DISCOVERY_CATALOG_LIMIT_REQUIRES_INDEXED_REVIEW");
  const rows = catalog.filter(row => normalizeDiscoveryText(row.name) === normalizeDiscoveryText(candidate.companyName) || candidate.domain !== null && row.domain?.toLowerCase() === candidate.domain);
  if (rows.length > 50) fail("DISCOVERY_TOO_MANY_CANDIDATES");
  const companies = rows.map(row => ({ companyId: row.companyId, name: row.name, version: Number(row.version),
    reasons: [ ...(normalizeDiscoveryText(row.name) === normalizeDiscoveryText(candidate.companyName) ? ["EXACT_NORMALIZED_NAME"] : []), ...(candidate.domain && row.domain?.toLowerCase() === candidate.domain ? ["SHARED_DOMAIN_SIGNAL_ONLY"] : []) ] }));
  const locationCatalog = rows.length ? await tx.query<WebsiteSalesDiscoveryMatch["locations"][number]>(`select company_id as "companyId",id as "locationId",address,version from crm_company_locations
    where workspace_id=$1 and project_id=$2 and company_id=any($3::uuid[]) and country_code='IE' and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales'
      order by id limit 201`, [session.workspaceId, projectId, rows.map(row => row.companyId)]) : [];
  if (locationCatalog.length > 200) fail("DISCOVERY_LOCATION_LIMIT_REQUIRES_INDEXED_REVIEW");
  const locations = locationCatalog.filter(location => normalizeDiscoveryAddress(location.address) === normalizeDiscoveryAddress(candidate.address));
  const contacts = candidate.contacts.length ? await tx.query<WebsiteSalesDiscoveryMatch["contacts"][number]>(`select organization_id as "companyId",id as "contactId",name,email,version from contacts
    where workspace_id=$1 and project_id=$2 and (organization_id=any($3::uuid[]) or organization_id is null) and archived_at is null and lower(email)=any($4::text[])
      and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales' order by id limit 51`,
  [session.workspaceId, projectId, rows.map(row => row.companyId), candidate.contacts.map(contact => contact.email)]) : [];
  if (contacts.length > 50) fail("DISCOVERY_TOO_MANY_CANDIDATES");
  const exactNames = companies.filter(company => company.reasons.includes("EXACT_NORMALIZED_NAME"));
  const exactLocations = locations.filter(location => exactNames.some(company => company.companyId === location.companyId));
  const identity = exactLocations.length === 1 ? { workspaceId: session.workspaceId, projectId, companyId: exactLocations[0]!.companyId, locationId: exactLocations[0]!.locationId } : null;
  const matchingContacts = identity ? contacts.filter(contact => contact.companyId === identity.companyId || contact.companyId === null) : [];
  const ambiguous = exactLocations.length > 1 || !identity && (exactNames.length > 1 || companies.length > exactNames.length) || matchingContacts.length > 1;
  const status = ambiguous ? "AMBIGUOUS" : identity ? "MATCH" : "NEW";
  const contactId = matchingContacts.length === 1 ? matchingContacts[0]!.contactId : null;
  const existingLeads = contacts.length ? await tx.query<WebsiteSalesDiscoveryMatch["existingLeads"][number]>(`select id as "leadId",contact_id as "contactId",status,source from leads
    where workspace_id=$1 and project_id=$2 and contact_id=any($3::uuid[]) and division='WEB_DESIGN' and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales' order by id limit 51`,
  [session.workspaceId, projectId, contacts.map(contact => contact.contactId)]) : [];
  if (existingLeads.length > 50) fail("DISCOVERY_TOO_MANY_CANDIDATES");
  const result = { contractVersion: websiteSalesDiscoveryContract, workspaceId: session.workspaceId, projectId, candidateDigest: crmPayloadDigest(candidate), status,
    reasons: [identity ? "EXACT_COMPANY_AND_REGISTERED_ADDRESS" : exactNames.length === 1 ? "NEW_LOCATION_FOR_EXISTING_COMPANY" : companies.length ? "COMPANY_REVIEW_REQUIRED" : "NO_CANONICAL_COMPANY_MATCH",
      ...(ambiguous ? ["EXPLICIT_IDENTITY_REVIEW_REQUIRED"] : []), ...(existingLeads.length ? ["EXISTING_LEAD_REUSE_REQUIRED"] : [])], companies,
    locations: locations.map(row => ({ ...row, version: Number(row.version) })), contacts: contacts.map(row => ({ ...row, version: Number(row.version) })),
    existingLeads, identity, contactId, canContact: false as const };
  return { ...result, status: status as WebsiteSalesDiscoveryMatch["status"], matchDigest: crmPayloadDigest(result) };
}
export async function matchWebsiteSalesDiscovery(session: AppSession, raw: unknown, options: TenantTransactionOptions = {}) {
  personal(session); const input = websiteSalesDiscoveryMatchRequestSchema.parse(raw);
  return withCrmRead(session, async (tx, fresh) => { await project(tx, fresh, input.projectId); return match(tx, fresh, input.projectId, input.candidate); }, options);
}
function command(input: WebsiteSalesDiscoveryRegister) { return { operation: "website_sales.discovery.register", projectId: input.projectId,
  idempotencyKey: input.idempotencyKey, correlationId: input.correlationId, capability: "pipeline:write" as const,
  payload: { ...input, operation: "register" } }; }
export async function registerWebsiteSalesDiscovery(session: AppSession, raw: unknown, options: TenantTransactionOptions = {}) {
  personal(session); const input = websiteSalesDiscoveryRegisterSchema.parse(raw);
  if (input.operation === "reconcile") return reconcileWebsiteSalesDiscovery(session, input, options);
  return executeCrmCommand(session, command(input), async (tx, context): Promise<WebsiteSalesDiscoveryReceipt> => {
    await project(tx, context.session, input.projectId, true);
    // Serialize new companies/contacts and repeat the entire match after taking the shared project discovery lock.
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`website-sales-discovery:${session.workspaceId}:${input.projectId}`]);
    const current = await match(tx, context.session, input.projectId, input.candidate), decision = input.decision;
    if (current.matchDigest !== input.expectedMatchDigest) fail("DISCOVERY_MATCH_CHANGED");
    if (!decision.reviewed) fail("DISCOVERY_REVIEW_REQUIRED");
    if (decision.createCompany === Boolean(decision.companyId) || decision.createCompany && decision.locationId) fail("DISCOVERY_DECISION_INVALID", 400);
    let companyId = decision.companyId;
    if (companyId && !current.companies.some(company => company.companyId === companyId)) fail("DISCOVERY_COMPANY_SELECTION_INVALID");
    if (decision.createCompany) {
      if (current.companies.some(company => company.reasons.includes("EXACT_NORMALIZED_NAME"))) fail("DISCOVERY_EXISTING_COMPANY_REQUIRES_SELECTION");
      companyId = randomUUID();
      await tx.execute(`insert into organizations(id,workspace_id,project_id,owner_user_id,name,type,domain,division,metadata)
        values($1,$2,$3,$4,$5,'Unternehmen',$6,'WEB_DESIGN',$7::jsonb)`, [companyId, session.workspaceId, input.projectId, session.userId, input.candidate.companyName, input.candidate.domain,
      JSON.stringify({ discoveryCandidateId: input.candidate.candidateId, discoveryCandidateDigest: current.candidateDigest, discoverySourceReferences: input.candidate.sourceReferences, contactPermission: false })]);
    }
    if (!companyId) fail("DISCOVERY_COMPANY_REQUIRED");
    if (decision.locationId && !current.locations.some(location => location.locationId === decision.locationId && location.companyId === companyId)) fail("DISCOVERY_LOCATION_SELECTION_INVALID");
    const selectedLocation = current.locations.filter(location => location.companyId === companyId);
    if (!decision.locationId && selectedLocation.length > 1) fail("DISCOVERY_LOCATION_REVIEW_REQUIRED");
    const source = input.candidate.sourceReferences[0]!;
    const locationResult = await runWebsiteSalesIrelandCommand(context.session, { contractVersion: "website-sales-ireland-v1", operation: "register_location",
      projectId: input.projectId, companyId, idempotencyKey: nestedKey(input.idempotencyKey, "location"), correlationId: input.correlationId,
      payload: { countryCode: "IE", address: input.candidate.address, sourceUrl: source.sourceUrl, sourceReference: `Discovery ${input.candidate.candidateId}; ${current.candidateDigest}; ${decision.reason}` } }, options);
    const location = locationResult.data.location;
    if (decision.locationId && location.id !== decision.locationId) fail("DISCOVERY_LOCATION_CHANGED");
    let contactId = decision.contactId;
    const selectedContact = current.contacts.find(contact => contact.contactId === contactId && (contact.companyId === companyId || contact.companyId === null));
    if (contactId && !selectedContact) fail("DISCOVERY_CONTACT_SELECTION_INVALID");
    if (selectedContact?.companyId === null) {
      // Reviewed linkage only. Never re-parent an already assigned contact or change its consent.
      const attached = await tx.queryOne(`update contacts set organization_id=$4,metadata=metadata || $5::jsonb,updated_at=now()
        where workspace_id=$1 and project_id=$2 and id=$3 and organization_id is null and version=$6 and archived_at is null returning id`,
      [session.workspaceId,input.projectId,contactId,companyId,JSON.stringify({ discoveryCandidateId:input.candidate.candidateId,discoveryDecision:decision.reason }),selectedContact.version]);
      if (!attached) fail("DISCOVERY_CONTACT_CHANGED");
    }
    if (decision.createContact && (contactId || input.candidate.contacts.length !== 1)) fail("DISCOVERY_CONTACT_REVIEW_REQUIRED");
    if (decision.createContact) {
      const candidateContact = input.candidate.contacts[0]!;
      const existing = current.contacts.filter(contact => contact.companyId === companyId && contact.email?.toLowerCase() === candidateContact.email);
      if (existing.length) fail("DISCOVERY_EXISTING_CONTACT_REQUIRES_SELECTION");
      const saved = await upsertContactRecord({ session: context.session, contact: { projectId: input.projectId, organizationId: companyId,
        name: candidateContact.name, email: candidateContact.email, phone: candidateContact.phone ?? undefined, source: "Website", consent: "Nur CRM", intent: "Public business research; no outreach authority" } }, options);
      if (!saved.persisted || !saved.data) fail("DISCOVERY_CONTACT_NOT_CREATED");
      contactId = saved.data.id;
    }
    return { candidateDigest: current.candidateDigest, candidate: input.candidate, decision,
      identity: { workspaceId: session.workspaceId, projectId: input.projectId, companyId, locationId: location.id }, contactId,
      locationVersion: location.version, existingLeads: current.existingLeads.filter(lead => lead.contactId === contactId), canContact: false };
  }, options);
}
function nestedKey(id: string, suffix: string): string {
  const hex = crmPayloadDigest({ id, suffix }).slice(0, 32).split(""); hex[12] = "4"; hex[16] = "8";
  const value = hex.join(""); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export async function reconcileWebsiteSalesDiscovery(session: AppSession, raw: unknown, options: TenantTransactionOptions = {}) {
  personal(session); const input = websiteSalesDiscoveryRegisterSchema.parse(raw);
  return withCrmRead(session, async (tx, fresh) => {
    await project(tx, fresh, input.projectId, true);
    return reconcileCrmCommand<WebsiteSalesDiscoveryReceipt>(fresh, command(input), options);
  }, options);
}
