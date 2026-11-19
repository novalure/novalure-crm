import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, crmPayloadDigest, executeCrmCommand, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { partnerExpiry, partnerLimitedText, type PartnerProjection } from "@/lib/crm-partner";
import { readPropertyGeography } from "@/lib/property-country";
import { runPropertySalesCommand } from "@/lib/db/property-sales-repositories";

async function manager(tx: TenantTransaction, session: AppSession, projectId: string) {
  await assertProjectGrant(tx, session, projectId, true);
  if (!(await tx.queryOne<{ allowed: boolean }>("select crm_workspace_manager($1::uuid) as allowed", [session.workspaceId]))?.allowed) throw new CrmCommandError("FORBIDDEN", "Projektverantwortlicher erforderlich", 403);
}
export async function loadCrmPartnerWorkspace(tx: TenantTransaction, session: AppSession, projectId: string | null) {
  if (session.serviceIdentity) throw new CrmCommandError("FORBIDDEN", "Persönliche Anmeldung erforderlich", 403);
  if (session.productRole === "external_partner") {
    const row = await tx.queryOne<{ data: PartnerProjection }>("select crm_partner_projection() as data");
    return { mode: "partner" as const, data: row?.data ?? { properties: [], leads: [], requests: [] } };
  }
  const allowed = await tx.queryOne<{ allowed: boolean }>("select crm_workspace_manager($1::uuid) as allowed", [session.workspaceId]);
  if (!allowed?.allowed) throw new CrmCommandError("FORBIDDEN", "Partnerfreigaben verwaltet ein Projektverantwortlicher", 403);
  const projects = await tx.query<{ id: string; name: string }>("select id,name from projects where workspace_id=$1::uuid order by name limit 200", [session.workspaceId]);
  if (!projectId) return { mode: "manager" as const, projects, partners: [], properties: [], leads: [], propertyGrants: [], leadGrants: [], requests: [] };
  await manager(tx, session, projectId);
  const partners = await tx.query<{ id: string; name: string }>("select id,name from workspace_users where workspace_id=$1::uuid and status='active' and product_role='external_partner' and role not in('owner','admin') order by name limit 200", [session.workspaceId]);
  const properties = await tx.query<{ id: string; title: string }>("select id,title from seller_listings where workspace_id=$1::uuid and project_id=$2::uuid order by title limit 200", [session.workspaceId, projectId]);
  const leads = await tx.query<{ id: string; label: string }>("select l.id,c.name as label from leads l left join contacts c on c.id=l.contact_id and c.workspace_id=l.workspace_id where l.workspace_id=$1::uuid and l.project_id=$2::uuid order by l.created_at desc limit 200", [session.workspaceId, projectId]);
  const propertyGrants = await tx.query("select id,partner_id as \"partnerId\",property_id as \"propertyId\",snapshot,revision,status,expires_at as \"expiresAt\" from crm_partner_property_grants where workspace_id=$1::uuid and project_id=$2::uuid order by updated_at desc limit 200", [session.workspaceId, projectId]);
  const leadGrants = await tx.query("select id,partner_id as \"partnerId\",lead_id as \"leadId\",label,revision,status,expires_at as \"expiresAt\" from crm_partner_lead_grants where workspace_id=$1::uuid and project_id=$2::uuid order by updated_at desc limit 200", [session.workspaceId, projectId]);
  const requests = await tx.query("select r.id,r.partner_id as \"partnerId\",r.property_id as \"propertyId\",r.unit_id as \"unitId\",r.reference,r.status,r.revision,r.expires_at as \"expiresAt\",u.version::int as \"unitVersion\",r.reservation_id as \"reservationId\",pr.status as \"reservationStatus\",lg.lead_id as \"leadId\" from crm_partner_requests r join property_units u on u.id=r.unit_id and u.workspace_id=r.workspace_id and u.project_id=r.project_id left join property_reservations pr on pr.id=r.reservation_id and pr.workspace_id=r.workspace_id left join crm_partner_lead_grants lg on lg.id=r.lead_grant_id and lg.workspace_id=r.workspace_id where r.workspace_id=$1::uuid and r.project_id=$2::uuid order by r.created_at desc limit 200", [session.workspaceId, projectId]);
  return { mode: "manager" as const, projects, partners, properties, leads, propertyGrants, leadGrants, requests };
}
export async function saveCrmPartnerGrant(tx: TenantTransaction, session: AppSession, input: Record<string, unknown>) {
  const projectId = assertCrmUuid(input.projectId), partnerId = assertCrmUuid(input.partnerId), kind = input.kind;
  if (kind !== "property" && kind !== "lead") throw new CrmCommandError("INVALID_KIND", "Objekt- oder Anfragefreigabe wählen");
  await manager(tx, session, projectId);
  if (input.reviewed !== true || !["active", "revoked"].includes(String(input.status))) throw new CrmCommandError("REVIEW_REQUIRED", "Freigabeumfang ausdrücklich prüfen", 409);
  const partner = await tx.queryOne("select id from workspace_users where workspace_id=$1::uuid and id=$2::uuid and($3='revoked' or(status='active' and product_role='external_partner' and role not in('owner','admin')))", [session.workspaceId, partnerId, input.status]);
  if (!partner) throw new CrmCommandError("INVALID_PARTNER", "Aktiven eingeschränkten Partner auswählen");
  let expiresAt: string; try { expiresAt = partnerExpiry(input.expiresAt, 365); } catch { throw new CrmCommandError("INVALID_EXPIRY", "Künftige Freigabefrist innerhalb eines Jahres eingeben"); }
  const targetId = assertCrmUuid(input.targetId), table = kind === "property" ? "crm_partner_property_grants" : "crm_partner_lead_grants", targetColumn = kind === "property" ? "property_id" : "lead_id";
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`partner-grant:${session.workspaceId}:${partnerId}:${kind}:${targetId}`]);
  const existing = await tx.queryOne<{ id: string; revision: number }>(`select id,revision from ${table} where workspace_id=$1::uuid and partner_id=$2::uuid and ${targetColumn}=$3::uuid for update`, [session.workspaceId, partnerId, targetId]);
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) !== (existing?.revision ?? 0)) throw new CrmCommandError("GRANT_CONFLICT", "Freigabe wurde geändert. Bitte neu laden.", 409);
  if (input.status === "revoked" && existing) return tx.queryOne(`update ${table} set status='revoked',expires_at=$3::timestamptz,created_by=$4::uuid,revision=revision+1,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid returning id,revision`, [existing.id, session.workspaceId, expiresAt, session.userId]);
  let snapshot: Record<string, unknown> = {}, unitIds: string[] = [], label = "";
  if (kind === "property") {
    const p = await tx.queryOne<{ title: string; city: string; area: number; rooms: number; priceCents: string | null; priceVisibility: string; canonicalPayload: Record<string, unknown>; region: string }>("select title,city,area_sqm::float as area,rooms::float,coalesce(public_price_cents,target_price_cents)::text as \"priceCents\",price_visibility as \"priceVisibility\",canonical_payload as \"canonicalPayload\",region from seller_listings where id=$1::uuid and workspace_id=$2::uuid and project_id=$3::uuid", [targetId, session.workspaceId, projectId]);
    if (!p) throw new CrmCommandError("NOT_FOUND", "Objekt nicht verfügbar", 404); const geography = readPropertyGeography(p);
    if (!geography) throw new CrmCommandError("COUNTRY_REQUIRED", "Objektland zuerst bestätigen");
    const numericPrice = p.priceCents === null ? null : Number(p.priceCents);
    snapshot = { title: p.title, city: p.city, countryCode: geography.countryCode, areaSqm: p.area, rooms: p.rooms, price: p.priceVisibility === "publish_price" && numericPrice !== null && Number.isSafeInteger(numericPrice) && numericPrice >= 0 ? new Intl.NumberFormat(geography.displayLocale, { style: "currency", currency: "EUR" }).format(numericPrice / 100) : p.priceVisibility === "price_on_request" ? "Auf Anfrage / On request" : null };
    unitIds = (await tx.query<{ id: string }>("select u.id from property_units u join seller_listings p on p.id=$3::uuid and p.workspace_id=u.workspace_id and p.project_id=u.project_id where u.workspace_id=$1::uuid and u.project_id=$2::uuid and(u.metadata->>'sellerListingId'=p.id::text or u.id=p.unit_id) and coalesce(u.metadata->>'hidden','false')<>'true' order by u.unit_number limit 200", [session.workspaceId, projectId, targetId])).map((row) => row.id);
  } else { try { label = partnerLimitedText(input.label, 100); } catch { throw new CrmCommandError("INVALID_LABEL", "Neutrale Partnerreferenz ohne Kontaktdaten eingeben"); } if (!await tx.queryOne("select id from leads where id=$1::uuid and workspace_id=$2::uuid and project_id=$3::uuid", [targetId, session.workspaceId, projectId])) throw new CrmCommandError("NOT_FOUND", "Anfrage nicht verfügbar", 404); }
  const common = [session.workspaceId, projectId, partnerId, targetId, expiresAt, input.status, session.userId];
  const row = kind === "property" ? await tx.queryOne(`insert into crm_partner_property_grants(workspace_id,project_id,partner_id,property_id,expires_at,status,created_by,snapshot,unit_ids) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::uuid,$8::jsonb,$9::jsonb) on conflict(workspace_id,partner_id,property_id) do update set expires_at=excluded.expires_at,status=excluded.status,created_by=excluded.created_by,snapshot=excluded.snapshot,unit_ids=excluded.unit_ids,revision=crm_partner_property_grants.revision+1,updated_at=now() returning id,revision`, [...common, JSON.stringify(snapshot), JSON.stringify(unitIds)])
    : await tx.queryOne(`insert into crm_partner_lead_grants(workspace_id,project_id,partner_id,lead_id,expires_at,status,created_by,label) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::uuid,$8) on conflict(workspace_id,partner_id,lead_id) do update set expires_at=excluded.expires_at,status=excluded.status,created_by=excluded.created_by,label=excluded.label,revision=crm_partner_lead_grants.revision+1,updated_at=now() returning id,revision`, [...common, label]);
  return row;
}
export async function createCrmPartnerRequest(tx: TenantTransaction, session: AppSession, input: Record<string, unknown>, requestKey: string) {
  if (session.productRole !== "external_partner" || session.serviceIdentity) throw new CrmCommandError("FORBIDDEN", "Eingeschränkte Partneranmeldung erforderlich", 403);
  assertCrmUuid(requestKey); const grantId = assertCrmUuid(input.grantId), unitId = assertCrmUuid(input.unitId), leadGrantId = input.leadGrantId ? assertCrmUuid(input.leadGrantId) : null;
  let reference: string, expiresAt: string; try { reference = partnerLimitedText(input.reference); if (typeof input.expiresAt !== "string" || !Number.isFinite(Date.parse(input.expiresAt))) throw new Error("INVALID_EXPIRY"); expiresAt = new Date(input.expiresAt).toISOString(); } catch { throw new CrmCommandError("INVALID_REQUEST", "Interne Referenz und künftige Frist innerhalb von sieben Tagen eingeben"); }
  const hash = crmPayloadDigest({ grantId, unitId, leadGrantId, reference, expiresAt });
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`partner-request:${session.workspaceId}:${session.userId}:${requestKey}`]);
  const prior = await tx.queryOne<{ id: string; hash: string }>("select id,request_hash as hash from crm_partner_requests where workspace_id=$1::uuid and partner_id=$2::uuid and request_key=$3::uuid", [session.workspaceId, session.userId, requestKey]);
  if (prior) { if (prior.hash !== hash) throw new CrmCommandError("IDEMPOTENCY_CONFLICT", "Vorgangskennung gehört zu anderer Vormerkung", 409); return { id: prior.id, replayed: true }; }
  try { partnerExpiry(expiresAt, 7); } catch { throw new CrmCommandError("INVALID_REQUEST", "Künftige Frist innerhalb von sieben Tagen eingeben"); }
  const grant = await tx.queryOne<{ projectId: string; propertyId: string }>("select project_id as \"projectId\",property_id as \"propertyId\" from crm_partner_property_grants where id=$1::uuid and workspace_id=$2::uuid and partner_id=$3::uuid and status='active' and expires_at>clock_timestamp()", [grantId, session.workspaceId, session.userId]);
  if (!grant) throw new CrmCommandError("GRANT_REVOKED", "Objektfreigabe nicht mehr verfügbar", 403);
  const row = await tx.queryOne(`insert into crm_partner_requests(id,workspace_id,project_id,property_grant_id,partner_id,property_id,unit_id,lead_grant_id,reference,expires_at,request_key,request_hash) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9,$10,$11::uuid,$12) returning id,status,revision`, [randomUUID(), session.workspaceId, grant.projectId, grantId, session.userId, grant.propertyId, unitId, leadGrantId, reference, expiresAt, requestKey, hash]);
  return row;
}
export async function withdrawCrmPartnerRequest(tx: TenantTransaction, session: AppSession, id: string, expectedRevision: number) {
  assertCrmUuid(id); if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new CrmCommandError("INVALID_REVISION", "Vormerkungsversion fehlt");
  const row = await tx.queryOne("update crm_partner_requests set status='withdrawn',revision=revision+1,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and partner_id=$3::uuid and status='pending' and revision=$4 returning id,status,revision", [id, session.workspaceId, session.userId, expectedRevision]);
  if (!row) { const already = await tx.queryOne("select id,status,revision from crm_partner_requests where id=$1::uuid and workspace_id=$2::uuid and partner_id=$3::uuid and status='withdrawn' and revision=$4", [id, session.workspaceId, session.userId, expectedRevision + 1]); if (already) return already; throw new CrmCommandError("REQUEST_CONFLICT", "Vormerkung geändert oder nicht mehr verfügbar", 409); } return row;
}
/** Internal staff creates the existing canonical REQUEST, never confirms a reservation. */
export async function linkCrmPartnerReservation(session: AppSession, input: Record<string, unknown>, metadata: { idempotencyKey: string; correlationId: string }, options?: TenantTransactionOptions) {
  const projectId = assertCrmUuid(input.projectId), requestId = assertCrmUuid(input.requestId);
  return executeCrmCommand(session, { ...metadata, operation: "partner.link_reservation_request", projectId, resourceId: requestId, capability: "reservations:write", payload: input }, async (tx, context) => {
    await manager(tx, context.session, projectId);
    const request = await tx.queryOne<{ unitId: string; expiresAt: string; leadId: string | null }>("select r.unit_id as \"unitId\",r.expires_at::text as \"expiresAt\",lg.lead_id as \"leadId\" from crm_partner_requests r left join crm_partner_lead_grants lg on lg.id=r.lead_grant_id and lg.workspace_id=r.workspace_id and lg.status='active' and lg.expires_at>clock_timestamp() where r.id=$1::uuid and r.workspace_id=$2::uuid and r.project_id=$3::uuid and r.status='pending' and r.expires_at>clock_timestamp() and r.revision=$4 for update of r", [requestId, context.workspaceId, projectId, Number(input.expectedRevision)]);
    if (!request) throw new CrmCommandError("REQUEST_CONFLICT", "Aktuelle Vormerkung nicht mehr verfügbar", 409);
    const leadId = assertCrmUuid(input.leadId); if (request.leadId && request.leadId !== leadId) throw new CrmCommandError("LEAD_MISMATCH", "Separat freigegebene Anfrage muss zur Vormerkung passen", 409);
    const digest = createHash("sha256").update(metadata.idempotencyKey + ":canonical-reservation").digest("hex"), innerKey = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const canonical = await runPropertySalesCommand(context.session, { action: "reservation.request", projectId, expectedVersion: Number(input.unitVersion), idempotencyKey: innerKey, correlationId: metadata.correlationId, payload: { unitId: request.unitId, leadId, expiresAt: request.expiresAt } }, options);
    const reservationId = assertCrmUuid(canonical.data.record?.id);
    const linked = await tx.queryOne("update crm_partner_requests set status='linked',reservation_id=$3::uuid,revision=revision+1,updated_at=now() where id=$1::uuid and workspace_id=$2::uuid and status='pending' returning id,status,reservation_id as \"reservationId\"", [requestId, context.workspaceId, reservationId]);
    if (!linked) throw new CrmCommandError("LINK_UNCONFIRMED", "Reservierungsanfrage nicht bestätigt", 503); return linked;
  }, options);
}
