import "server-only";
import { createHash } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, type TenantTransaction } from "@/lib/crm-command";
import { canWritePropertyExpose } from "./property-expose-repositories";
import { countryPublicationChecks, normalizePropertyEnergyCertificate, readPropertyGeography } from "@/lib/property-country";
import { buildPropertyPortalXml, openImmoReference, openImmoSchemaRelease, parsePropertyPortalProfile, type PropertyPortalPreview, type PropertyPortalProfile, type PropertyPortalSource } from "@/lib/property-portal";
import { createPropertyPortalZip } from "@/lib/property-portal-package";
import { parsePropertyIntegerCents } from "@/lib/property-money";
import { findWorkspaceMediaAsset, readMediaAssetContent } from "@/lib/media-store";

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export { privateHeaders as propertyPortalHeaders };
async function propertyScope(tx: TenantTransaction, session: AppSession, propertyId: string, write: boolean) {
  assertCrmUuid(propertyId);
  const p = await tx.queryOne<{ projectId: string | null }>(`select project_id as "projectId" from seller_listings where id=$1::uuid and workspace_id=$2::uuid${write ? " for update" : ""}`, [propertyId, session.workspaceId]);
  if (!p) throw new CrmCommandError("NOT_FOUND", "Immobilie nicht verfügbar", 404);
  if (p.projectId) await assertProjectGrant(tx, session, p.projectId, write);
  if (write && !canWritePropertyExpose(session)) throw new CrmCommandError("FORBIDDEN", "Immobilien-Schreibrechte fehlen", 403);
  return p;
}
export async function savePropertyPortalProfile(tx: TenantTransaction, session: AppSession, propertyId: string, value: unknown, expectedRevision: number) {
  const p = await propertyScope(tx, session, propertyId, true);
  let profile: PropertyPortalProfile;
  try { profile = parsePropertyPortalProfile(value); } catch { throw new CrmCommandError("INVALID_PROFILE", "Anbieter-, Objekt- und Portalkennungen prüfen"); }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new CrmCommandError("INVALID_REVISION", "Profilversion fehlt");
  const existing = await tx.queryOne<{ id: string; metadata: Record<string, unknown> }>(`select id,metadata from property_channels where workspace_id=$1::uuid and property_id=$2::uuid and channel_name=$3 and metadata->>'kind'='openimmo_offline_profile' for update`, [session.workspaceId, propertyId, profile.portalName]);
  const revision = existing ? Number(existing.metadata.revision) : 0;
  if (revision !== expectedRevision) throw new CrmCommandError("PROFILE_CONFLICT", "Portalprofil wurde geändert. Bitte neu laden.", 409);
  const metadata = { kind: "openimmo_offline_profile", revision: revision + 1, profile, transport: "not_connected", updatedBy: session.userId };
  if (existing) await tx.query(`update property_channels set metadata=$2::jsonb,status='ready',updated_at=now() where id=$1::uuid`, [existing.id, JSON.stringify(metadata)]);
  else await tx.query(`insert into property_channels(workspace_id,project_id,property_id,channel_type,channel_name,status,metadata) values($1::uuid,$2::uuid,$3::uuid,'OpenImmo Export',$4,'ready',$5::jsonb)`, [session.workspaceId, p.projectId, propertyId, profile.portalName, JSON.stringify(metadata)]);
  return { profile, revision: revision + 1, transport: "not_connected" as const };
}
export async function loadPropertyPortalState(tx: TenantTransaction, session: AppSession, propertyId: string) {
  const scoped = await propertyScope(tx, session, propertyId, false);
  const write = await tx.queryOne<{ allowed: boolean }>(`select crm_project_access($1::uuid,$2::uuid,true) as allowed`, [session.workspaceId, scoped.projectId]);
  const profiles = await tx.query<{ id: string; metadata: { profile: PropertyPortalProfile; revision: number } }>(`select id,metadata from property_channels where workspace_id=$1::uuid and property_id=$2::uuid and metadata->>'kind'='openimmo_offline_profile' order by channel_name`, [session.workspaceId, propertyId]);
  const jobs = await tx.query(`select id,portal,status,preflight_status as "preflightStatus",created_at as "createdAt",metadata->>'action' as action,metadata->>'sourceFingerprint' as "sourceFingerprint",metadata->>'downloadedAt' as "downloadedAt",metadata->'checks' as checks from property_export_jobs where workspace_id=$1::uuid and property_id=$2::uuid and metadata->>'kind'='openimmo_offline_export' order by created_at desc limit 50`, [session.workspaceId, propertyId]);
  return { profiles: profiles.map((row) => ({ id: row.id, ...row.metadata })), jobs, transport: "not_connected", canPrepare: canWritePropertyExpose(session) && write?.allowed === true, schemaRelease: openImmoSchemaRelease, reference: openImmoReference };
}
export async function previewPropertyPortal(tx: TenantTransaction, session: AppSession, propertyId: string, portalName: string, action: "CHANGE" | "DELETE"): Promise<PropertyPortalPreview> {
  const scoped = await propertyScope(tx, session, propertyId, false);
  if (!["CHANGE", "DELETE"].includes(action)) throw new CrmCommandError("INVALID_ACTION", "Exportaktion ungültig");
  const saved = await tx.queryOne<{ metadata: { profile: unknown; revision: number } }>(`select metadata from property_channels where workspace_id=$1::uuid and property_id=$2::uuid and channel_name=$3 and metadata->>'kind'='openimmo_offline_profile'`, [session.workspaceId, propertyId, portalName]);
  if (!saved) throw new CrmCommandError("PROFILE_REQUIRED", "Zuerst ein Portalprofil speichern");
  const profile = parsePropertyPortalProfile(saved.metadata.profile);
  const p = await tx.queryOne<{ title: string; address: string; city: string; postalCode: string; street: string; areaSqm: number; rooms: number | null; yearBuilt: number | null; marketingType: string; usageType: string; priceCents: string | null; rentPrice: string | null; priceVisibility: string; channelVisibility: Record<string, unknown>; canonical: Record<string, unknown>; region: string; updatedAt: string }>(`select title,address,city,postal_code as "postalCode",street,area_sqm::float as "areaSqm",rooms::float,year_built as "yearBuilt",marketing_type as "marketingType",usage_type as "usageType",coalesce(public_price_cents,target_price_cents)::text as "priceCents",rent_price_cents::text as "rentPrice",price_visibility as "priceVisibility",channel_price_visibility as "channelVisibility",canonical_payload as canonical,region,updated_at::text as "updatedAt" from seller_listings where id=$1::uuid and workspace_id=$2::uuid`, [propertyId, session.workspaceId]);
  if (!p) throw new CrmCommandError("NOT_FOUND", "Immobilie nicht verfügbar", 404);
  const geography = readPropertyGeography({ canonicalPayload: p.canonical, region: p.region });
  if (!geography) throw new CrmCommandError("COUNTRY_REQUIRED", "Objektland zuerst festlegen");
  const energy = normalizePropertyEnergyCertificate(p.canonical?.energyCertificate) ?? {};
  const texts = await tx.query<{ content: string }>(`select content from property_text_blocks where workspace_id=$1::uuid and property_id=$2::uuid and project_id is not distinct from $3::uuid and unit_id is null and text_key in ('portal','expose') and status in ('approved','published') and visibility in ('public','channel') and coalesce(metadata->>'language',$4)=$4 order by case when text_key='portal' then 0 else 1 end,position,id limit 1`, [session.workspaceId, propertyId, scoped.projectId, geography.contentLanguage]);
  const media = profile.includeMedia && action !== "DELETE" ? await tx.query<PropertyPortalSource["media"][number]>(`select pm.id::text,pm.media_asset_id::text as "assetId",pm.title,case when pm.media_type='floorplan' then 'floorplan' else 'image' end as kind,case a.mime_type when 'image/jpeg' then 'JPEG' when 'image/png' then 'PNG' else 'WEBP' end as format,('media-'||pm.id::text||case a.mime_type when 'image/jpeg' then '.jpg' when 'image/png' then '.png' else '.webp' end) as "fileName",a.size_bytes::integer as "sizeBytes",pm.updated_at::text as "updatedAt" from property_media pm join media_assets a on a.id=pm.media_asset_id and a.workspace_id=pm.workspace_id::text where pm.workspace_id=$1::uuid and pm.property_id=$2::uuid and pm.project_id is not distinct from $3::uuid and pm.unit_id is null and pm.status in ('approved','published') and pm.visibility in ('public','channel') and a.storage_access='private' and not a.is_public and a.mime_type in ('image/jpeg','image/png','image/webp') and crm_property_portal_media_allowed($1::uuid,$2::uuid,a.id) order by pm.is_cover desc,pm.position,pm.id limit 20`, [session.workspaceId, propertyId, scoped.projectId]) : [];
  const selectedVisibility = p.channelVisibility?.[portalName] ?? p.channelVisibility?.["Immobilienportal"] ?? p.channelVisibility?.["OpenImmo Export"] ?? p.priceVisibility;
  const visibility = ["publish_price", "price_on_request", "hide_price"].includes(String(selectedVisibility)) ? String(selectedVisibility) : "hide_price";
  const fieldValues = p.canonical?.fieldValues && typeof p.canonical.fieldValues === "object" ? p.canonical.fieldValues as Record<string, unknown> : {};
  const source: PropertyPortalSource = { propertyId, projectId: scoped.projectId, title: p.title, fullAddress: p.address, city: text(p.city), postalCode: text(p.postalCode), street: text(p.street), houseNumber: text(fieldValues["location.hausnummer"]), description: texts[0]?.content ?? "", areaSqm: Number(p.areaSqm), rooms: p.rooms, yearBuilt: p.yearBuilt, marketingType: p.marketingType, usageType: p.usageType, priceCents: parsePropertyIntegerCents(p.marketingType === "rent" ? p.rentPrice : p.priceCents), priceVisibility: visibility, geography, energy, updatedAt: p.updatedAt, media };
  const checks = action === "DELETE" ? [] : countryPublicationChecks({ geography, energy, usageType: p.usageType, yearBuilt: p.yearBuilt ?? undefined });
  const add = (id: string, valid: boolean, message: string) => checks.push({ id, ruleVersion: openImmoSchemaRelease, status: valid ? "ready" : "missing", message, source: openImmoReference });
  if (action !== "DELETE") {
    add("PORTAL-TEXT", Boolean(source.title && source.description), "Freigegebenen Portal-/Exposétext für die gespeicherte Inhaltssprache erfassen.");
    add("PORTAL-LOCATION", Boolean(source.city || source.postalCode), "Mindestens strukturierten Ort oder Postleitzahl speichern.");
    add("PORTAL-AREA", Number.isFinite(source.areaSqm) && source.areaSqm >= 0, "Gültige Fläche speichern.");
    add("PORTAL-MARKETING", ["sale", "rent"].includes(source.marketingType), "Kauf oder Miete getrennt exportieren; kombinierte Vermarktung benötigt ein eigenes Mapping.");
    add("PORTAL-PRICE", visibility !== "publish_price" || source.priceCents !== null, "Freigegebenen Kauf-/Mietpreis speichern oder Preis ausdrücklich ausblenden.");
    add("PORTAL-MEDIA-SIZE", media.every((m) => m.sizeBytes > 0 && m.sizeBytes <= 10 * 1024 * 1024) && media.reduce((sum, m) => sum + m.sizeBytes, 0) <= 20 * 1024 * 1024, "Bilderpaket auf insgesamt 20 MB begrenzen.");
  }
  checks.push({ id: "PORTAL-ADAPTER", ruleVersion: openImmoSchemaRelease, status: "review", message: "Kein geprüfter Portaltransport verbunden. Dateipaket, Kennungen, Pflichtfelder und Empfängerprofil vor manueller Übergabe prüfen.", source: openImmoReference });
  const sourceFingerprint = hash(JSON.stringify({ source, profile, revision: saved.metadata.revision, action }));
  return { source, profile, revision: saved.metadata.revision, action, sourceFingerprint, checks, xml: buildPropertyPortalXml(source, profile, action, new Date().toISOString()), transport: "not_connected" };
}
async function readPortalMedia(workspaceId: string, assetId: string) {
  const asset = await findWorkspaceMediaAsset(assetId, workspaceId);
  if (!asset || asset.storageAccess !== "private" || asset.isPublic || asset.hasActivePublicShare || asset.publicToken || asset.sizeBytes > 10 * 1024 * 1024) throw new CrmCommandError("MEDIA_UNAVAILABLE", "Ein freigegebenes Bild ist nicht mehr verfügbar", 409);
  const content = await readMediaAssetContent(asset);
  if (!content) throw new CrmCommandError("MEDIA_UNAVAILABLE", "Bilddatei konnte nicht gelesen werden", 409);
  if (content.body instanceof Uint8Array) { if (content.body.byteLength !== asset.sizeBytes) throw new CrmCommandError("MEDIA_CHANGED", "Bilddatei wurde geändert", 409); return content.body; }
  const reader = content.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new CrmCommandError("MEDIA_TIMEOUT", "Bilddatei konnte nicht rechtzeitig gelesen werden", 503)), 15000); });
  try { while (true) { const item = await Promise.race([reader.read(), deadline]); if (item.done) break; bytes += item.value.byteLength; if (bytes > 10 * 1024 * 1024) throw new Error("MEDIA_TOO_LARGE"); chunks.push(item.value); } }
  catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  finally { clearTimeout(timer!); reader.releaseLock(); }
  if (bytes !== asset.sizeBytes) throw new CrmCommandError("MEDIA_CHANGED", "Bilddatei wurde geändert", 409);
  return Buffer.concat(chunks);
}
export async function preparePropertyPortalExport(tx: TenantTransaction, session: AppSession, input: { propertyId: string; portalName: string; action: "CHANGE" | "DELETE"; expectedSourceFingerprint: string; reviewed: boolean; idempotencyKey: string }) {
  const scoped = await propertyScope(tx, session, input.propertyId, true);
  const example = await tx.queryOne<{ blocked: boolean }>(`select canonical_payload->'onboardingExample'->>'synthetic'='true' as blocked from seller_listings where id=$1::uuid and workspace_id=$2::uuid`, [input.propertyId, session.workspaceId]);
  if (example?.blocked) throw new CrmCommandError("EXAMPLE_EXPORT_BLOCKED", "Beispielobjekte können nicht für ein Immobilienportal exportiert werden", 409);
  const preview = await previewPropertyPortal(tx, session, input.propertyId, input.portalName, input.action);
  if (!input.reviewed || preview.checks.some((check) => check.status === "missing")) throw new CrmCommandError("PORTAL_REVIEW", "Fehlende Angaben ergänzen und Vorschau ausdrücklich prüfen", 409);
  if (preview.sourceFingerprint !== input.expectedSourceFingerprint) throw new CrmCommandError("PREVIEW_CHANGED", "Objekt oder Portalprofil geändert. Vorschau erneut prüfen.", 409);
  assertCrmUuid(input.idempotencyKey);
  const files = [];
  for (const media of preview.source.media) { const bytes = await readPortalMedia(session.workspaceId, media.assetId); files.push({ ...media, sha256: hash(bytes) }); }
  const metadata = { kind: "openimmo_offline_export", action: input.action, transport: "not_connected", schemaRelease: openImmoSchemaRelease, sourceFingerprint: preview.sourceFingerprint, checks: preview.checks, xml: preview.xml, xmlSha256: hash(preview.xml), files, reviewedBy: session.userId, reviewedAt: new Date().toISOString() };
  const job = await tx.queryOne<{ id: string; status: string }>(`insert into property_export_jobs(workspace_id,project_id,property_id,portal,export_format,status,preflight_status,started_by_user_id,metadata,idempotency_key,finished_at) values($1::uuid,$2::uuid,$3::uuid,$4,'openimmo_1_2_7d','prepared','reviewed',$5::uuid,$6::jsonb,$7,now()) on conflict(workspace_id,idempotency_key) do update set updated_at=property_export_jobs.updated_at where property_export_jobs.property_id=$3::uuid and property_export_jobs.metadata->>'sourceFingerprint'=$6::jsonb->>'sourceFingerprint' returning id,status`, [session.workspaceId, scoped.projectId, input.propertyId, input.portalName, session.userId, JSON.stringify(metadata), `portal-package:${input.idempotencyKey}`]);
  if (!job) throw new CrmCommandError("IDEMPOTENCY_CONFLICT", "Diese Vorgangskennung gehört zu einem anderen Dateipaket", 409);
  return { ...job, transport: "not_connected" as const };
}
export async function downloadPropertyPortalExport(tx: TenantTransaction, session: AppSession, propertyId: string, jobId: string) {
  await propertyScope(tx, session, propertyId, false); assertCrmUuid(jobId);
  const job = await tx.queryOne<{ portal: string; createdAt: string; metadata: { kind: string; action: string; xml: string; xmlSha256: string; sourceFingerprint: string; files: (PropertyPortalSource["media"][number] & { sha256: string })[]; checks: unknown } }>(`select portal,created_at::text as "createdAt",metadata from property_export_jobs where id=$1::uuid and property_id=$2::uuid and workspace_id=$3::uuid and status='prepared' and metadata->>'kind'='openimmo_offline_export'`, [jobId, propertyId, session.workspaceId]);
  if (!job || hash(job.metadata.xml) !== job.metadata.xmlSha256) throw new CrmCommandError("NOT_FOUND", "Dateipaket nicht verfügbar", 404);
  const example = await tx.queryOne<{ blocked: boolean }>(`select canonical_payload->'onboardingExample'->>'synthetic'='true' as blocked from seller_listings where id=$1::uuid and workspace_id=$2::uuid`, [propertyId, session.workspaceId]);
  if (example?.blocked) throw new CrmCommandError("EXAMPLE_EXPORT_BLOCKED", "Beispielobjekte können nicht für ein Immobilienportal exportiert werden", 409);
  if (job.metadata.action !== "CHANGE" && job.metadata.action !== "DELETE") throw new CrmCommandError("NOT_FOUND", "Dateipaket nicht verfügbar", 404);
  const current = await previewPropertyPortal(tx, session, propertyId, job.portal, job.metadata.action);
  const entries: Record<string, string | Uint8Array> = { "openimmo.xml": job.metadata.xml };
  for (const file of job.metadata.files) {
    const active = await tx.queryOne(`select id from property_media where id=$1::uuid and media_asset_id=$2::uuid and workspace_id=$3::uuid and property_id=$4::uuid and status in ('approved','published') and visibility in ('public','channel')`, [file.id, file.assetId, session.workspaceId, propertyId]);
    if (!active) throw new CrmCommandError("MEDIA_REVOKED", "Bildfreigabe geändert. Neues Exportpaket prüfen.", 409);
    const allowed = await tx.queryOne<{ allowed: boolean }>(`select crm_property_portal_media_allowed($1::uuid,$2::uuid,$3::uuid) as allowed`, [session.workspaceId, propertyId, file.assetId]);
    if (!allowed?.allowed) throw new CrmCommandError("MEDIA_REVOKED", "Bild ist inzwischen vertraulich oder nicht mehr für dieses Objekt freigegeben", 409);
    const bytes = await readPortalMedia(session.workspaceId, file.assetId);
    if (hash(bytes) !== file.sha256) throw new CrmCommandError("MEDIA_CHANGED", "Bildinhalt geändert. Neues Exportpaket prüfen.", 409);
    entries[file.fileName] = bytes;
  }
  if (current.sourceFingerprint !== job.metadata.sourceFingerprint || current.checks.some((check) => check.status === "missing")) throw new CrmCommandError("PREVIEW_CHANGED", "Objekt-, Preis-, Adress- oder Portalfreigabe geändert. Neues Exportpaket ausdrücklich prüfen.", 409);
  entries["manifest.json"] = JSON.stringify({ format: `OpenImmo ${openImmoSchemaRelease}`, action: job.metadata.action, portal: job.portal, preparedAt: job.createdAt, delivery: "not_transferred", specification: openImmoReference, xmlSha256: job.metadata.xmlSha256, files: job.metadata.files.map((file) => ({ name: file.fileName, sha256: file.sha256 })), checks: job.metadata.checks }, null, 2);
  return createPropertyPortalZip(entries);
}
