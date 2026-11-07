import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "../src/lib/crm-command";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { evaluateLeadPropertyMatch, type LeadMatchProfile, type LeadMatchProperty } from "../src/lib/lead-qualification-matching";

let db: Awaited<ReturnType<typeof startLocalSalesDb>>, options: TenantTransactionOptions, root: string;
let repository: typeof import("../src/lib/lead-qualification-repository"), media: typeof import("../src/lib/media-store"), automation: typeof import("../src/lib/automation/repository");
const keys = ["NOVALURE_MEDIA_ROOT", "NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN", "BLOB_PRIVATE_READ_WRITE_TOKEN", "NOVALURE_PUBLIC_BLOB_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN", "VERCEL", "VERCEL_ENV", "VERCEL_URL"];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const workspaceId = randomUUID(), projectId = randomUUID(), actorId = randomUUID(), limitedId = randomUUID(), contactId = randomUUID(), leadId = randomUUID(), propertyId = randomUUID();
const session: AppSession = { authenticated: true, source: "headers", workspaceId, userId: actorId, workspaceName: "Synthetic proof QA", name: "Synthetic Owner", email: "proof@qa.invalid", role: "owner", productRole: "customer_owner", permissions: ["crm:read", "crm:write"], productPermissions: ["pipeline:write"] };
const limited: AppSession = { ...session, userId: limitedId, role: "agent", productRole: "project_sales_member" };
const meta = () => ({ idempotencyKey: randomUUID(), correlationId: randomUUID() });
const command = <T>(callback: (tx: TenantTransaction, fresh: AppSession) => Promise<T>) => executeCrmCommand(session, { operation: "lead_qualification.qa", projectId, capability: "pipeline:write", payload: {}, ...meta() }, (tx, context) => callback(tx, context.session), options);
const criteria: LeadMatchProfile = { countryCode: "AT", location: "Wien", propertyType: "Wohnung", budgetFromCents: 20000000, budgetToCents: 40000000, areaSqm: 50, rooms: 2, useCase: "Eigennutzung" };
const property: LeadMatchProperty = { id: propertyId, title: "Synthetic apartment", countryCode: "AT", region: "Wien", city: "Wien", propertyType: "Wohnung", priceCents: 30000000, areaSqm: 70, rooms: 3, marketingType: "sale", usageType: "residential", available: true };
const pdf = () => new File(["%PDF-1.7\nSYNTHETIC PRIVATE FUNDING EVIDENCE\n%%EOF"], "synthetic-proof.pdf", { type: "application/pdf" });
let proofId: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "lead-qualification-")); for (const key of keys) delete process.env[key]; process.env.NOVALURE_MEDIA_ROOT = root;
  repository = await import("../src/lib/lead-qualification-repository"); media = await import("../src/lib/media-store"); automation = await import("../src/lib/automation/repository");
  db = await startLocalSalesDb(); await applySalesSchema(db, { maxMigrationNumber: 106 });
  await db.admin.query(await readFile("migrations/154_automation_graph.sql", "utf8")); await db.admin.query(await readFile("migrations/159_lead_qualification.sql", "utf8"));
  options = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'Synthetic proof QA','managed_by_novalure')", [workspaceId]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$3,'Owner','proof@qa.invalid','owner','customer_owner','active'),($2,$3,'Limited','proof-limited@qa.invalid','agent','project_sales_member','active')", [actorId, limitedId, workspaceId]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'Synthetic project','Makler')", [projectId, workspaceId]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [workspaceId, projectId, limitedId]);
  await db.admin.query("insert into contacts(id,workspace_id,project_id,name,role,email) values($1,$2,$3,'Synthetic Buyer','Käufer','buyer-proof@qa.invalid')", [contactId, workspaceId, projectId]);
  await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type,intent,buyer_profile) values($1,$2,$3,$4,$5,'Käufer','Synthetic private inquiry','{\"useCase\":\"Eigennutzung\"}')", [leadId, workspaceId, projectId, contactId, actorId]);
  await db.admin.query("insert into seller_listings(id,workspace_id,project_id,title,address,region,city,object_type,area_sqm,rooms,target_price_cents) values($1,$2,$3,'Synthetic apartment','Synthetic address','Wien','Wien','Wohnung',70,3,30000000)", [propertyId, workspaceId, projectId]);
});
after(async () => {
  if (db) await db.stop();
  if (root && path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "lead-qualification-")) await rm(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
test("property-fit score is explainable and requires matching known core criteria", () => {
  const fit = evaluateLeadPropertyMatch(criteria, property); assert.equal(fit.score, 100); assert.equal(fit.coverage, 100); assert.equal(fit.eligible, true);
  assert.equal(evaluateLeadPropertyMatch({ ...criteria, countryCode: "" }, property).eligible, false);
  assert.equal(evaluateLeadPropertyMatch(criteria, { ...property, priceCents: null }).eligible, false);
  assert.equal(evaluateLeadPropertyMatch(criteria, { ...property, marketingType: "rent" }).eligible, false);
  assert.equal(evaluateLeadPropertyMatch(criteria, { ...property, available: false }).eligible, false);
  assert.equal(evaluateLeadPropertyMatch({ ...criteria, location: "Madrid" }, property).eligible, false);
  assert.equal(evaluateLeadPropertyMatch({ ...criteria, manualCriteria: ["Stufenloser Zugang"] }, property).eligible, false);
});
test("saved criteria and real property comparison persist reasons and emit one genuine high-match transition", async () => {
  await command((tx, fresh) => repository.saveLeadMatchingProfile(tx, fresh, leadId, criteria));
  const first = await command((tx, fresh) => repository.computeLeadPropertyMatches(tx, fresh, leadId)); assert.equal(first.data.newMatches, 1);
  const repeat = await command((tx, fresh) => repository.computeLeadPropertyMatches(tx, fresh, leadId)); assert.equal(repeat.data.updated, 0); assert.equal(repeat.data.newMatches, 0);
  const state = await repository.getLeadQualification(session, leadId, options); assert.equal(state.matches[0].score, 100); assert.equal(state.matches[0].fresh, true); assert.ok(state.matches[0].reasons.length >= 6);
  assert.equal((await db.admin.query("select id from crm_automation_events where lead_id=$1 and trigger_key='new_match'", [leadId])).rowCount, 1);
});
test("source mutation queues rescore; stale matching is shown and a lost/regained fit has one new transition", async () => {
  await command(async (tx) => { await tx.execute("update seller_listings set target_price_cents=60000000,updated_at=clock_timestamp() where workspace_id=$1 and id=$2", [workspaceId, propertyId]); return { changed: true }; });
  const stale = await repository.getLeadQualification(session, leadId, options); assert.equal(stale.refreshPending, true); assert.equal(stale.matches[0].fresh, false);
  await command((tx, fresh) => repository.processLeadMatchRefreshJobs(tx, fresh, projectId));
  assert.equal((await repository.getLeadQualification(session, leadId, options)).matches[0].eligible, false);
  await command(async (tx) => { await tx.execute("update seller_listings set target_price_cents=30000000,updated_at=clock_timestamp() where workspace_id=$1 and id=$2", [workspaceId, propertyId]); return { changed: true }; });
  await command((tx, fresh) => repository.processLeadMatchRefreshJobs(tx, fresh, projectId));
  assert.equal((await db.admin.query("select id from crm_automation_events where lead_id=$1 and trigger_key='new_match'", [leadId])).rowCount, 2);
  assert.equal((await db.admin.query("select match_version from lead_property_match_history where lead_id=$1", [leadId])).rowCount,3);
});
test("actual private proof upload persists once and cannot leak through ordinary media paths", async () => {
  const metadata = meta(), input = { leadId, kind: "financing_confirmation" as const, purpose: "Synthetic funding confirmation for this specific purchase inquiry", usableDays: 30, file: pdf() };
  const first = await repository.uploadLeadQualificationProof(session, input, metadata, options), second = await repository.uploadLeadQualificationProof(session, input, metadata, options);
  proofId = first.data.id; assert.equal(proofId, second.data.id); assert.equal(second.replayed, true);
  const row = (await db.admin.query("select media_asset_id from lead_qualification_proofs where id=$1", [proofId])).rows[0];
  await withCrmRead(session, async () => {
    assert.equal(await media.findWorkspaceMediaAsset(row.media_asset_id, workspaceId), null);
    assert.equal(await media.authorizedKnowledgeMediaAsset(row.media_asset_id, workspaceId), null);
    assert.equal(await media.publishWorkspaceMedia(row.media_asset_id, workspaceId), null);
    assert.ok(!(await media.listWorkspaceMedia(workspaceId)).assets.some((asset) => asset.id === row.media_asset_id));
  }, options);
  const asset = await repository.getLeadProofAsset(session, proofId, options); assert.ok(asset);
  const content = await media.readMediaAssetContent(asset!); assert.ok(content); assert.match(Buffer.from(content!.body as Uint8Array).toString("utf8"), /SYNTHETIC PRIVATE/);
  assert.equal((await db.admin.query("select id from crm_automation_events where event_key=$1", [`proof-uploaded:${proofId}`])).rowCount, 1);
});
test("project access alone does not expose another assignee's financial proof", async () => {
  await assert.rejects(repository.getLeadQualification(limited, leadId, options), /Interessentenakte/);
  await assert.rejects(repository.getLeadProofAsset(limited, proofId, options), /nicht verfügbar/);
  assert.equal((await db.pool.query("select id from lead_qualification_proofs")).rowCount, 0);
});
test("manual proof review is versioned, auditable and does not pretend a new upload", async () => {
  await command((tx, fresh) => repository.reviewLeadQualificationProof(tx, fresh, { leadId, proofId, expectedVersion: 1, status: "accepted", reason: "Synthetic manual document review completed" }));
  const state = await repository.getLeadQualification(session, leadId, options); assert.equal(state.proofs[0].status, "accepted"); assert.equal(state.proofs[0].version, 2);
  assert.equal((await db.admin.query("select id from lead_qualification_proof_reviews where proof_id=$1", [proofId])).rowCount, 1);
  assert.equal((await db.admin.query("select id from crm_automation_events where lead_id=$1 and trigger_key='proof_uploaded'", [leadId])).rowCount, 1);
  assert.equal((await db.admin.query("select context->>'proofAccepted' as accepted from crm_automation_events where event_key=$1", [`proof-reviewed:${proofId}:2`])).rows[0].accepted, "true");
  await assert.rejects(command((tx, fresh) => repository.reviewLeadQualificationProof(tx, fresh, { leadId, proofId, expectedVersion: 1, status: "rejected", reason: "Synthetic stale attempt must fail" })), /geändert/);
});
test("revocation blocks the dedicated download and cannot be reversed", async () => {
  await command((tx, fresh) => repository.reviewLeadQualificationProof(tx, fresh, { leadId, proofId, expectedVersion: 2, status: "revoked", reason: "Synthetic purpose completed; revoke access" }));
  await assert.rejects(repository.getLeadProofAsset(session, proofId, options), /nicht verfügbar/);
  await assert.rejects(command((tx, fresh) => repository.reviewLeadQualificationProof(tx, fresh, { leadId, proofId, expectedVersion: 3, status: "accepted", reason: "Synthetic forbidden reactivation" })), /bearbeitbar/);
});
test("real proof upload and automatic property rescore actually enroll their respective flows", async () => {
  const {createAutomationGraph}=await import('../src/lib/automation/graph');
  const activate=async(trigger:'new_match'|'proof_uploaded')=>{
    const graph=createAutomationGraph();graph.trigger=trigger;graph.businessHours=false;
    const saved=await command((tx,fresh)=>automation.saveAutomation(tx,fresh,{projectId,name:`Synthetic ${trigger}`,graph}));
    await command((tx,fresh)=>automation.setAutomationStatus(tx,fresh,{id:saved.data.id,expectedRevision:1,active:true}));return saved.data.id;
  };
  const matchFlow=await activate('new_match'),proofFlow=await activate('proof_uploaded');
  await command(async(tx)=>{await tx.execute("update seller_listings set target_price_cents=60000000,updated_at=clock_timestamp() where workspace_id=$1 and id=$2",[workspaceId,propertyId]);return{changed:true};});
  await command((tx,fresh)=>automation.runAutomationDue(tx,fresh,projectId,20,matchFlow));
  await command(async(tx)=>{await tx.execute("update seller_listings set target_price_cents=30000000,updated_at=clock_timestamp() where workspace_id=$1 and id=$2",[workspaceId,propertyId]);return{changed:true};});
  await command((tx,fresh)=>automation.runAutomationDue(tx,fresh,projectId,20,matchFlow));
  await repository.uploadLeadQualificationProof(session,{leadId,kind:'other',purpose:'Synthetic required replacement evidence',usableDays:30,file:new File(['%PDF-1.7\nSYNTHETIC REPLACEMENT\n%%EOF'],'synthetic-replacement.pdf',{type:'application/pdf'})},meta(),options);
  await command((tx,fresh)=>automation.runAutomationDue(tx,fresh,projectId,20,proofFlow));
  for(const id of[matchFlow,proofFlow])assert.equal((await db.admin.query("select id from tasks where lead_id=$1 and metadata->>'automationId'=$2",[leadId,id])).rowCount,1);
});
