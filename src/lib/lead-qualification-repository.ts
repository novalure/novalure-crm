import { createHash } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, crmPayloadDigest, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { upsertBuyerSearchProfile } from "@/lib/db/broker-entity-repositories";
import { readPropertyGeography, isPropertyCountryCode } from "@/lib/property-country";
import { authorizedLeadProofMediaAsset, discardUncommittedLeadProofFile, saveLeadProofFile, type MediaAsset } from "@/lib/media-store";
import { recordAutomationEvent } from "@/lib/automation/repository";
import { evaluateLeadPropertyMatch, leadMatchAlgorithmVersion, type LeadMatchProfile, type LeadMatchProperty } from "./lead-qualification-matching";
import type { LeadPropertyMatch, LeadQualificationProof, LeadQualificationState, LeadProofKind, LeadProofStatus } from "./lead-qualification-types";
import { leadProofMaxUploadBytes } from "./lead-qualification-types";
import {leadProfileCompleteness,leadPurchaseWindowExpired,type LeadFeatureRules,type LeadPurchaseWindow} from './lead-qualification-plan';

type Row = Record<string, unknown>;
type Meta = { idempotencyKey: string; correlationId: string };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const money = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const text = (value: unknown, label: string, min = 1, max = 1000) => {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw new CrmCommandError("INVALID_QUALIFICATION_INPUT", `${label} ist ungültig.`);
  return value.trim();
};
export async function qualificationLead(tx: TenantTransaction, session: AppSession, leadId: string, write = false) {
  const row = await tx.queryOne<Row>(`select l.* from leads l where l.workspace_id=$1::uuid and l.id=$2::uuid and crm_lead_qualification_access(l.workspace_id,l.project_id,l.id,$3) ${write ? "for update" : ""}`, [session.workspaceId, assertCrmUuid(leadId), write]);
  if (!row || typeof row.project_id !== "string") throw new CrmCommandError("LEAD_QUALIFICATION_FORBIDDEN", "Diese Interessentenakte ist nicht berechtigt verfügbar.", 403);
  if (write) await assertProjectGrant(tx, session, row.project_id, true);
  return row;
}
async function profileRow(tx: TenantTransaction, session: AppSession, leadId: string,write=false) {
  return tx.queryOne<Row>(`select b.*,b.updated_at::text as source_updated_at from buyer_search_profiles b where workspace_id=$1::uuid and buyer_lead_id=$2::uuid ${write?"for update":""}`, [session.workspaceId, leadId]);
}
function profileDto(row: Row | null, lead?: Row,preferences?:Row|null): LeadMatchProfile {
  const meta = object(row?.metadata), buyer = object(lead?.buyer_profile);
  return { countryCode: typeof meta.countryCode === "string" ? meta.countryCode : "", location: String(row?.desired_location ?? ""), propertyType: String(row?.property_type ?? ""), budgetFromCents: money(row?.budget_from_cents), budgetToCents: money(row?.budget_to_cents), areaSqm: number(row?.area_sqm), rooms: number(row?.rooms), useCase: ["Eigennutzung", "Anlage"].includes(String(buyer.useCase)) ? buyer.useCase as LeadMatchProfile["useCase"] : null, manualCriteria: Array.isArray(row?.must_have_criteria) ? row.must_have_criteria.map(String) : [],purchaseWindow:preferences?.purchase_from&&preferences?.purchase_to?{from:String(preferences.purchase_from).slice(0,10),to:String(preferences.purchase_to).slice(0,10)} as LeadPurchaseWindow:null,featureRules:object(preferences?.feature_rules) as LeadFeatureRules,requirementsReviewed:preferences?.requirements_reviewed===true };
}
export async function readLeadQualificationProfileInTransaction(tx:TenantTransaction,session:AppSession,leadId:string,write=false){const lead=await qualificationLead(tx,session,leadId,write),row=await profileRow(tx,session,leadId,write),installed=(await tx.queryOne<{ready:boolean}>(`select to_regclass('public.lead_qualification_preferences') is not null as ready`))?.ready===true;const preferences=installed?await tx.queryOne<Row>(`select *,purchase_from::text as purchase_from,purchase_to::text as purchase_to from lead_qualification_preferences where workspace_id=$1::uuid and lead_id=$2::uuid ${write?"for update":""}`,[session.workspaceId,leadId]):null;return{lead,row,preferences,installed,profile:profileDto(row,lead,preferences),revision:crmPayloadDigest({source:row?.source_updated_at??null,preferencesVersion:preferences?.version??0})};}
export async function getLeadQualification(session: AppSession, leadId: string, options: TenantTransactionOptions = {}): Promise<LeadQualificationState> {
  return withCrmRead(session, async (tx, fresh) => {
    const bundle=await readLeadQualificationProfileInTransaction(tx,fresh,leadId),lead=bundle.lead;
    const proofs = await tx.query<LeadQualificationProof>(`select p.id,p.kind,p.purpose,m.original_name as "fileName",p.status,p.uploaded_at as "uploadedAt",p.usable_until as "usableUntil",p.review_reason as "reviewReason",p.version,(p.status<>'revoked' and p.usable_until>clock_timestamp()) as available from lead_qualification_proofs p join media_assets m on m.id=p.media_asset_id and m.workspace_id=p.workspace_id::text where p.workspace_id=$1::uuid and p.lead_id=$2::uuid order by p.uploaded_at desc limit 100`, [fresh.workspaceId, leadId]);
    const matches = await tx.query<LeadPropertyMatch&{criteriaSnapshot:LeadMatchProfile&{purchaseWindowExpired?:boolean}}>(`select m.criteria_snapshot as "criteriaSnapshot",m.id,m.property_id as "propertyId",p.title as "propertyTitle",m.score,m.coverage,m.eligible,(m.profile_updated_at=b.updated_at and m.property_updated_at=p.updated_at and m.algorithm_version=$3 and nullif(coalesce(u.price_cents,p.target_price_cents),0) is not distinct from (m.property_snapshot->>'priceCents')::bigint and (p.property_status not in('archived','error','paused') and (u.id is null or u.status='available'))=(m.property_snapshot->>'available')::boolean) as fresh,m.reasons,m.computed_at as "computedAt" from lead_property_matches m join seller_listings p on p.id=m.property_id and p.workspace_id=m.workspace_id join buyer_search_profiles b on b.id=m.profile_id and b.workspace_id=m.workspace_id left join property_units u on u.id=p.unit_id and u.workspace_id=p.workspace_id where m.workspace_id=$1::uuid and m.lead_id=$2::uuid order by m.eligible desc,m.score desc,p.title limit 200`, [fresh.workspaceId, leadId, leadMatchAlgorithmVersion]);
    const job = await tx.queryOne<{ pending: boolean }>(`select processed_at is null or processed_at<requested_at as pending from lead_match_refresh_jobs where workspace_id=$1::uuid and lead_id=$2::uuid`, [fresh.workspaceId, leadId]);
    return { leadId, projectId: String(lead.project_id), leadTitle: String(lead.intent), qualified: Object.keys(object(lead.sales_qualification)).length > 0, profile:bundle.profile,profileRevision:bundle.revision,completeness:leadProfileCompleteness(bundle.profile), proofs: proofs.map((proof) => ({ ...proof, downloadUrl: `/api/crm/lead-qualification/proofs/${proof.id}?workspaceId=${encodeURIComponent(fresh.workspaceId)}` })), matches:matches.map(({criteriaSnapshot,...match})=>({...match,fresh:match.fresh&&(criteriaSnapshot.purchaseWindowExpired===true)===leadPurchaseWindowExpired(criteriaSnapshot)})), refreshPending: job?.pending === true };
  }, options);
}
export async function uploadLeadQualificationProof(session: AppSession, input: { leadId: string; kind: LeadProofKind; purpose: string; usableDays: number; file: File }, meta: Meta, options: TenantTransactionOptions = {}) {
  assertCrmUuid(input.leadId);
  if (!["financing_confirmation", "funds_evidence", "other"].includes(input.kind)) throw new CrmCommandError("INVALID_PROOF_KIND", "Nachweisart ist ungültig.");
  const purpose = text(input.purpose, "Verwendungszweck", 10);
  if (!Number.isInteger(input.usableDays) || input.usableDays < 1 || input.usableDays > 365 || input.file.size < 1 || input.file.size > leadProofMaxUploadBytes) throw new CrmCommandError("INVALID_PROOF_FILE", "Datei darf höchstens 4 MB groß sein; Nutzungsfrist 1 bis 365 Tage.");
  const contentHash = createHash("sha256").update(new Uint8Array(await input.file.arrayBuffer())).digest("hex");
  const projectId = await withCrmRead(session, async (tx,fresh) => String((await qualificationLead(tx,fresh,input.leadId)).project_id), options);
  let uploaded: MediaAsset | undefined;
  try {
    return await executeCrmCommand(session, { operation: "lead_qualification.proof_upload", resourceId: input.leadId, projectId, capability: "pipeline:write", ...meta, payload: { leadId: input.leadId, kind: input.kind, purpose, usableDays: input.usableDays, fileName: input.file.name, mimeType: input.file.type, size: input.file.size, contentHash } }, async (tx, ctx) => {
      const lead = await qualificationLead(tx, ctx.session, input.leadId, true), projectId = String(lead.project_id);
      uploaded = await saveLeadProofFile({ actorId: ctx.actorId, workspaceId: ctx.workspaceId, leadId: input.leadId, file: input.file });
      const proof = await tx.queryOne<{ id: string; version: number }>(`insert into lead_qualification_proofs(workspace_id,project_id,lead_id,media_asset_id,kind,purpose,content_hash,uploaded_by,usable_until) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8::uuid,clock_timestamp()+($9::int*interval '1 day')) returning id,version`, [ctx.workspaceId, projectId, input.leadId, uploaded.id, input.kind, purpose, contentHash, ctx.actorId, input.usableDays]);
      if (!proof) throw new CrmCommandError("PROOF_UPLOAD_FAILED", "Nachweis konnte nicht gespeichert werden.", 503);
      await recordAutomationEvent(tx, { workspaceId: ctx.workspaceId, projectId, leadId: input.leadId, eventId: `proof-uploaded:${proof.id}`, trigger: "proof_uploaded", context: { proofAccepted: false, proofId: proof.id } }, { enroll: false });
      return { id: proof.id, version: proof.version, status: "pending", externalSend: false };
    }, options);
  } catch (error) {
    if (uploaded) await withCrmRead(session, () => discardUncommittedLeadProofFile(uploaded!), options).catch(() => false);
    throw error;
  }
}
export async function reviewLeadQualificationProof(tx: TenantTransaction, session: AppSession, input: { leadId: string; proofId: string; expectedVersion: number; status: Exclude<LeadProofStatus, "pending">; reason: string }) {
  const lead = await qualificationLead(tx, session, input.leadId, true), reason = text(input.reason, "Prüfvermerk", 10);
  if (!["accepted", "rejected", "revoked"].includes(input.status)) throw new CrmCommandError("INVALID_REVIEW", "Prüfentscheidung ist ungültig.");
  const old = await tx.queryOne<{ version: number; usable: boolean; status: string }>(`select version,usable_until>clock_timestamp() as usable,status from lead_qualification_proofs where workspace_id=$1::uuid and lead_id=$2::uuid and id=$3::uuid for update`, [session.workspaceId, input.leadId, assertCrmUuid(input.proofId)]);
  if (!old || old.version !== input.expectedVersion || old.status === "revoked") throw new CrmCommandError("PROOF_VERSION_CONFLICT", "Nachweis wurde geändert oder ist nicht mehr bearbeitbar.", 409);
  if (input.status === "accepted" && !old.usable) throw new CrmCommandError("PROOF_EXPIRED", "Ein abgelaufener Nachweis kann nicht akzeptiert werden.", 409);
  const saved = await tx.queryOne<{ id: string; version: number }>(`update lead_qualification_proofs set status=$4,review_reason=$5,reviewed_by=$6::uuid,reviewed_at=clock_timestamp(),version=version+1 where workspace_id=$1::uuid and lead_id=$2::uuid and id=$3::uuid returning id,version`, [session.workspaceId, input.leadId, input.proofId, input.status, reason, session.userId]);
  await tx.execute(`insert into lead_qualification_proof_reviews(workspace_id,project_id,lead_id,proof_id,status,reason,actor_id,proof_version) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::uuid,$8)`, [session.workspaceId, lead.project_id, input.leadId, input.proofId, input.status, reason, session.userId, saved!.version]);
  await recordAutomationEvent(tx, { workspaceId: session.workspaceId, projectId: String(lead.project_id), leadId: input.leadId, eventId: `proof-reviewed:${input.proofId}:${saved!.version}`, trigger: "proof_reviewed", context: { proofAccepted: input.status === "accepted", proofId: input.proofId } }, { enroll: false });
  return { id: input.proofId, status: input.status, version: saved!.version };
}
export async function saveLeadMatchingProfile(tx: TenantTransaction, session: AppSession, leadId: string, value: unknown) {
  const lead = await qualificationLead(tx, session, leadId, true), input = object(value), prior = await profileRow(tx, session, leadId,true);
  const countryCode = input.countryCode;
  if (!isPropertyCountryCode(countryCode)) throw new CrmCommandError("MATCH_COUNTRY_REQUIRED", "Bitte das gesuchte Land auswählen.");
  const location = text(input.location, "Gewünschter Ort oder Region", 1, 300), propertyType = text(input.propertyType, "Objektart", 1, 100);
  if (!["Wohnung", "Haus", "Neubau", "Zinshaus", "Gewerbe", "Grundstück", "Portfolio"].includes(propertyType)) throw new CrmCommandError("INVALID_PROPERTY_TYPE", "Objektart ist ungültig.");
  const budgetFrom = money(input.budgetFromCents), budgetTo = money(input.budgetToCents), area = number(input.areaSqm), rooms = number(input.rooms);
  if (!Number.isSafeInteger(input.budgetFromCents) || !Number.isSafeInteger(input.budgetToCents) || budgetTo <= 0 || budgetFrom > budgetTo || (area !== null && (area <= 0 || area > 10000000)) || (rooms !== null && (rooms <= 0 || rooms > 1000))) throw new CrmCommandError("INVALID_MATCH_CRITERIA", "Budget, Fläche oder Zimmer sind ungültig.");
  const next = { countryCode, location, propertyType, budgetFromCents: budgetFrom, budgetToCents: budgetTo, areaSqm: area, rooms };
  const old = profileDto(prior, lead), qualified = Object.keys(object(lead.sales_qualification)).length > 0;
  if (qualified && (!prior || Object.entries(next).some(([key, val]) => key !== "countryCode" && old[key as keyof LeadMatchProfile] !== val))) throw new CrmCommandError("CANONICAL_QUALIFICATION_REQUIRED", "Qualifizierte Käuferdaten im vorgesehenen Verkaufsablauf ändern.", 409);
  if (qualified) await tx.execute(`update buyer_search_profiles set metadata=metadata||jsonb_build_object('countryCode',$3::text),updated_at=now() where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, prior!.id, countryCode]);
  else {
    const saved = await upsertBuyerSearchProfile({ session, profile: { ...(prior ? { id: String(prior.id) } : {}), projectId: String(lead.project_id), buyerLeadId: leadId, contactId: String(lead.contact_id), title: String(lead.intent), budgetFrom: budgetFrom / 100, budgetTo: budgetTo / 100, desiredLocation: location, propertyType: propertyType as "Wohnung", areaSqm: area ?? undefined, rooms: rooms ?? undefined, financingStatus: prior?.financing_status as "offen" | undefined, purchaseTimeline: typeof prior?.purchase_timeline === "string" ? prior.purchase_timeline : undefined, mustHaveCriteria: Array.isArray(prior?.must_have_criteria) ? prior.must_have_criteria.map(String) : [], niceToHaveCriteria: Array.isArray(prior?.nice_to_have_criteria) ? prior.nice_to_have_criteria.map(String) : [], matchingStatus: "open", metadata: { ...object(prior?.metadata), countryCode } } });
    if (!saved.persisted) throw new CrmCommandError("MATCH_PROFILE_REJECTED", saved.reason, 409);
  }
  await tx.execute(`insert into lead_match_refresh_jobs(workspace_id,project_id,lead_id) values($1::uuid,$2::uuid,$3::uuid) on conflict(workspace_id,lead_id) do update set requested_at=clock_timestamp(),processed_at=null`, [session.workspaceId, lead.project_id, leadId]);
  return { leadId, profile: next };
}
export async function computeLeadPropertyMatches(tx: TenantTransaction, session: AppSession, leadId: string) {
  await qualificationLead(tx,session,leadId,true);const bundle=await readLeadQualificationProfileInTransaction(tx,session,leadId,true),lead=bundle.lead,profile=bundle.row;
  if (!profile) throw new CrmCommandError("MATCH_PROFILE_MISSING", "Zuerst ein Suchprofil speichern.", 409);
  const criteria = bundle.profile, projectId = String(lead.project_id);
  const properties = await tx.query<Row>(`select p.id,p.title,p.region,p.city,p.object_type,p.area_sqm,p.rooms,p.balconies_count,p.terraces_count,p.gardens_count,p.garages_count,p.cellar_count,coalesce(u.price_cents,p.target_price_cents) as price_cents,p.marketing_type,p.usage_type,p.canonical_payload,p.updated_at::text as source_updated_at,(p.property_status not in('archived','error','paused') and (u.id is null or u.status='available')) as available from seller_listings p left join property_units u on u.id=p.unit_id and u.workspace_id=p.workspace_id where p.workspace_id=$1::uuid and p.project_id=$2::uuid order by p.id limit 501`, [session.workspaceId, projectId]);
  if (properties.length > 500) throw new CrmCommandError("MATCH_BATCH_TOO_LARGE", "Dieses Projekt benötigt eine seitenweise Matching-Auswertung.", 409);
  let updated = 0, newMatches = 0;
  for (const property of properties) {
    const geography = readPropertyGeography({ canonicalPayload: object(property.canonical_payload), region: property.region });
    const flag=(key:string)=>property[key]===null||property[key]===undefined?null:Number(property[key])>0;
    const source: LeadMatchProperty = { id: String(property.id), title: String(property.title), countryCode: geography?.countryCode ?? "", region: String(property.region ?? ""), city: String(property.city ?? ""), propertyType: String(property.object_type ?? ""), priceCents: money(property.price_cents) || null, areaSqm: number(property.area_sqm), rooms: number(property.rooms), marketingType: String(property.marketing_type), usageType: String(property.usage_type ?? ""), available: property.available === true,features:{balcony:flag('balconies_count'),terrace:flag('terraces_count'),garden:flag('gardens_count'),garage:flag('garages_count'),cellar:flag('cellar_count')} };
    const profileUpdatedAt = String(profile.source_updated_at), propertyUpdatedAt = String(property.source_updated_at);
    const criteriaSnapshot={...criteria,purchaseWindowExpired:leadPurchaseWindowExpired(criteria)};
    const fingerprint = crmPayloadDigest({ algorithm: leadMatchAlgorithmVersion, criteria:criteriaSnapshot, source, profileUpdatedAt, propertyUpdatedAt });
    const old = await tx.queryOne<{ id: string; sourceFingerprint: string; eligible: boolean }>(`select id,source_fingerprint as "sourceFingerprint",eligible from lead_property_matches where workspace_id=$1::uuid and lead_id=$2::uuid and property_id=$3::uuid for update`, [session.workspaceId, leadId, property.id]);
    if (old?.sourceFingerprint === fingerprint) continue;
    const result = evaluateLeadPropertyMatch(criteria, source);
    const saved = await tx.queryOne<{ id: string; version: number }>(`insert into lead_property_matches(workspace_id,project_id,lead_id,property_id,profile_id,algorithm_version,source_fingerprint,score,coverage,eligible,reasons,criteria_snapshot,property_snapshot,profile_updated_at,property_updated_at) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::timestamptz,$15::timestamptz) on conflict(workspace_id,lead_id,property_id) do update set profile_id=excluded.profile_id,algorithm_version=excluded.algorithm_version,source_fingerprint=excluded.source_fingerprint,score=excluded.score,coverage=excluded.coverage,eligible=excluded.eligible,reasons=excluded.reasons,criteria_snapshot=excluded.criteria_snapshot,property_snapshot=excluded.property_snapshot,profile_updated_at=excluded.profile_updated_at,property_updated_at=excluded.property_updated_at,computed_at=clock_timestamp(),version=lead_property_matches.version+1 returning id,version`, [session.workspaceId, projectId, leadId, property.id, profile.id, leadMatchAlgorithmVersion, fingerprint, result.score, result.coverage, result.eligible, JSON.stringify(result.reasons), JSON.stringify(criteriaSnapshot), JSON.stringify(source), profileUpdatedAt, propertyUpdatedAt]);
    updated++;
    await tx.execute(`insert into lead_property_match_history(workspace_id,project_id,lead_id,match_id,match_version,algorithm_version,source_fingerprint,result_snapshot,criteria_snapshot,property_snapshot,actor_id) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::uuid)`, [session.workspaceId,projectId,leadId,saved!.id,saved!.version,leadMatchAlgorithmVersion,fingerprint,JSON.stringify(result),JSON.stringify(criteriaSnapshot),JSON.stringify(source),session.userId]);
    if (result.eligible && !old?.eligible) {
      await recordAutomationEvent(tx, { workspaceId: session.workspaceId, projectId, leadId, eventId: `property-match:${saved!.id}:${saved!.version}`, trigger: "new_match", context: { matchScore: result.score, matchId: saved!.id } }, { enroll: false }); newMatches++;
    }
  }
  await tx.execute(`update lead_match_refresh_jobs set processed_at=clock_timestamp() where workspace_id=$1::uuid and lead_id=$2::uuid`, [session.workspaceId, leadId]);
  return { leadId, evaluated: properties.length, updated, newMatches, algorithmVersion: leadMatchAlgorithmVersion };
}
export async function processLeadMatchRefreshJobs(tx: TenantTransaction, session: AppSession, projectId?: string | null, limit = 5) {
  const jobs = await tx.query<{ leadId: string }>(`select lead_id as "leadId" from lead_match_refresh_jobs where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) and (processed_at is null or processed_at<requested_at) order by requested_at limit $3`, [session.workspaceId, projectId || null, Math.max(1, Math.min(10, limit))]);
  let processed = 0;
  for (const job of jobs) {
    try { await computeLeadPropertyMatches(tx, session, job.leadId); processed++; }
    catch(error){if(error instanceof CrmCommandError&&error.code==='MATCH_PROFILE_MISSING')await tx.execute(`update lead_match_refresh_jobs set processed_at=clock_timestamp() where workspace_id=$1::uuid and lead_id=$2::uuid`,[session.workspaceId,job.leadId]);else throw error;}
  }
  return processed;
}
export async function getLeadProofAsset(session: AppSession, proofId: string, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, async (tx, fresh) => {
    const row = await tx.queryOne<{ leadId: string; assetId: string }>(`select lead_id as "leadId",media_asset_id as "assetId" from lead_qualification_proofs where workspace_id=$1::uuid and id=$2::uuid and status<>'revoked' and usable_until>clock_timestamp()`, [fresh.workspaceId, assertCrmUuid(proofId)]);
    if (!row) throw new CrmCommandError("PROOF_UNAVAILABLE", "Nachweis ist nicht verfügbar.", 404);
    const lead=await qualificationLead(tx, fresh, row.leadId);
    await tx.execute(`insert into audit_logs(workspace_id,project_id,actor_user_id,action,entity_type,entity_id,after) values($1::uuid,$2::uuid,$3::uuid,'lead_qualification.proof_access','lead_qualification_proof',$4::uuid,jsonb_build_object('leadId',$5::text,'purpose','manual_document_review'))`,[fresh.workspaceId,lead.project_id,fresh.userId,proofId,row.leadId]);
    return authorizedLeadProofMediaAsset(row.assetId, fresh.workspaceId, row.leadId);
  }, options);
}
