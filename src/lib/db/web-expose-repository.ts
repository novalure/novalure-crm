import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, type TenantTransaction } from "@/lib/crm-command";
import { countryPublicationChecks, normalizePropertyEnergyCertificate, readPropertyGeography } from "@/lib/property-country";
import { canWritePropertyExpose } from "@/lib/db/property-expose-repositories";
import { webExposeCopy, webExposePropertyType, type WebExposeLanguage, type WebExposePublic, type WebExposeSnapshot } from "@/lib/web-expose";
import { queryOne } from "@/lib/db/client";
import { parsePropertyIntegerCents } from "@/lib/property-money";
import { decryptAuthValue, encryptAuthValue } from "@/lib/auth/auth-security";
import { webExposeRetentionScheduled } from "@/lib/web-expose-maintenance";
import { projectReportMoney } from "@/lib/project-sales-report";
import { freezeWebExposeTemplate } from "@/lib/db/web-expose-template-repository";
import { formatApprovedPropertyCosts, publicPropertyCostKeys, publicPropertyDetailGroups, publicPropertyDetailPayloadSql, publicPropertyUnitFacts, publicUnitDetailsSql, readPublicPropertyDetails, type PublicPropertyUnitDetails } from "@/lib/property-expose-details";
import { propertyDetailNumber } from "@/lib/property-details";

export const webExposeToken = () => randomBytes(32).toString("base64url");
export const webExposeHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const validWebExposeToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
function safeUrl(value: unknown) { try { const u = new URL(text(value)); return u.protocol === "https:" && !u.username && !u.password ? u.toString() : ""; } catch { return ""; } }
export type WebExposePublishInput = { propertyId: string; language: WebExposeLanguage; title?: string; description?: string; privacyUrl: string; legalUrl: string; controller: string; showAddress: boolean; showContact: boolean; reviewed: boolean; resourceIds?:string[];includeLegacyMedia?:boolean;expectedSourceFingerprint?: string;templateVersionId?:string };
export function parseWebExposePublishInput(value: Record<string, unknown>): WebExposePublishInput {
  for (const key of ["controller", "privacyUrl", "legalUrl"]) if (typeof value[key] !== "string") throw new CrmCommandError("INVALID_INPUT", "Anbieter und Rechtstexte fehlen");
  if (!["de", "en", "es"].includes(String(value.language)) || typeof value.showAddress !== "boolean" || typeof value.showContact !== "boolean" || typeof value.reviewed !== "boolean" ||
      (value.title !== undefined && typeof value.title !== "string") || (value.description !== undefined && typeof value.description !== "string")) throw new CrmCommandError("INVALID_INPUT", "Exposé-Angaben ungültig");
  if((value.includeLegacyMedia!==undefined&&typeof value.includeLegacyMedia!=="boolean")||(value.resourceIds!==undefined&&(!Array.isArray(value.resourceIds)||value.resourceIds.length>100||new Set(value.resourceIds).size!==value.resourceIds.length||value.resourceIds.some(id=>typeof id!=="string"||!/^[0-9a-f-]{36}$/i.test(id))))) throw new CrmCommandError("INVALID_MEDIA","Medienauswahl ungültig");
  return { propertyId: assertCrmUuid(value.propertyId), language: value.language as WebExposeLanguage, controller: value.controller as string, privacyUrl: value.privacyUrl as string, legalUrl: value.legalUrl as string,
    templateVersionId:value.templateVersionId===undefined||value.templateVersionId===""?undefined:assertCrmUuid(value.templateVersionId),
    showAddress: value.showAddress, showContact: value.showContact, reviewed: value.reviewed, title: value.title as string | undefined, description: value.description as string | undefined,
    includeLegacyMedia:value.includeLegacyMedia!==false,resourceIds:Array.isArray(value.resourceIds)?value.resourceIds as string[]:[],expectedSourceFingerprint: typeof value.expectedSourceFingerprint === "string" ? value.expectedSourceFingerprint : undefined };
}
export async function buildWebExposeSnapshot(tx: TenantTransaction, session: AppSession, input: WebExposePublishInput) {
  const id = assertCrmUuid(input.propertyId);
  const row = await tx.queryOne<{ projectId: string | null; unitId: string | null; title: string; address: string; city: string; region: string; objectType: string; area: string; rooms: string; yearBuilt: number; priceCents: string; priceVisibility: string; canonicalPayload: Record<string, unknown>; publicDetails: Record<string, unknown>; contactName: string; contactEmail: string; contactPhone: string }>(`select project_id as "projectId",unit_id::text as "unitId",title,address,city,region,object_type as "objectType",area_sqm::text as area,rooms::text,year_built as "yearBuilt",coalesce(public_price_cents,target_price_cents)::text as "priceCents",price_visibility as "priceVisibility",canonical_payload as "canonicalPayload",${publicPropertyDetailPayloadSql("p")} as "publicDetails",contact_name as "contactName",contact_email as "contactEmail",contact_phone as "contactPhone" from seller_listings p where id=$1::uuid and workspace_id=$2::uuid`, [id, session.workspaceId]);
  if (!row) throw new CrmCommandError("NOT_FOUND", "Immobilie nicht gefunden", 404);
  if (row.projectId) await assertProjectGrant(tx, session, row.projectId, false);
  const geography = readPropertyGeography({ canonicalPayload: row.canonicalPayload, region: row.region });
  if (!geography) throw new CrmCommandError("COUNTRY_REQUIRED", "Bitte zuerst das Objektland festlegen");
  if (!["de", "en", "es"].includes(input.language)) throw new CrmCommandError("LANGUAGE_REQUIRED", "Inhaltssprache fehlt");
  const customDescription = text(input.description);
  const texts = await tx.query<{ content: string }>(`select content from property_text_blocks where workspace_id=$1::uuid and property_id=$2::uuid and unit_id is null and text_key='expose' and visibility in ('public','channel') and status in ('approved','published') and coalesce(metadata->>'language',$3)=$3 order by position,id`, [session.workspaceId, id, input.language]);
  if (input.language !== geography.contentLanguage && !customDescription) throw new CrmCommandError("TRANSLATION_REQUIRED", "Für diese Sprachversion einen eigenen Beschreibungstext erfassen");
  const privacyUrl = safeUrl(input.privacyUrl), legalUrl = safeUrl(input.legalUrl);
  if (!privacyUrl || !legalUrl || !text(input.controller) || input.controller.length > 300 || (input.title?.length ?? 0) > 300 || customDescription.length > 16000) throw new CrmCommandError("PUBLICATION_INPUT", "Titel, Beschreibung, Anbieter, Datenschutz- und Impressumslink prüfen");
  const energy = normalizePropertyEnergyCertificate(row.canonicalPayload?.energyCertificate) ?? {};
  const extra = await tx.queryOne<{ usageType: string; yearBuilt: number; rentPrice: string | null; marketingType: string; webVisibility: string | null }>(`select usage_type as "usageType",year_built as "yearBuilt",rent_price_cents::text as "rentPrice",marketing_type as "marketingType",channel_price_visibility->>'Website' as "webVisibility" from seller_listings where id=$1::uuid and workspace_id=$2::uuid`, [id, session.workspaceId]);
  const checks = countryPublicationChecks({ geography, energy, usageType: extra?.usageType, yearBuilt: extra?.yearBuilt });
  const media = await tx.query<WebExposeSnapshot["media"][number]>(`select m.id::text,m.title,case when m.media_type='floorplan' then 'floorplan' else 'image' end as kind,m.media_asset_id::text as "assetId" from property_media m join media_assets a on a.id=m.media_asset_id and a.workspace_id=m.workspace_id::text where m.workspace_id=$1::uuid and m.property_id=$2::uuid and m.project_id is not distinct from $3::uuid and m.unit_id is null and m.status in ('approved','published') and m.visibility in ('public','channel') and lower(m.category) not in('proof','internal','contract','funding') and a.storage_access='private' and not a.is_public and a.public_token is null and lower(a.folder) not like 'lead-proof-private-%' and lower(a.folder) not like 'knowledge-private-%' and a.mime_type in ('image/jpeg','image/png','image/webp') and not exists(select 1 from property_media blocked where blocked.workspace_id=m.workspace_id and blocked.media_asset_id=a.id and lower(blocked.category) in('proof','internal','contract','funding')) and not exists(select 1 from property_documents blocked where blocked.workspace_id=m.workspace_id and blocked.media_asset_id=a.id and blocked.category not in('expose','novalure_expose','floorplan','energy_certificate')) order by m.is_cover desc,m.position,m.id limit 30`, [session.workspaceId, id,row.projectId]);
  let resources:NonNullable<WebExposeSnapshot["resources"]>=[];
  if(input.resourceIds?.length){
    const installed=await tx.queryOne<{ready:boolean}>(`select to_regclass('public.web_expose_resources') is not null as ready`);
    if(!installed?.ready) throw new CrmCommandError("MEDIA_UNAVAILABLE","Exposé-Medien sind noch nicht eingerichtet",503);
    resources=await tx.query<NonNullable<WebExposeSnapshot["resources"]>[number]>(`select r.id::text,r.kind,r.title,r.asset_id::text as "assetId",r.url,a.mime_type as "mimeType" from web_expose_resources r left join media_assets a on a.id=r.asset_id and a.workspace_id=r.workspace_id::text where r.workspace_id=$1::uuid and r.property_id=$2::uuid and r.id=any($3::uuid[]) and r.status='approved' and r.visibility='published' and not r.archived order by array_position($3::uuid[],r.id)`,[session.workspaceId,id,input.resourceIds]);
    if(resources.length!==input.resourceIds.length) throw new CrmCommandError("MEDIA_REVIEW_REQUIRED","Ausgewählte Medien sind nicht mehr für dieses Exposé freigegeben",409);
  }
  const units = row.projectId ? await tx.query<{ id: string; number: string; area: string; rooms: string; price: string; status: string; details: PublicPropertyUnitDetails }>(`select u.id::text,u.unit_number as number,u.area_sqm::text as area,u.rooms::text,u.price_cents::text as price,u.status,${publicUnitDetailsSql("u")} as details from property_units u join seller_listings p on p.id=$3::uuid and p.workspace_id=u.workspace_id and p.project_id=u.project_id where u.workspace_id=$1::uuid and u.project_id=$2::uuid and (u.metadata->>'sellerListingId'=p.id::text or u.id=p.unit_id) and coalesce(u.metadata->>'hidden','false')<>'true' order by u.unit_number limit 200`, [session.workspaceId, row.projectId, id]) : [];
  const money = (cents: string | number) => { const valid = parsePropertyIntegerCents(cents); if (valid === null) throw new CrmCommandError("INVALID_PRICE", "Preis ist nicht darstellbar"); return valid>0?projectReportMoney(String(valid),geography.displayLocale):null; };
  const locale = geography.displayLocale;
  const num = (n: string | number) => new Intl.NumberFormat(locale).format(Number(n));
  const details = readPublicPropertyDetails(row.publicDetails);
  const detailGroups = publicPropertyDetailGroups(row.publicDetails, input.language, locale, ["rooms.zimmer", "construction.baujahr"]);
  const linkedUnit = units.find(unit => unit.id === row.unitId);
  const linkedFacts = linkedUnit ? publicPropertyUnitFacts(linkedUnit.details, input.language, locale) : [];
  if (linkedFacts.length) detailGroups.push({ id: "linked-unit", heading: input.language === "de" ? "Ausgewählte Einheit" : input.language === "es" ? "Unidad seleccionada" : "Selected unit", facts: linkedFacts });
  const labels = input.language === "de" ? ["Objektart", "Wohnfläche", "Zimmer", "Baujahr"] : input.language === "es" ? ["Tipo", "Superficie", "Habitaciones", "Año de construcción"] : ["Property type", "Area", "Rooms", "Year built"];
  const rooms = propertyDetailNumber(details, "rooms.zimmer") ?? row.rooms, yearBuilt = propertyDetailNumber(details, "construction.baujahr") ?? row.yearBuilt;
  const facts = [{ label: labels[0], value: webExposePropertyType(row.objectType,input.language) }, ...(!detailGroups.some(group => group.id === "areas") && Number(row.area)>0?[{ label: labels[1], value: `${num(row.area)} m²` }]:[]), ...(Number(rooms)>0 ? [{ label: labels[2], value: num(rooms) }] : []), ...(yearBuilt ? [{ label: labels[3], value: String(yearBuilt) }] : [])];
  if (energy.energyClass) facts.push({ label: input.language === "es" ? "Clase energética" : input.language === "de" ? "Energieklasse" : "Energy rating", value: energy.energyClass });
  if (energy.heatingDemandKwhM2 !== undefined) facts.push({ label: "HWB", value: `${num(energy.heatingDemandKwhM2)} kWh/(m²a)` });
  if (energy.finalEnergyDemandKwhM2 !== undefined) facts.push({ label: input.language === "de" ? "Endenergiebedarf" : input.language === "es" ? "Demanda de energía final" : "Final energy demand", value: `${num(energy.finalEnergyDemandKwhM2)} kWh/(m²a)` });
  const energyLabels = input.language === "de" ? ["Endenergieverbrauch", "Wärmeenergie", "Stromenergie", "Energieträger", "Ausweistyp", "Ausgestellt", "Gültig bis", "Registrierung", "Ausweisnummer", "Skala"] : input.language === "es" ? ["Consumo de energía final", "Energía térmica", "Electricidad", "Fuente de energía", "Tipo de certificado", "Fecha de emisión", "Válido hasta", "Registro", "Número de certificado", "Escala"] : ["Final energy consumption", "Heating energy", "Electricity", "Energy source", "Certificate type", "Issued", "Valid until", "Registration", "Certificate number", "Rating scheme"];
  [energy.finalEnergyConsumptionKwhM2, energy.heatingEnergyKwhM2, energy.electricityEnergyKwhM2].forEach((value, i) => { if (value !== undefined) facts.push({ label: energyLabels[i], value: `${num(value)} kWh/(m²a)` }); });
  const certificateNames:Record<string,Record<WebExposeLanguage,string>>={demand:{de:"Bedarfsausweis",en:"Demand certificate",es:"Certificado de demanda"},consumption:{de:"Verbrauchsausweis",en:"Consumption certificate",es:"Certificado de consumo"},existing:{de:"Bestandsgebäude",en:"Existing building",es:"Edificio existente"},new:{de:"Neubau",en:"New build",es:"Obra nueva"}};
  [energy.energySource, energy.certificateType?certificateNames[energy.certificateType]?.[input.language]??energy.certificateType:undefined, energy.issuedAt, energy.validUntil, energy.registration, energy.certificateNumber, energy.schemeVersion].forEach((value, i) => { if (value) facts.push({ label: energyLabels[i + 3], value }); });
  const visibility = ["publish_price", "price_on_request", "hide_price"].includes(extra?.webVisibility ?? "") ? extra!.webVisibility : row.priceVisibility;
  const costRows = visibility === "publish_price" ? await tx.query<Record<string, unknown>>(`select cost_key as "costKey",monthly_gross_cents::text as "monthlyGrossCents",one_time_gross_cents::text as "oneTimeGrossCents" from property_cost_items where workspace_id=$1::uuid and property_id=$2::uuid and project_id is not distinct from $3::uuid and (unit_id is null or unit_id=$4::uuid) and expose_visible and cost_key=any($5::text[]) order by position,id`, [session.workspaceId, id, row.projectId, row.unitId, publicPropertyCostKeys]) : [];
  const priceCents = extra?.marketingType === "rent" ? extra.rentPrice : row.priceCents;
  const authority = await tx.queryOne<{ developer: boolean; confirmed: boolean }>(`select (pr.developer_organization_id is not null or pr.customer_type='property_developer' or lower(pr.type) like '%bautr%' or w.customer_type='property_developer') as developer,exists(select 1 from property_units u where u.workspace_id=p.workspace_id and u.project_id=p.project_id and u.id=p.unit_id and u.price_cents=$3::bigint and u.metadata->'priceConfirmation'->>'sourceReference' is not null and u.metadata->'priceConfirmation'->>'priceCents'=u.price_cents::text) as confirmed from seller_listings p join workspaces w on w.id=p.workspace_id left join projects pr on pr.id=p.project_id and pr.workspace_id=p.workspace_id where p.id=$1::uuid and p.workspace_id=$2::uuid`, [id,session.workspaceId,priceCents ?? "0"]);
  if (authority?.developer && visibility === "publish_price" && Number(priceCents)>0 && !authority.confirmed) checks.push({ id:"DEVELOPER-PRICE",ruleVersion:"sales-price-confirmation-1",status:"missing",message:"Bauträgerpreis zuerst über den bestätigten Einheitenpreis freigeben.",source:"" });
  const description = customDescription || texts.map(t => t.content).join("\n\n");
  const template = input.templateVersionId ? await freezeWebExposeTemplate(tx,session,input.templateVersionId) : undefined;
  const snapshot: WebExposeSnapshot = { schemaVersion: 1, language: input.language, locale, countryCode: geography.countryCode,
    ...(template?{template}:{}),
    title: text(input.title) || row.title, description: !input.showAddress && row.address.length > 3 ? description.split(row.address).join("[…]") : description, location: input.showAddress ? row.address : row.city || row.region,
    priceVisibility:visibility as WebExposeSnapshot["priceVisibility"],price: visibility === "publish_price" && priceCents !== null ? money(priceCents ?? row.priceCents) : null, facts,
    detailGroups: detailGroups.map(group => ({ ...group, facts: group.facts.map(fact => ({ ...fact, value: !input.showAddress && row.address.length > 3 ? fact.value.split(row.address).join("[…]") : fact.value })) })),
    costs: formatApprovedPropertyCosts(costRows, input.language, locale), media:input.includeLegacyMedia===false?[]:media,resources,
    units: units.map(u => ({ id: u.id, number: u.number, status: u.status, area: Number(u.area)>0?num(u.area):"—", rooms: Number(u.rooms)>0?num(u.rooms):"—", price: visibility === "publish_price" ? money(u.price) : null, facts: publicPropertyUnitFacts(u.details, input.language, locale) })),
    contact: input.showContact ? { name: text(row.contactName), email: text(row.contactEmail), phone: text(row.contactPhone) } : { name: "", email: "", phone: "" },
    privacyUrl, legalUrl, controller: text(input.controller), publishedAt: new Date().toISOString() };
  return { snapshot, checks, projectId: row.projectId, sourceFingerprint: webExposeHash(JSON.stringify({ ...snapshot, publishedAt: null })) };
}
export async function publishWebExpose(tx: TenantTransaction, session: AppSession, input: WebExposePublishInput) {
  if (!canWritePropertyExpose(session)) throw new CrmCommandError("FORBIDDEN", "Veröffentlichungsrecht fehlt", 403);
  await tx.query(`select id from seller_listings where id=$1::uuid and workspace_id=$2::uuid for update`, [input.propertyId, session.workspaceId]);
  const example=await tx.queryOne<{synthetic:boolean}>(`select coalesce(canonical_payload->'onboardingExample'->>'synthetic','false')='true' as synthetic from seller_listings where id=$1::uuid and workspace_id=$2::uuid`,[input.propertyId,session.workspaceId]);
  if(example?.synthetic) throw new CrmCommandError("EXAMPLE_PUBLICATION_BLOCKED","Beispielobjekte können als Vorschau geprüft, aber nicht öffentlich veröffentlicht werden.",409);
  const built = await buildWebExposeSnapshot(tx, session, input);
  if (built.projectId) await assertProjectGrant(tx, session, built.projectId, true);
  if (!input.reviewed || built.checks.some(c => c.status === "missing")) throw new CrmCommandError("PUBLICATION_REVIEW", "Länderangaben vervollständigen und Veröffentlichung prüfen", 409);
  if (input.expectedSourceFingerprint !== built.sourceFingerprint) throw new CrmCommandError("PREVIEW_CHANGED", "Immobiliendaten oder Exposé-Inhalt geändert. Vorschau erneut prüfen.", 409);
  const v = await tx.queryOne<{ id: string; version: number }>(`insert into web_expose_versions(workspace_id,property_id,project_id,created_by,language,version,snapshot,source_fingerprint) select $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,coalesce(max(version),0)+1,$6::jsonb,$7 from web_expose_versions where workspace_id=$1::uuid and property_id=$2::uuid and language=$5 returning id,version`, [session.workspaceId, input.propertyId, built.projectId, session.userId, input.language, JSON.stringify(built.snapshot), webExposeHash(JSON.stringify(built.snapshot))]);
  if (!v) throw new Error("publish_unconfirmed");
  return { ...v, ...await createWebExposeLink(tx, session, { versionId: v.id, label: "Website", leadId: null, expiresAt: null }) };
}
export async function createWebExposeLink(tx: TenantTransaction, session: AppSession, input: { versionId: string; label: string; leadId: string | null; expiresAt: string | null }) {
  if (!canWritePropertyExpose(session)) throw new CrmCommandError("FORBIDDEN", "Veröffentlichungsrecht fehlt", 403);
  assertCrmUuid(input.versionId); if (input.leadId) assertCrmUuid(input.leadId);
  const version=await tx.queryOne(`select id from web_expose_versions where id=$1::uuid and workspace_id=$2::uuid and active for share`,[input.versionId,session.workspaceId]);
  if(!version) throw new CrmCommandError("NOT_FOUND","Sprachversion nicht verfügbar",404);
  if (!text(input.label) || input.label.length > 200 || (input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()))) throw new CrmCommandError("INVALID_LINK", "Linkname oder Ablauf ungültig");
  const token = webExposeToken();
  const linkId = randomUUID();
  const encrypted = encryptAuthValue({ purpose:"web-expose-link", workspaceId:session.workspaceId, linkId, versionId:input.versionId, token });
  const l = await tx.queryOne<{ id: string }>(`insert into web_expose_links(id,workspace_id,version_id,token_hash,token_ciphertext,label,intended_lead_id,expires_at) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8::timestamptz) returning id`, [linkId,session.workspaceId, input.versionId, webExposeHash(token), encrypted,input.label, input.leadId, input.expiresAt]);
  if (!l) throw new Error("link_unconfirmed");
  return { linkId: l.id, path: `/expose/${token}` };
}
export async function recoverWebExposeLink(tx: TenantTransaction, session: AppSession, propertyId: string, linkId: string) {
  if (!canWritePropertyExpose(session)) throw new CrmCommandError("FORBIDDEN", "Linkverwaltung erfordert Veröffentlichungsrechte",403);
  const grant=await tx.queryOne<{allowed:boolean}>(`select crm_web_expose_access($1::uuid,$2::uuid,true) as allowed`,[session.workspaceId,assertCrmUuid(propertyId)]);
  if(!grant?.allowed) throw new CrmCommandError("FORBIDDEN","Linkverwaltung erfordert Bearbeitungsrechte für dieses Objekt",403);
  const row = await tx.queryOne<{ workspaceId:string; versionId:string; tokenHash:string; ciphertext:string|null }>(`select l.workspace_id as "workspaceId",l.version_id as "versionId",l.token_hash as "tokenHash",l.token_ciphertext as ciphertext from web_expose_links l join web_expose_versions v on v.id=l.version_id and v.workspace_id=l.workspace_id where l.id=$1::uuid and l.workspace_id=$2::uuid and v.property_id=$3::uuid and l.revoked_at is null and v.active and (l.expires_at is null or l.expires_at>clock_timestamp())`,[assertCrmUuid(linkId),session.workspaceId,assertCrmUuid(propertyId)]);
  const secret = row?.ciphertext ? decryptAuthValue<{purpose:string;workspaceId:string;linkId:string;versionId:string;token:string}>(row.ciphertext) : null;
  if (!row || !secret || secret.purpose!=="web-expose-link" || secret.workspaceId!==session.workspaceId || secret.linkId!==linkId || secret.versionId!==row.versionId || !validWebExposeToken(secret.token) || webExposeHash(secret.token)!==row.tokenHash) throw new CrmCommandError("LINK_UNAVAILABLE","Link nicht wiederherstellbar. Bitte einen neuen Link anlegen.",409);
  return { path:`/expose/${secret.token}` };
}
export async function lookupWebExpose(token: string): Promise<WebExposePublic | null> {
  if (!validWebExposeToken(token)) return null;
  const r = await queryOne<{ data: WebExposePublic | null }>(`select crm_web_expose_lookup($1) as data`, [webExposeHash(token)]);
  const data=r?.data??null;
  if(data){
    const live=await queryOne<{data:{units:{id:string;status:string;priceCents:string|null}[];priceCents:string|null;priceVisibility:NonNullable<WebExposeSnapshot["priceVisibility"]>;asOf:string}|null}>(`select crm_web_expose_inventory($1) as data`,[webExposeHash(token)]);
    if(!live?.data)return null;
    const inventory=live.data;
    const money=(cents:string|null)=>{if(cents===null)return null;const value=parsePropertyIntegerCents(cents);return value===null||value<=0?null:projectReportMoney(cents,data.snapshot.locale);};
    data.snapshot.price=money(inventory.priceCents);
    data.snapshot.priceVisibility=inventory.priceVisibility;
    if (inventory.priceVisibility !== "publish_price") data.snapshot.costs=[];
    data.snapshot.units=data.snapshot.units.flatMap(unit=>{const current=inventory.units.find(row=>row.id===unit.id);return current?[{...unit,status:current.status,price:money(current.priceCents)}]:[];});
    data.snapshot.inventoryAsOf=inventory.asOf;
  }
  if(data?.snapshot.resources?.length){
    const live=await queryOne<{data:WebExposeSnapshot["resources"]}>(`select crm_web_expose_live_resources($1) as data`,[webExposeHash(token)]);
    data.snapshot.resources=Array.isArray(live?.data)?live.data:[];
  }
  return data;
}
export async function listWebExposeState(tx: TenantTransaction, session: AppSession, propertyId: string) {
  assertCrmUuid(propertyId);
  const property = await tx.queryOne(`select id from seller_listings where id=$1::uuid and workspace_id=$2::uuid`, [propertyId, session.workspaceId]);
  if (!property) throw new CrmCommandError("NOT_FOUND", "Immobilie nicht verfügbar", 404);
  const versions = await tx.query(`select id,version,language,active,created_at as "createdAt",snapshot->>'title' as title from web_expose_versions where workspace_id=$1::uuid and property_id=$2::uuid order by created_at desc limit 100`, [session.workspaceId, propertyId]);
  const links = await tx.query(`select l.id,l.version_id as "versionId",l.label,l.expires_at as "expiresAt",l.revoked_at as "revokedAt",v.active as "versionActive",(l.token_ciphertext is not null) as "canCopy",case when lead.id is not null then c.name end as "intendedRecipient",count(distinct s.id) filter(where e.event_type='open' and s.withdrawn_at is null)::integer as visits from web_expose_links l join web_expose_versions v on v.id=l.version_id and v.workspace_id=l.workspace_id left join leads lead on lead.id=l.intended_lead_id and lead.workspace_id=l.workspace_id left join contacts c on c.id=lead.contact_id and c.workspace_id=lead.workspace_id left join web_expose_sessions s on s.link_id=l.id left join web_expose_events e on e.session_id=s.id where v.workspace_id=$1::uuid and v.property_id=$2::uuid group by l.id,v.active,lead.id,c.name order by l.created_at desc`, [session.workspaceId, propertyId]);
  const sections = await tx.query(`select e.section,count(distinct e.session_id) filter(where e.event_type in ('section','heartbeat'))::integer as visits,coalesce(sum(e.active_ms),0)::bigint::text as "activeMs",count(*) filter(where e.event_type not in ('open','section','heartbeat'))::integer as clicks,max(e.depth) as depth from web_expose_events e join web_expose_sessions s on s.id=e.session_id join web_expose_links l on l.id=s.link_id join web_expose_versions v on v.id=l.version_id where v.workspace_id=$1::uuid and v.property_id=$2::uuid and s.withdrawn_at is null group by e.section`, [session.workspaceId, propertyId]);
  const visits = await tx.query(`select s.id,s.created_at as "startedAt",l.label,case when lead.id is not null then c.name end as "intendedRecipient",coalesce(sum(e.active_ms),0)::bigint::text as "activeMs",count(distinct e.section) filter(where e.event_type in ('section','heartbeat'))::integer as sections,count(*) filter(where e.event_type not in ('open','section','heartbeat'))::integer as clicks from web_expose_sessions s join web_expose_links l on l.id=s.link_id join web_expose_versions v on v.id=l.version_id left join leads lead on lead.id=l.intended_lead_id and lead.workspace_id=l.workspace_id left join contacts c on c.id=lead.contact_id and c.workspace_id=lead.workspace_id left join web_expose_events e on e.session_id=s.id where v.workspace_id=$1::uuid and v.property_id=$2::uuid and s.withdrawn_at is null group by s.id,l.label,lead.id,c.name having count(*) filter(where e.event_type='open')>0 order by s.created_at desc limit 50`, [session.workspaceId, propertyId]);
  const events = await tx.query(`select e.id,e.session_id as "sessionId",e.received_at as "receivedAt",e.event_type as type,e.section,
    case e.target when 'nav-inquiry' then 'Anfrage aus der Navigation' when 'hero-inquiry' then 'Anfrage im Einstieg' when 'email' then 'E-Mail-Kontakt' when 'phone' then 'Telefonkontakt' when 'open-map' then 'Lagekarte' when 'expose-pdf' then 'Exposé als PDF' else coalesce((select (r->>'title')||case split_part(e.target,':',3) when 'load' then ' · Laden' when 'play' then ' · Wiedergabe gestartet' when 'pause' then ' · Pausiert' when 'ended' then ' · Wiedergabe beendet' when 'open' then ' · Beim Anbieter geöffnet' else '' end from jsonb_array_elements(coalesce(v.snapshot->'resources','[]'::jsonb)) r where 'resource:'||(r->>'id')=split_part(e.target,':',1)||':'||split_part(e.target,':',2) limit 1),(select m->>'title' from jsonb_array_elements(v.snapshot->'media') m where m->>'id'=e.target limit 1),(select 'Einheit '||(u->>'number') from jsonb_array_elements(v.snapshot->'units') u where u->>'id'=e.target limit 1),case when e.target is not null then 'Ausgewählter Inhalt' end) end as target,e.active_ms as "activeMs",e.depth from web_expose_events e join web_expose_sessions s on s.id=e.session_id join web_expose_links l on l.id=s.link_id join web_expose_versions v on v.id=l.version_id where v.workspace_id=$1::uuid and v.property_id=$2::uuid and s.withdrawn_at is null and e.event_type<>'heartbeat' order by e.received_at desc limit 300`, [session.workspaceId, propertyId]);
  const drafts = await tx.query(`select language,input,revision,updated_at as "updatedAt" from web_expose_drafts where workspace_id=$1::uuid and property_id=$2::uuid order by updated_at desc`, [session.workspaceId, propertyId]);
  const visitSections = await tx.query(`select e.session_id as "sessionId",e.section,coalesce(sum(e.active_ms),0)::bigint::text as "activeMs",max(e.depth) as depth from web_expose_events e join web_expose_sessions s on s.id=e.session_id join web_expose_links l on l.id=s.link_id join web_expose_versions v on v.id=l.version_id where v.workspace_id=$1::uuid and v.property_id=$2::uuid and s.withdrawn_at is null group by e.session_id,e.section`, [session.workspaceId, propertyId]);
  const summary = await tx.queryOne(`with measured as (select s.id,s.visitor_hash,l.intended_lead_id,sum(e.active_ms) as active_ms,count(distinct e.section) filter(where e.event_type in ('section','heartbeat')) as reached,
    greatest(1,jsonb_array_length(s.offered_sections)) as offered
    from web_expose_sessions s join web_expose_links l on l.id=s.link_id join web_expose_versions v on v.id=l.version_id join web_expose_events e on e.session_id=s.id where v.workspace_id=$1::uuid and v.property_id=$2::uuid and s.withdrawn_at is null group by s.id,l.intended_lead_id,v.snapshot having count(*) filter(where e.event_type='open')>0)
    select count(*)::integer as visits,count(distinct visitor_hash)::integer as browsers,count(distinct intended_lead_id)::integer as "intendedRecipients",round(avg(active_ms))::bigint::text as "averageActiveMs",round(avg(least(100,100.0*reached/offered)))::integer as "averageCoverage" from measured`, [session.workspaceId,propertyId]);
  const grant=await tx.queryOne<{allowed:boolean}>(`select crm_web_expose_access($1::uuid,$2::uuid,true) as allowed`,[session.workspaceId,propertyId]);
  const manager=await tx.queryOne<{allowed:boolean}>(`select crm_workspace_manager($1::uuid) as allowed`,[session.workspaceId]);
  return { versions, links, sections, visits, events, drafts, visitSections, summary, retentionScheduled:webExposeRetentionScheduled(session.workspaceId), canManageAnalytics:manager?.allowed===true, canPublish: canWritePropertyExpose(session) && grant?.allowed===true, definitions: webExposeCopy.de.intended };
}
