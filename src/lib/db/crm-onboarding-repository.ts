import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, CrmCommandError, executeCrmCommand, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { buildCrmExampleScenario, parseCrmOnboardingProgress } from "@/lib/crm-onboarding";
import { createProjectRecord } from "@/lib/db/crm-write-repositories";
import { createSellerListingRecord } from "@/lib/db/property-department-repositories";
import { isPropertyCountryCode, type PropertyCountryCode } from "@/lib/property-country";

type ExampleRecord = { id: string; countryCode: PropertyCountryCode; projectId: string; propertyId: string; leadId: string; taskId: string; createdAt: string; projectName: string };
const exampleSelect = `e.id,e.country_code as "countryCode",e.project_id as "projectId",e.property_id as "propertyId",e.lead_id as "leadId",e.task_id as "taskId",e.created_at::text as "createdAt",p.name as "projectName"`;
export async function loadCrmOnboarding(tx: TenantTransaction, session: AppSession) {
  const progress = await tx.queryOne<{ countryCode: PropertyCountryCode; reviewedSteps: string[]; revision: number }>(`select country_code as "countryCode",reviewed_steps as "reviewedSteps",revision from crm_onboarding_progress where workspace_id=$1::uuid and user_id=$2::uuid`, [session.workspaceId, session.userId]);
  const examples = await tx.query<ExampleRecord>(`select ${exampleSelect} from crm_onboarding_examples e join projects p on p.id=e.project_id and p.workspace_id=e.workspace_id where e.workspace_id=$1::uuid order by e.created_at`, [session.workspaceId]);
  const manager = await tx.queryOne<{ allowed: boolean }>(`select crm_workspace_manager($1::uuid) as allowed`, [session.workspaceId]);
  const features = await tx.queryOne<{ expose: boolean; media: boolean; automations: boolean; portals: boolean; reports: boolean; notifications: boolean }>(`select to_regclass('public.web_expose_versions') is not null as expose,to_regclass('public.web_expose_resources') is not null as media,to_regclass('public.crm_automations') is not null as automations,to_regprocedure('public.crm_property_portal_access(uuid,uuid,uuid,boolean)') is not null as portals,to_regclass('public.project_sales_report_settings') is not null as reports,to_regclass('public.crm_notification_preferences') is not null as notifications`);
  const observed = await tx.queryOne<{ properties: number; units: number; inquiries: number; assigned: number; nextTasks: number }>(`select
   (select count(*)::int from seller_listings where workspace_id=$1::uuid and coalesce(canonical_payload->'onboardingExample'->>'synthetic','false')<>'true') as properties,
   (select count(*)::int from property_units where workspace_id=$1::uuid and coalesce(metadata->>'hidden','false')<>'true' and coalesce(metadata->'onboardingExample'->>'synthetic','false')<>'true') as units,
   (select count(*)::int from leads where workspace_id=$1::uuid and coalesce(metadata->'onboardingExample'->>'synthetic','false')<>'true' and coalesce(metadata->'websiteSales'->>'syntheticTest','false')<>'true') as inquiries,
   (select count(*)::int from leads where workspace_id=$1::uuid and assigned_to_user_id is not null and coalesce(metadata->'onboardingExample'->>'synthetic','false')<>'true' and coalesce(metadata->'websiteSales'->>'syntheticTest','false')<>'true') as assigned,
   (select count(*)::int from tasks where workspace_id=$1::uuid and lead_id is not null and status='open' and due_at is not null and owner_user_id is not null and coalesce(metadata->'onboardingExample'->>'synthetic','false')<>'true') as "nextTasks"`, [session.workspaceId]);
  return { progress: progress ?? { countryCode: "AT" as const, reviewedSteps: [], revision: 0 }, examples, features, observed, canCreateExample: manager?.allowed === true && session.permissions.includes("crm:write") && !session.serviceIdentity };
}
export async function saveCrmOnboardingProgress(tx: TenantTransaction, session: AppSession, value: unknown, expectedRevision: number, requestId: string) {
  assertCrmUuid(requestId); let input;
  try { input = parseCrmOnboardingProgress(value); } catch { throw new CrmCommandError("INVALID_ONBOARDING", "Land und betrachtete Hilfeschritte prüfen"); }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new CrmCommandError("INVALID_REVISION", "Fortschrittsversion fehlt");
  const hash = createHash("sha256").update(JSON.stringify({ input, expectedRevision })).digest("hex");
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`onboarding-progress:${session.workspaceId}:${session.userId}`]);
  const prior = await tx.queryOne<{ revision: number; requestId: string; hash: string }>(`select revision,last_request_id as "requestId",last_request_hash as hash from crm_onboarding_progress where workspace_id=$1::uuid and user_id=$2::uuid for update`, [session.workspaceId, session.userId]);
  if (prior?.requestId === requestId) { if (prior.hash !== hash) throw new CrmCommandError("IDEMPOTENCY_CONFLICT", "Vorgangskennung gehört zu anderen Hilfeschritten", 409); return { ...input, revision: prior.revision, replayed: true }; }
  if ((prior?.revision ?? 0) !== expectedRevision) throw new CrmCommandError("ONBOARDING_CONFLICT", "Hilfefortschritt wurde geändert. Bitte neu laden.", 409);
  const row = await tx.queryOne<{ revision: number }>(`insert into crm_onboarding_progress(workspace_id,user_id,country_code,reviewed_steps,last_request_id,last_request_hash) values($1::uuid,$2::uuid,$3,$4::jsonb,$5::uuid,$6) on conflict(workspace_id,user_id) do update set country_code=excluded.country_code,reviewed_steps=excluded.reviewed_steps,last_request_id=excluded.last_request_id,last_request_hash=excluded.last_request_hash,revision=crm_onboarding_progress.revision+1,updated_at=now() returning revision`, [session.workspaceId, session.userId, input.countryCode, JSON.stringify(input.reviewedSteps), requestId, hash]);
  if (!row) throw new CrmCommandError("SAVE_UNCONFIRMED", "Hilfefortschritt nicht bestätigt", 503); return { ...input, revision: row.revision, replayed: false };
}
export async function createCrmOnboardingExample(session: AppSession, country: unknown, metadata: { idempotencyKey: string; correlationId: string }, options?: TenantTransactionOptions) {
  if (!isPropertyCountryCode(country)) throw new CrmCommandError("INVALID_COUNTRY", "AT, DE, ES oder IE auswählen");
  return executeCrmCommand(session, { ...metadata, operation: "onboarding.create_example", resourceId: session.workspaceId, capability: "workspace:operate", payload: { countryCode: country, templateVersion: 1 } }, async (tx, context) => {
    if (context.session.serviceIdentity || !(await tx.queryOne<{ allowed: boolean }>(`select crm_workspace_manager($1::uuid) as allowed`, [context.workspaceId]))?.allowed) throw new CrmCommandError("FORBIDDEN", "Nur Workspace-Verantwortliche dürfen ein Beispielprojekt anlegen", 403);
    await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`onboarding-example:${context.workspaceId}:${country}:1`]);
    const existing = await tx.queryOne<ExampleRecord>(`select ${exampleSelect} from crm_onboarding_examples e join projects p on p.id=e.project_id and p.workspace_id=e.workspace_id where e.workspace_id=$1::uuid and e.country_code=$2 and e.template_version=1`, [context.workspaceId, country]);
    if (existing) return { ...existing, created: false };
    const id = randomUUID(), sample = buildCrmExampleScenario(country, id), tag = JSON.stringify({ onboardingExample: sample.tag });
    const project = await createProjectRecord({ session: context.session, project: { name: sample.projectName, type: "real_estate_project", status: "Aktiv", setupDefaults: { onboardingExample: sample.tag, calendarProvider: "none" } } });
    if (!project.persisted) throw new CrmCommandError("EXAMPLE_CREATE_FAILED", "Beispielprojekt konnte nicht gespeichert werden", 503);
    const projectId = project.data.id;
    const property = await createSellerListingRecord({ session: context.session, property: { projectId, title: sample.propertyTitle, address: sample.place.address, city: sample.place.city, region: sample.place.region, geography: sample.geography, energyCertificate: sample.energy, objectType: "Wohnung", usageType: "residential", yearBuilt: 2020, areaSqm: 80, rooms: 3, price: 0, priceVisibility: "price_on_request", internalNotes: "Fiktive Beispieldaten. Keine Veröffentlichung, kein Versand. Keine echten Kundendaten in diesem Projekt ergänzen." } });
    if (!property.persisted) throw new CrmCommandError("EXAMPLE_CREATE_FAILED", "Beispielobjekt konnte nicht gespeichert werden", 503);
    const propertyId = property.data.id, contactId = randomUUID(), leadId = randomUUID(), taskId = randomUUID(), unitIds = [randomUUID(), randomUUID()];
    for (const [index, unitId] of unitIds.entries()) await tx.query(`insert into property_units(id,workspace_id,project_id,unit_number,rooms,area_sqm,price_cents,status,metadata) values($1::uuid,$2::uuid,$3::uuid,$4,3,80,0,'available',$5::jsonb)`, [unitId, context.workspaceId, projectId, `EXAMPLE-${country}-${index + 1}`, JSON.stringify({ onboardingExample: sample.tag, sellerListingId: propertyId })]);
    await tx.query(`insert into contacts(id,workspace_id,project_id,owner_user_id,name,role,source,consent_label,email,metadata) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'Käufer','Beispiel','Keine Einwilligung – Beispieldaten',$6,$7::jsonb)`, [contactId, context.workspaceId, projectId, context.actorId, sample.contactName, sample.email, tag]);
    await tx.query(`insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,source,type,status,next_action,region,metadata) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'Beispiel','Käufer','Neu',$6,$7,$8::jsonb)`, [leadId, context.workspaceId, projectId, contactId, context.actorId, sample.taskTitle, sample.place.region, JSON.stringify({ onboardingExample: sample.tag, websiteSales: { syntheticTest: true }, sellerListingId: propertyId, unitId: unitIds[0] })]);
    await tx.query(`insert into tasks(id,workspace_id,project_id,lead_id,contact_id,owner_user_id,title,due_at,status,metadata) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,now()+interval '2 days','open',$8::jsonb)`, [taskId, context.workspaceId, projectId, leadId, contactId, context.actorId, sample.taskTitle, tag]);
    await tx.query(`insert into crm_onboarding_examples(id,workspace_id,country_code,project_id,property_id,contact_id,lead_id,task_id,unit_ids,created_by) values($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::jsonb,$10::uuid)`, [id, context.workspaceId, country, projectId, propertyId, contactId, leadId, taskId, JSON.stringify(unitIds), context.actorId]);
    return { id, countryCode: country, projectId, propertyId, contactId, leadId, taskId, unitIds, created: true };
  }, options);
}
