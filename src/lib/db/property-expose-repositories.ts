import { createHash, randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { queryOne } from "@/lib/db/client";
import { queryPropertyMediaMutation } from "@/lib/db/property-media-mutation";
import { hasProductCapability } from "@/lib/product-model";
import type { PropertyExposeOptions, PropertyExposeSource } from "@/lib/property-expose";

export class PropertyExposeError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); }
}
export const exposeUuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function canWritePropertyExpose(session: AppSession) {
  return session.permissions.includes("crm:write") && (session.role === "owner" || session.role === "admin" ||
    hasProductCapability(session.productRole, "workspace:operate") || hasProductCapability(session.productRole, "pipeline:write") ||
    hasProductCapability(session.productRole, "settings:manage") || hasProductCapability(session.productRole, "workspace:admin"));
}
export type ExposeStoredVersion = {
  id: string; assetId: string; source: PropertyExposeSource; fileName: string; createdAt: string;
  sizeBytes: number; pageCount: number; versionLabel: string; sourceFingerprint: string; sha256: string;
  options?: PropertyExposeOptions;
  sourceMediaHashes?: Record<string, string>;
};
export type ExposeRegistry = { schemaVersion: 1; revision: string; preferredSource: PropertyExposeSource;
  activeDocumentId: string | null; versions: ExposeStoredVersion[] };
export type ExposeSource = { listing: Record<string, unknown>; media: Record<string, unknown>[];
  texts: Record<string, unknown>[]; costs: Record<string, unknown>[]; company: Record<string, unknown> | null };
export type ExposeSnapshot = { propertyId: string; workspaceId: string; projectId: string | null;
  source: ExposeSource; registryRaw: unknown; registry: ExposeRegistry; sourceFingerprint: string };
export function stableExposeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableExposeJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableExposeJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function exposeFingerprint(value: unknown) { return createHash("sha256").update(stableExposeJson(value)).digest("hex"); }
export function readExposeRegistry(raw: unknown): ExposeRegistry {
  if (raw === null || raw === undefined) return { schemaVersion: 1, revision: "initial", preferredSource: "generated", activeDocumentId: null, versions: [] };
  const r = raw as Partial<ExposeRegistry>;
  if (!r || typeof r !== "object" || Array.isArray(r) || r.schemaVersion !== 1 || !exposeUuid(r.revision) ||
      !["generated", "uploaded"].includes(r.preferredSource ?? "") ||
      (r.activeDocumentId !== null && !exposeUuid(r.activeDocumentId)) || !Array.isArray(r.versions) || r.versions.length > 100 ||
      r.versions.some(v => !v || !exposeUuid(v.id) || !exposeUuid(v.assetId) ||
        !["generated", "uploaded"].includes(v.source) || typeof v.fileName !== "string" || !v.fileName.endsWith(".pdf") ||
        typeof v.createdAt !== "string" || !Number.isFinite(Date.parse(v.createdAt)) || !Number.isSafeInteger(v.sizeBytes) || v.sizeBytes <= 0 || v.sizeBytes > 10 * 1024 * 1024 ||
        !Number.isSafeInteger(v.pageCount) || v.pageCount < 1 || typeof v.versionLabel !== "string" ||
        !/^[a-f0-9]{64}$/.test(v.sha256) || !/^[a-f0-9]{64}$/.test(v.sourceFingerprint)) ||
      new Set(r.versions.map(v => v.id)).size !== r.versions.length ||
      (r.activeDocumentId !== null && !r.versions.some(v => v.id === r.activeDocumentId))) {
    throw new PropertyExposeError("EXPOSE_REGISTRY_INVALID", 409, "Exposé state is invalid. No file was selected or changed.");
  }
  return r as ExposeRegistry;
}

// One statement produces a consistent, explicitly allowlisted saved-data snapshot.
// No owner/lead fields, internal notes, market valuation, URLs or export registry.
export const exposeSourceSql = `jsonb_build_object(
  'listing', jsonb_build_object('id',p.id,'projectId',p.project_id,'title',p.title,'address',p.address,
    'city',p.city,'postalCode',p.postal_code,'region',p.region,'objectType',p.object_type,'areaSqm',p.area_sqm,
    'rooms',p.rooms,'yearBuilt',p.year_built,'objectNumber',p.object_number,'marketingType',p.marketing_type,
    'targetPriceCents',p.target_price_cents,'publicPriceCents',p.public_price_cents,'priceVisibility',p.price_visibility,
    'channelPriceVisibility',p.channel_price_visibility,'rentPriceCents',p.rent_price_cents,'rentNetCents',p.rent_net_cents,
    'monthlyCostsGrossCents',p.monthly_costs_gross_cents,'purchaseAncillaryCostsCents',p.purchase_ancillary_costs_cents,
    'purchaseAncillaryCalculation',p.canonical_payload->'purchaseAncillaryCalculation',
    'contactName',p.contact_name,'contactEmail',p.contact_email,'contactPhone',p.contact_phone,
    'availableFrom',p.available_from,'availableFromText',p.available_from_text,
    'energyClass',p.hwb_class,'energyValidUntil',p.energy_certificate_valid_until),
  'media',coalesce((select jsonb_agg(m.item order by m.item->>'id') from (
    select jsonb_build_object('id',pm.id,'assetId',ma.id,'kind',case when pm.media_type='floorplan' or pm.category='floorplan' then 'floorplan' else 'image' end,
      'title',pm.title,'isCover',pm.is_cover,'position',pm.position,'updatedAt',pm.updated_at,'mimeType',ma.mime_type,
      'sizeBytes',ma.size_bytes,'assetCreatedAt',ma.created_at,'relativePath',ma.relative_path) item
    from property_media pm join media_assets ma on ma.id=pm.media_asset_id and ma.workspace_id=p.workspace_id::text
    where pm.property_id=p.id and pm.workspace_id=p.workspace_id and pm.project_id is not distinct from p.project_id
      and pm.unit_id is null and pm.media_type in ('image','floorplan') and pm.visibility in ('private','public','channel')
      and pm.status in ('draft','needs_review','approved','published') and ma.mime_type like 'image/%'
      and ma.storage_access='private' and ma.is_public=false and ma.public_token is null
      and (ma.folder !~* '^properties/' or lower(ma.folder)='properties/'||p.id::text)
      and not exists(select 1 from media_asset_shares s where s.asset_id=ma.id and s.workspace_id=ma.workspace_id and s.revoked_at is null and s.expires_at>now())
    union all
    select jsonb_build_object('id','document:'||pd.id::text,'assetId',ma.id,'kind','floorplan','title',pd.title,'isCover',false,
      'position',0,'updatedAt',pd.updated_at,'mimeType',ma.mime_type,'sizeBytes',ma.size_bytes,'assetCreatedAt',ma.created_at,'relativePath',ma.relative_path) item
    from property_documents pd join media_assets ma on ma.id=pd.media_asset_id and ma.workspace_id=p.workspace_id::text
    where pd.property_id=p.id and pd.workspace_id=p.workspace_id and pd.project_id is not distinct from p.project_id
      and pd.unit_id is null and pd.category='floorplan' and pd.visibility='private' and pd.sent_at is null
      and pd.status in ('draft','needs_review','approved') and ma.mime_type='application/pdf'
      and ma.storage_access='private' and ma.is_public=false and ma.public_token is null
      and (ma.folder !~* '^properties/' or lower(ma.folder)='properties/'||p.id::text)
      and not exists(select 1 from media_asset_shares s where s.asset_id=ma.id and s.workspace_id=ma.workspace_id and s.revoked_at is null and s.expires_at>now())
  ) m),'[]'::jsonb),
  'texts',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'key',t.text_key,'content',t.content,'updatedAt',t.updated_at) order by t.position,t.id)
    from property_text_blocks t where t.workspace_id=p.workspace_id and t.property_id=p.id and t.project_id is not distinct from p.project_id
      and t.unit_id is null and t.text_key='expose' and t.visibility in ('public','channel') and t.status in ('draft','needs_review','approved','published')),'[]'::jsonb),
  'costs',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'label',c.label,'monthlyGrossCents',c.monthly_gross_cents,
    'oneTimeGrossCents',c.one_time_gross_cents,'optional',c.optional,'updatedAt',c.updated_at) order by c.position,c.id)
    from property_cost_items c where c.workspace_id=p.workspace_id and c.property_id=p.id and c.project_id is not distinct from p.project_id
      and c.unit_id is null and c.expose_visible=true),'[]'::jsonb),
  'company',crm_property_expose_company_profile(p.workspace_id)
)`;
const scopedPropertySql = `p.id=$1::uuid and p.workspace_id=$2::uuid and
  (p.project_id is null or exists(select 1 from projects project where project.id=p.project_id and project.workspace_id=p.workspace_id))`;
export async function loadPropertyExposeSnapshot(workspaceId: string, propertyId: string): Promise<ExposeSnapshot> {
  if (!exposeUuid(workspaceId) || !exposeUuid(propertyId)) throw new PropertyExposeError("EXPOSE_INVALID_SCOPE", 400, "Invalid property scope.");
  const row = await queryOne<{ projectId: string | null; source: ExposeSource; registryRaw: unknown }>(
    `select p.project_id as "projectId",p.canonical_payload->'expose' as "registryRaw",${exposeSourceSql} as source
      from seller_listings p where ${scopedPropertySql}`, [propertyId, workspaceId]);
  if (!row) throw new PropertyExposeError("EXPOSE_NOT_FOUND", 404, "Property not found in this workspace.");
  return { propertyId, workspaceId, ...row, registry: readExposeRegistry(row.registryRaw), sourceFingerprint: exposeFingerprint(row.source) };
}
export async function findPropertyExposeVersionAsset(snapshot: ExposeSnapshot, documentId: string) {
  const version = snapshot.registry.versions.find(v => v.id === documentId);
  if (!version) return null;
  const row = await queryOne<{ id: string }>(`select d.media_asset_id as id from property_documents d
    join seller_listings p on p.id=d.property_id and p.workspace_id=d.workspace_id
    join media_assets ma on ma.id=d.media_asset_id and ma.workspace_id=d.workspace_id::text
    where ${scopedPropertySql} and d.id=$3::uuid and d.media_asset_id=$4::uuid and d.project_id is not distinct from p.project_id
      and d.unit_id is null and d.category='novalure_expose' and d.visibility='private' and d.sent_at is null
      and d.status in ('draft','needs_review','approved') and ma.mime_type='application/pdf' and ma.storage_access='private'
      and ma.is_public=false and ma.public_token is null and ma.size_bytes=$5::bigint
      and lower(ma.folder)='properties/'||p.id::text
      and not exists(select 1 from media_asset_shares s where s.asset_id=ma.id and s.workspace_id=ma.workspace_id and s.revoked_at is null and s.expires_at>now())`,
  [snapshot.propertyId, snapshot.workspaceId, version.id, version.assetId, version.sizeBytes]);
  return row ? version : null;
}
export function assertExposeRevision(snapshot: ExposeSnapshot, revision: unknown) {
  if (revision !== snapshot.registry.revision) throw new PropertyExposeError("EXPOSE_CONFLICT", 409, "Exposé changed. Reload before retrying.");
}
export async function persistPropertyExposeChange(input: { snapshot: ExposeSnapshot; session: AppSession;
  expectedRevision: unknown; operation: "version" | "activate" | "deactivate" | "preferences";
  version?: ExposeStoredVersion; documentId?: string; preferredSource?: PropertyExposeSource }) {
  const { snapshot, session } = input;
  if (session.workspaceId !== snapshot.workspaceId || !exposeUuid(session.userId) || !canWritePropertyExpose(session)) {
    throw new PropertyExposeError("EXPOSE_FORBIDDEN", 403, "Property operating rights are required.");
  }
  assertExposeRevision(snapshot, input.expectedRevision);
  if (input.operation === "version" && (!input.version || snapshot.registry.versions.length >= 100)) {
    throw new PropertyExposeError("EXPOSE_VERSION_LIMIT", 409, "No more than 100 Exposé versions can be stored for one property.");
  }
  const selected = input.operation === "version" ? input.version : input.operation === "activate"
    ? snapshot.registry.versions.find(v => v.id === input.documentId) : undefined;
  if (input.operation === "activate" && !selected) throw new PropertyExposeError("EXPOSE_NOT_FOUND", 404, "Exposé version not found.");
  const next: ExposeRegistry = { ...snapshot.registry, revision: randomUUID(),
    versions: input.version ? [...snapshot.registry.versions, input.version] : snapshot.registry.versions,
    activeDocumentId: input.operation === "activate" ? selected!.id : input.operation === "deactivate" ? null : snapshot.registry.activeDocumentId,
    preferredSource: input.operation === "preferences" ? input.preferredSource! : input.version?.source ?? snapshot.registry.preferredSource };
  readExposeRegistry(next);
  const result = await queryPropertyMediaMutation<{ id: string }>({ propertyId: snapshot.propertyId, workspaceId: snapshot.workspaceId,
    query: `with eligible as (select p.* from seller_listings p where ${scopedPropertySql}
      and p.project_id is not distinct from $3::uuid and p.canonical_payload->'expose' is not distinct from $4::jsonb
      and exists(select 1 from workspace_users actor where actor.id=$5::uuid and actor.workspace_id=p.workspace_id)
      and ($6::jsonb is null or ${exposeSourceSql}=$6::jsonb)
      and ($7::uuid is null or exists(select 1 from media_assets ma where ma.id=$7::uuid and ma.workspace_id=p.workspace_id::text
        and ma.mime_type='application/pdf' and ma.size_bytes=$8::bigint and ma.storage_access='private' and ma.is_public=false and ma.public_token is null
        and lower(ma.folder)='properties/'||p.id::text
        and not exists(select 1 from media_asset_shares s where s.asset_id=ma.id and s.workspace_id=ma.workspace_id and s.revoked_at is null and s.expires_at>now())))
      and ($9::text<>'activate' or exists(select 1 from property_documents d where d.id=$10::uuid and d.workspace_id=p.workspace_id
        and d.property_id=p.id and d.project_id is not distinct from p.project_id and d.unit_id is null and d.media_asset_id=$7::uuid
        and d.category='novalure_expose' and d.visibility='private' and d.status in ('draft','needs_review','approved') and d.sent_at is null))
    ), created as (insert into property_documents(id,workspace_id,project_id,property_id,media_asset_id,title,category,status,visibility,version_label,content,metadata)
      select $10::uuid,workspace_id,project_id,id,$7::uuid,$11,'novalure_expose','needs_review','private',$12,'{}'::jsonb,$13::jsonb
      from eligible where $9::text='version' returning id
    ), changed as (update seller_listings p set canonical_payload=jsonb_set(coalesce(p.canonical_payload,'{}'::jsonb),'{expose}',$14::jsonb,true)
      where p.id=$1::uuid and p.workspace_id=$2::uuid and exists(select 1 from eligible)
        and ($9::text<>'version' or exists(select 1 from created)) returning p.id,p.workspace_id,p.project_id
    ), activity as (insert into property_activity_events(workspace_id,project_id,property_id,actor_user_id,event_type,title,detail,metadata)
      select workspace_id,project_id,id,$5::uuid,'property.expose.'||$9::text,'Exposé','Private Exposé state changed',
        jsonb_build_object('documentId',$10::text,'revision',$15::text,'private',true) from changed returning id)
    select id from changed where exists(select 1 from activity)`,
    params: [snapshot.propertyId,snapshot.workspaceId,snapshot.projectId,snapshot.registryRaw == null ? null : JSON.stringify(snapshot.registryRaw),session.userId,
      input.operation === "version" ? JSON.stringify(snapshot.source) : null,selected?.assetId ?? null,selected?.sizeBytes ?? null,input.operation,
      selected?.id ?? null,selected?.fileName ?? "",selected?.versionLabel ?? "",JSON.stringify({ expose: selected ?? null }),JSON.stringify(next),next.revision],
  });
  if (!result) throw new PropertyExposeError("EXPOSE_CONFLICT", 409, "Property, file or Exposé state changed. Nothing was activated; reload before retrying.");
  return next;
}
