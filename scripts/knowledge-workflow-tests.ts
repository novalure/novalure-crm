import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction, type TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { withCrmRead } from "../src/lib/crm-command";
import { createKnowledgeArea, createKnowledgeSource, listKnowledgeVersions, loadKnowledgeCenter, publishKnowledgeSource, queryKnowledgeCenter, updateKnowledgeSource } from "../src/lib/knowledge-center/repository";
import type { KnowledgeProposalReference, KnowledgeSource } from "../src/lib/knowledge-center/types";
import { createKnowledgeProposalInTransaction, executeKnowledgeWorkflow, loadKnowledgeWorkflow, runConfiguredKnowledgeMaintenance } from "../src/lib/knowledge-center/workflow";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const ids = { tenant: randomUUID(), otherTenant: randomUUID(), owner: randomUUID(), staff: randomUUID(), assistant: randomUUID(), otherOwner: randomUUID(), project: randomUUID(), hiddenProject: randomUUID() };
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
function session(actor: "owner" | "staff" | "assistant" | "otherOwner"): AppSession {
  const role = actor === "staff" ? "agent" : actor === "assistant" ? "assistant" : "owner";
  const productRole = actor === "staff" ? "project_sales_member" : actor === "assistant" ? "assistant_backoffice" : "customer_owner";
  return { authenticated: true, userId: ids[actor], workspaceId: actor === "otherOwner" ? ids.otherTenant : ids.tenant, workspaceName: "SYNTHETIC Knowledge workflow", name: "SYNTHETIC", email: `${actor}@example.invalid`, role, permissions: getRolePermissions(role), productRole, productPermissions: getProductRoleCapabilities(productRole), source: "database" };
}

test("Knowledge workflow PostgreSQL: publication, restored drafts, revoked retrieval and persistent proposals", { timeout: 240000 }, async t => {
  const db = await startLocalSalesDb();
  const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
  try {
    // Same historical fixture limits as knowledge-center-tests: <=090 excludes
    // manual production cutovers and substitutes only the optional vector index.
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    const migrationOwner = `knowledge_workflow_owner_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await db.admin.query(`create role ${migrationOwner} nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication`);
    await db.admin.query(`grant usage,create on schema public to ${migrationOwner}`);
    await db.admin.query(`grant all on all tables in schema public to ${migrationOwner}`);
    for (const table of ["knowledge_sources", "knowledge_chunks", "projects", "bots", "media_assets", "media_asset_shares", "workspace_module_settings", "bot_conversations", "bot_messages", "bot_tool_calls"]) await db.admin.query(`alter table ${table} owner to ${migrationOwner}`);
    const migrate = async (name: string, owned: boolean) => {
      const client = await db.admin.connect();
      try {
        await client.query("begin");
        if (owned) await client.query(`set local role ${migrationOwner}`);
        await client.query(await readFile(`migrations/${name}`, "utf8"));
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    };
    await migrate("101_knowledge_center.sql", true);
    await migrate("102_knowledge_document_processing.sql", true);
    // 103 installs a policy on the historical machine-identity table, whose
    // owner remains the fixture administrator. It is unrelated to this flow.
    await migrate("103_knowledge_assistant_service.sql", false);
    await migrate("104_knowledge_publication_workflow.sql", true);
    await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Workflow','managed_by_novalure'),($2,'SYNTHETIC Other workflow','managed_by_novalure')", [ids.tenant, ids.otherTenant]);
    for (const actor of ["owner", "staff", "assistant", "otherOwner"] as const) {
      const member = session(actor);
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC',$3,$4,$5)", [member.userId, member.workspaceId, member.email, member.role, member.productRole]);
    }
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$3,'SYNTHETIC Visible project','Bauträger'),($2,$3,'SYNTHETIC Hidden project','Bauträger')", [ids.project, ids.hiddenProject, ids.tenant]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [ids.tenant, ids.project, ids.staff]);
    for (const workspace of [ids.tenant, ids.otherTenant]) await db.admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits) values($1,true,100,20000000,100,'SYNTHETIC-WORKFLOW-CONTRACT','{"websiteImport":true,"monitoring":true,"advancedMaintenance":true}','{"maxAreas":100,"maxWebsites":10,"maxScansPerMonth":20,"maxUsers":20,"maxAssistants":20}')`, [workspace]);
    const owner = session("owner"), staff = session("staff"), assistant = session("assistant"), otherOwner = session("otherOwner");
    const area = await createKnowledgeArea(owner, { name: "SYNTHETIC Workflow company", kind: "company" }, options);
    const visibleArea = await createKnowledgeArea(owner, { name: "SYNTHETIC Workflow project", kind: "project", projectId: ids.project }, options);
    const hiddenArea = await createKnowledgeArea(owner, { name: "SYNTHETIC Workflow hidden", kind: "project", projectId: ids.hiddenProject }, options);
    const foreignArea = await createKnowledgeArea(otherOwner, { name: "SYNTHETIC Foreign company", kind: "company" }, options);
    let source = await createKnowledgeSource(staff, { areaId: area.id, name: "SYNTHETIC Mango policy", type: "manual", content: "SYNTHETIC mango opening hours are 09:00." }, options);
    const hiddenSource = await createKnowledgeSource(owner, { areaId: hiddenArea.id, name: "SYNTHETIC Restricted", type: "manual", content: "SYNTHETIC inaccessible text" }, options);
    const foreignSource = await createKnowledgeSource(otherOwner, { areaId: foreignArea.id, name: "SYNTHETIC Foreign", type: "manual", content: "SYNTHETIC foreign text" }, options);
    const current = async (sourceId = source.id): Promise<KnowledgeSource> => {
      const result = (await loadKnowledgeCenter(owner, options)).sources.find(item => item.id === sourceId);
      assert.ok(result, "the authorized source remains available to workflow editors");
      return result;
    };
    const transition = async (action: "submit" | "review" | "approve" | "publish" | "revoke", actor = owner, target = source) => {
      await executeKnowledgeWorkflow(actor, { action, sourceId: target.id, versionId: target.draftVersionId ?? target.approvedVersionId!, expectedVersion: target.revision, reason: `SYNTHETIC ${action} by authorized human` }, options);
      return current(target.id);
    };

    await t.test("tenant, project and read-only actor boundaries apply to workflow access", async () => {
      await assert.rejects(loadKnowledgeWorkflow(otherOwner, { sourceId: source.id }, options), code("NOT_FOUND"));
      await assert.rejects(loadKnowledgeWorkflow(staff, { sourceId: hiddenSource.id }, options));
      await assert.rejects(loadKnowledgeWorkflow(owner, { sourceId: foreignSource.id }, options), code("NOT_FOUND"));
      await assert.rejects(transition("submit", assistant), code("FORBIDDEN"));
      await assert.rejects(transition("approve", staff), code("FORBIDDEN"));
      await assert.rejects(transition("publish", staff), code("FORBIDDEN"));
      await assert.rejects(transition("submit", staff, hiddenSource));
      await assert.rejects(transition("submit", otherOwner), code("NOT_FOUND"));
    });

    await t.test("review and approval are separate from publication; stale writes and empty reasons are rejected", async () => {
      await assert.rejects(transition("publish"));
      await assert.rejects(executeKnowledgeWorkflow(staff, { action: "submit", sourceId: source.id, versionId: source.draftVersionId!, expectedVersion: source.revision, reason: " " }, options));
      const draftVersion = source.draftVersionId;
      source = await transition("submit", staff);
      await assert.rejects(executeKnowledgeWorkflow(owner, { action: "review", sourceId: source.id, versionId: draftVersion!, expectedVersion: source.revision + 1, reason: "SYNTHETIC stale review" }, options), code("VERSION_CONFLICT"));
      source = await transition("review");
      source = await transition("approve");
      assert.equal(source.approvedVersionId, null);
      assert.equal(source.draftVersionId, draftVersion);
      assert.equal((await queryKnowledgeCenter(assistant, { query: "mango" }, options)).grounded, false);
      source = await transition("publish");
      assert.equal(source.approvedVersionId, draftVersion);
      assert.equal(source.draftVersionId, null);
      assert.equal((await queryKnowledgeCenter(assistant, { query: "mango" }, options)).grounded, true);
      assert.equal((await db.admin.query("select count(*)::integer as count from knowledge_workflow_events where source_id=$1 and event_type='knowledge.publication.published'", [source.id])).rows[0].count, 1);
      const publishedRevision = source.revision;
      await assert.rejects(executeKnowledgeWorkflow(owner, { action: "publish", sourceId: source.id, versionId: draftVersion!, expectedVersion: publishedRevision - 1, reason: "SYNTHETIC stale publication" }, options), code("VERSION_CONFLICT"));
      assert.equal((await current()).revision, publishedRevision);
    });

    await t.test("legacy administrator publication completes approved workflows and records its publication event", async () => {
      let legacy = await createKnowledgeSource(staff, { areaId: area.id, name: "SYNTHETIC Legacy workflow", type: "manual", content: "SYNTHETIC legacy workflow kumquat policy." }, options);
      legacy = await transition("submit", staff, legacy);
      legacy = await transition("review", owner, legacy);
      await assert.rejects(publishKnowledgeSource(owner, { sourceId: legacy.id, versionId: legacy.draftVersionId!, expectedVersion: legacy.revision }, options), code("23514"));
      assert.equal((await current(legacy.id)).approvedVersionId, null);
      assert.equal((await loadKnowledgeWorkflow(owner, { sourceId: legacy.id }, options)).workflow?.state, "reviewed");
      legacy = await transition("approve", owner, legacy);
      const reviewedVersionId = legacy.draftVersionId!;
      legacy = await publishKnowledgeSource(owner, { sourceId: legacy.id, versionId: reviewedVersionId, expectedVersion: legacy.revision }, options);
      assert.equal(legacy.approvedVersionId, reviewedVersionId);
      assert.equal(legacy.draftVersionId, null);
      const workflow = (await loadKnowledgeWorkflow(owner, { sourceId: legacy.id }, options)).workflow;
      assert.equal(workflow?.state, "published");
      assert.equal(workflow?.publishedBy, ids.owner);
      assert.ok(workflow?.publishedAt);
      const publication = (await db.admin.query("select version_id,actor_id,details,visibility,delivery_state from knowledge_workflow_events where source_id=$1 and event_type='knowledge.publication.published'", [legacy.id])).rows;
      assert.equal(publication.length, 1);
      assert.equal(publication[0].version_id, reviewedVersionId);
      assert.equal(publication[0].actor_id, ids.owner);
      assert.equal(publication[0].details.publicationMode, "legacy_administrator");
      assert.equal(publication[0].visibility, "internal");
      assert.equal(publication[0].delivery_state, "pending");
      assert.equal((await queryKnowledgeCenter(assistant, { query: "kumquat" }, options)).matches[0]?.versionId, reviewedVersionId);
      let untouched = await createKnowledgeSource(staff, { areaId: area.id, name: "SYNTHETIC Untouched legacy draft", type: "manual", content: "SYNTHETIC legacy loquat policy." }, options);
      const untouchedVersionId = untouched.draftVersionId!;
      untouched = await publishKnowledgeSource(owner, { sourceId: untouched.id, versionId: untouchedVersionId, expectedVersion: untouched.revision }, options);
      assert.equal(untouched.approvedVersionId, untouchedVersionId);
      assert.equal((await loadKnowledgeWorkflow(owner, { sourceId: untouched.id }, options)).workflow, null);
      const untouchedEvents = (await db.admin.query("select version_id,details from knowledge_workflow_events where source_id=$1 and event_type='knowledge.publication.published'", [untouched.id])).rows;
      assert.equal(untouchedEvents.length, 1);
      assert.equal(untouchedEvents[0].version_id, untouchedVersionId);
      assert.equal(untouchedEvents[0].details.publicationMode, "legacy_administrator");
    });

    await t.test("restoring the current version creates a fresh draft and preserves approved grounding", async () => {
      const published = source;
      await assert.rejects(executeKnowledgeWorkflow(owner, { action: "restore", sourceId: source.id, versionId: published.approvedVersionId!, expectedVersion: published.revision, reason: "SYNTHETIC missing confirmations" }, options));
      await assert.rejects(executeKnowledgeWorkflow(owner, { action: "restore", sourceId: source.id, versionId: published.approvedVersionId!, expectedVersion: published.revision + 1, reason: "SYNTHETIC stale restore", confirmCurrentness: true, confirmLegal: true }, options), code("VERSION_CONFLICT"));
      await executeKnowledgeWorkflow(owner, { action: "restore", sourceId: source.id, versionId: published.approvedVersionId!, expectedVersion: published.revision, reason: "SYNTHETIC human reconfirmed current version", confirmCurrentness: true, confirmLegal: true }, options);
      source = await current();
      assert.equal(source.approvedVersionId, published.approvedVersionId);
      assert.notEqual(source.draftVersionId, published.approvedVersionId);
      assert.equal(source.version?.status, "draft");
      assert.equal(source.version?.content, published.version?.content);
      assert.equal((await listKnowledgeVersions(owner, { sourceId: source.id }, options)).length, 2);
      assert.equal((await queryKnowledgeCenter(assistant, { query: "mango" }, options)).matches[0]?.versionId, published.approvedVersionId);
      await assert.rejects(transition("publish"));
    });

    await t.test("revocation works with an existing draft and immediately removes current retrieval", async () => {
      const approvedVersionId = source.approvedVersionId!;
      await executeKnowledgeWorkflow(owner, { action: "revoke", sourceId: source.id, versionId: approvedVersionId, expectedVersion: source.revision, reason: "SYNTHETIC outdated publication withdrawn" }, options);
      source = await current();
      assert.equal(source.approvedVersionId, null);
      assert.ok(source.draftVersionId);
      assert.equal((await queryKnowledgeCenter(assistant, { query: "mango" }, options)).grounded, false);
      // The source remains manageable with no publication pointer, and retained
      // historical content is available only as a newly reconfirmed draft.
      await executeKnowledgeWorkflow(owner, { action: "restore", sourceId: source.id, versionId: approvedVersionId, expectedVersion: source.revision, reason: "SYNTHETIC restore retained history after revoke", confirmCurrentness: true, confirmLegal: true }, options);
      source = await current();
      assert.equal(source.approvedVersionId, null);
      assert.notEqual(source.draftVersionId, approvedVersionId);
      assert.equal(source.version?.status, "draft");
      assert.equal((await queryKnowledgeCenter(assistant, { query: "mango" }, options)).grounded, false);
    });

    await t.test("revocation without a pending draft retains editable history without a live publication", async () => {
      let noPointer = await createKnowledgeSource(staff, { areaId: area.id, name: "SYNTHETIC Papaya policy", type: "manual", content: "SYNTHETIC papaya delivery is Wednesday." }, options);
      for (const action of ["submit", "review", "approve", "publish"] as const) noPointer = await transition(action, action === "submit" ? staff : owner, noPointer);
      const publishedVersionId = noPointer.approvedVersionId!;
      await executeKnowledgeWorkflow(owner, { action: "revoke", sourceId: noPointer.id, versionId: publishedVersionId, expectedVersion: noPointer.revision, reason: "SYNTHETIC publication immediately withdrawn" }, options);
      const saved = (await db.admin.query("select approved_version_id,draft_version_id,kc_revision from knowledge_sources where id=$1", [noPointer.id])).rows[0];
      assert.equal(saved.approved_version_id, null);
      assert.ok(saved.draft_version_id);
      assert.notEqual(saved.draft_version_id, publishedVersionId);
      assert.equal((await listKnowledgeVersions(owner, { sourceId: noPointer.id }, options)).find(item => item.id === saved.draft_version_id)?.status, "draft");
      assert.equal((await queryKnowledgeCenter(assistant, { query: "papaya" }, options)).grounded, false);
      assert.equal((await loadKnowledgeWorkflow(owner, { sourceId: noPointer.id }, options)).source?.id, noPointer.id);
      await executeKnowledgeWorkflow(owner, { action: "restore", sourceId: noPointer.id, versionId: publishedVersionId, expectedVersion: saved.kc_revision, reason: "SYNTHETIC restore retained version after withdrawal", confirmCurrentness: true, confirmLegal: true }, options);
      noPointer = await current(noPointer.id);
      assert.ok(noPointer.draftVersionId);
      assert.notEqual(noPointer.draftVersionId, publishedVersionId);
      assert.equal(noPointer.approvedVersionId, null);
      assert.equal((await queryKnowledgeCenter(assistant, { query: "papaya" }, options)).grounded, false);
    });

    await t.test("historical document restoration copies parser evidence and creates the next version", async () => {
      const assetId = randomUUID(), documentId = randomUUID(), versionId = randomUUID();
      const content = "SYNTHETIC blueberry parser evidence.";
      const hash = createHash("sha256").update(content).digest("hex");
      const size = Buffer.byteLength(content);
      const admin = await db.admin.connect();
      try {
        await admin.query("begin");
        await admin.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [ids.tenant, ids.staff]);
        await admin.query("insert into media_assets(id,workspace_id,name,original_name,folder,mime_type,size_bytes,url,relative_path,storage_provider,storage_access,is_public) values($1::uuid,$2,'SYNTHETIC evidence.txt','SYNTHETIC evidence.txt',$3,'text/plain',$4,'/api/media/files/'||$1::text,$1::text,'local','private',false)", [assetId, ids.tenant, `knowledge-private-${ids.staff}`, size]);
        await admin.query("commit");
      } catch (error) { await admin.query("rollback"); throw error; } finally { admin.release(); }
      // A synthetic completed parser result, inserted with the actual tenant
      // runtime role. Storage/extraction itself has its own integration suite.
      await withCrmRead(staff, async tx => {
        await tx.execute("insert into knowledge_sources(id,workspace_id,knowledge_area_id,project_id,name,source_type,status,metadata) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'SYNTHETIC Parsed document','file','needs-review','{\"knowledgeCenter\":true,\"trust\":\"untrusted_source_data\"}'::jsonb)", [documentId, ids.tenant, visibleArea.id, ids.project]);
        await tx.execute("insert into knowledge_source_versions(id,workspace_id,source_id,version,name,content,structured_data,media_asset_id,document_size_bytes,created_by,processing_status,processing_message,processing_format,processing_error_code,document_sha256,document_import_key) values($1::uuid,$2::uuid,$3::uuid,1,'SYNTHETIC Parsed document',$4,'{\"parser\":\"fixture\"}'::jsonb,$5::uuid,$6,$7::uuid,'ready','SYNTHETIC extraction evidence','text',null,$8,$9)", [versionId, ids.tenant, documentId, content, assetId, size, ids.staff, hash, createHash("sha256").update(randomUUID()).digest("hex")]);
        await tx.execute("update knowledge_sources set draft_version_id=$1::uuid where id=$2::uuid", [versionId, documentId]);
      }, options);
      let document = await current(documentId);
      for (const action of ["submit", "review", "approve", "publish"] as const) document = await transition(action, action === "submit" ? staff : owner, document);
      document = await updateKnowledgeSource(staff, { sourceId: documentId, expectedVersion: document.revision, content: "SYNTHETIC later cranberry draft." }, options);
      await executeKnowledgeWorkflow(owner, { action: "restore", sourceId: documentId, versionId, expectedVersion: document.revision, reason: "SYNTHETIC original document reconfirmed", confirmCurrentness: true, confirmLegal: true }, options);
      const restored = await current(documentId);
      assert.equal(restored.approvedVersionId, versionId);
      assert.equal(restored.version?.version, 3);
      assert.equal(restored.version?.content, content);
      assert.equal(restored.version?.processingStatus, "ready");
      assert.equal(restored.version?.processingMessage, "SYNTHETIC extraction evidence");
      assert.equal(restored.version?.processingFormat, "text");
      assert.equal(restored.version?.mediaAssetId, assetId);
      const evidence = (await db.admin.query("select document_sha256,processing_error_code,document_import_key,provenance,change_reason from knowledge_source_versions where id=$1", [restored.draftVersionId])).rows[0];
      assert.equal(evidence.document_sha256, hash);
      assert.equal(evidence.processing_error_code, null);
      assert.equal(evidence.document_import_key, null);
      assert.equal(evidence.provenance.restoredVersionId, versionId);
      assert.equal(evidence.provenance.confirmedCurrentness, true);
      assert.equal(evidence.provenance.confirmedLegal, true);
      assert.equal(evidence.change_reason, "SYNTHETIC original document reconfirmed");
      assert.equal((await queryKnowledgeCenter(assistant, { query: "cranberry" }, options)).grounded, false);
    });

    const proposalFor = async (target: KnowledgeSource, dedupeKey: string, content: string, references?: readonly KnowledgeProposalReference[]) => {
      const snapshot = await loadKnowledgeWorkflow(owner, { sourceId: target.id }, options);
      assert.ok(snapshot.source);
      await withCrmRead(owner, (tx, fresh) => createKnowledgeProposalInTransaction(tx, fresh, {
        source: snapshot.source!, kind: "content_refresh", dedupeKey, changes: { content },
        evidence: { basis: "SYNTHETIC human-review candidate", trust: "untrusted_source_data" }, approvalLevel: 3, references,
      }), options);
      const row = (await db.admin.query("select id,revision,status,source_revision,accepted_version_id from knowledge_change_proposals where workspace_id=$1 and dedupe_key=$2", [ids.tenant, dedupeKey])).rows[0];
      assert.ok(row);
      return row as { id: string; revision: number; status: string; source_revision: number; accepted_version_id: string | null };
    };

    await t.test("persistent proposals deduplicate, accept once into a draft and preserve published content", async () => {
      let published = await createKnowledgeSource(staff, { areaId: area.id, name: "SYNTHETIC Apricot policy", type: "manual", content: "SYNTHETIC apricot opening is Monday." }, options);
      for (const action of ["submit", "review", "approve", "publish"] as const) published = await transition(action, action === "submit" ? staff : owner, published);
      const dedupeKey = `SYNTHETIC:proposal:${published.id}`;
      const proposal = await proposalFor(published, dedupeKey, "SYNTHETIC nectarine opening is Tuesday.");
      const duplicate = await proposalFor(published, dedupeKey, "SYNTHETIC repeated detection keeps original evidence.");
      assert.equal(duplicate.id, proposal.id);
      assert.equal((await db.admin.query("select count(*)::integer as count from knowledge_change_proposals where workspace_id=$1 and dedupe_key=$2", [ids.tenant, dedupeKey])).rows[0].count, 1);
      assert.ok((await loadKnowledgeWorkflow(owner, { sourceId: published.id }, options)).proposals.some(item => item.id === proposal.id));
      await assert.rejects(executeKnowledgeWorkflow(assistant, { action: "proposal-accept", proposalId: proposal.id, proposalRevision: proposal.revision, reason: "SYNTHETIC forbidden assistant acceptance" }, options), code("FORBIDDEN"));
      await assert.rejects(executeKnowledgeWorkflow(otherOwner, { action: "proposal-accept", proposalId: proposal.id, proposalRevision: proposal.revision, reason: "SYNTHETIC foreign acceptance" }, options), code("NOT_FOUND"));
      await executeKnowledgeWorkflow(owner, { action: "proposal-accept", proposalId: proposal.id, proposalRevision: proposal.revision, reason: "SYNTHETIC human accepted candidate as draft" }, options);
      const accepted = await current(published.id);
      assert.equal(accepted.approvedVersionId, published.approvedVersionId);
      assert.notEqual(accepted.draftVersionId, published.approvedVersionId);
      assert.equal(accepted.version?.status, "draft");
      assert.equal(accepted.version?.content, "SYNTHETIC nectarine opening is Tuesday.");
      assert.equal((await queryKnowledgeCenter(assistant, { query: "apricot" }, options)).matches.some(item => item.sourceId === published.id), true);
      assert.equal((await queryKnowledgeCenter(assistant, { query: "nectarine" }, options)).grounded, false);
      const saved = (await db.admin.query("select status,revision,accepted_version_id from knowledge_change_proposals where id=$1", [proposal.id])).rows[0];
      assert.equal(saved.status, "accepted");
      assert.equal(saved.revision, proposal.revision + 1);
      assert.equal(saved.accepted_version_id, accepted.draftVersionId);
      const acceptedVersion = (await db.admin.query("select provenance,change_reason from knowledge_source_versions where id=$1", [accepted.draftVersionId])).rows[0];
      assert.equal(acceptedVersion.provenance.proposalId, proposal.id);
      assert.equal(acceptedVersion.change_reason, "SYNTHETIC human accepted candidate as draft");
      await assert.rejects(executeKnowledgeWorkflow(owner, { action: "proposal-accept", proposalId: proposal.id, proposalRevision: proposal.revision, reason: "SYNTHETIC stale repeated acceptance" }, options), code("VERSION_CONFLICT"));
      assert.equal((await current(published.id)).draftVersionId, accepted.draftVersionId);
    });

    await t.test("proposal revisions, changed source references and defer/reject decisions remain durable", async () => {
      let candidate = await createKnowledgeSource(staff, { areaId: visibleArea.id, name: "SYNTHETIC Plum draft", type: "manual", content: "SYNTHETIC plum context." }, options);
      const stale = await proposalFor(candidate, `SYNTHETIC:stale:${candidate.id}`, "SYNTHETIC stale proposal must not apply.");
      candidate = await updateKnowledgeSource(staff, { sourceId: candidate.id, expectedVersion: candidate.revision, content: "SYNTHETIC newer human edit." }, options);
      await assert.rejects(executeKnowledgeWorkflow(owner, { action: "proposal-accept", proposalId: stale.id, proposalRevision: stale.revision, reason: "SYNTHETIC source changed after detection" }, options), code("STALE_PROPOSAL"));
      assert.equal((await current(candidate.id)).draftVersionId, candidate.draftVersionId);
      assert.equal((await db.admin.query("select status from knowledge_change_proposals where id=$1", [stale.id])).rows[0].status, "open");
      const deferred = await proposalFor(candidate, `SYNTHETIC:defer:${candidate.id}`, "SYNTHETIC optional kiwi improvement.");
      await executeKnowledgeWorkflow(owner, { action: "proposal-defer", proposalId: deferred.id, proposalRevision: deferred.revision, reason: "SYNTHETIC wait for human evidence" }, options);
      let saved = (await db.admin.query("select status,revision from knowledge_change_proposals where id=$1", [deferred.id])).rows[0];
      assert.equal(saved.status, "deferred");
      await assert.rejects(executeKnowledgeWorkflow(owner, { action: "proposal-edit", proposalId: deferred.id, proposalRevision: deferred.revision, reason: "SYNTHETIC stale proposal edit", changes: { content: "SYNTHETIC outdated edit" } }, options), code("VERSION_CONFLICT"));
      await executeKnowledgeWorkflow(owner, { action: "proposal-edit", proposalId: deferred.id, proposalRevision: saved.revision, reason: "SYNTHETIC refined candidate", changes: { content: "SYNTHETIC refined kiwi candidate." } }, options);
      saved = (await db.admin.query("select status,revision,changes from knowledge_change_proposals where id=$1", [deferred.id])).rows[0];
      assert.equal(saved.changes.content, "SYNTHETIC refined kiwi candidate.");
      await executeKnowledgeWorkflow(owner, { action: "proposal-reject", proposalId: deferred.id, proposalRevision: saved.revision, reason: "SYNTHETIC human declined publication candidate" }, options);
      assert.equal((await db.admin.query("select status from knowledge_change_proposals where id=$1", [deferred.id])).rows[0].status, "rejected");
      assert.equal((await current(candidate.id)).draftVersionId, candidate.draftVersionId);
      assert.equal((await queryKnowledgeCenter(assistant, { query: "kiwi" }, options)).grounded, false);
    });

    await t.test("secondary reference staleness blocks proposal acceptance in both the service and raw database paths", async () => {
      const primary = await createKnowledgeSource(staff, { areaId: visibleArea.id, name: "SYNTHETIC Related target", type: "manual", content: "SYNTHETIC related primary text." }, options);
      let secondary = await createKnowledgeSource(staff, { areaId: visibleArea.id, name: "SYNTHETIC Related reference", type: "manual", content: "SYNTHETIC related secondary evidence." }, options);
      const reference = (item: KnowledgeSource): KnowledgeProposalReference => ({ sourceId: item.id, versionId: item.version!.id, sourceRevision: item.revision, contentVersion: item.version!.version, areaId: item.areaId, projectId: item.projectId });
      await assert.rejects(proposalFor(primary, `SYNTHETIC:mixed-scope:${primary.id}`, "SYNTHETIC mixed scope candidate.", [reference(primary), reference(hiddenSource)]), code("VALIDATION_ERROR"));
      const proposal = await proposalFor(primary, `SYNTHETIC:references:${primary.id}`, "SYNTHETIC related content candidate.", [reference(primary), reference(secondary)]);
      secondary = await updateKnowledgeSource(staff, { sourceId: secondary.id, expectedVersion: secondary.revision, content: "SYNTHETIC related secondary evidence changed." }, options);
      await assert.rejects(executeKnowledgeWorkflow(owner, { action: "proposal-accept", proposalId: proposal.id, proposalRevision: proposal.revision, reason: "SYNTHETIC stale secondary reference" }, options), code("STALE_PROPOSAL"));
      const rawDraftId = randomUUID();
      await assert.rejects(withCrmRead(owner, async tx => {
        await tx.execute("insert into knowledge_source_versions(id,workspace_id,source_id,version,name,content,created_by,change_reason,provenance) values($1::uuid,$2::uuid,$3::uuid,2,'SYNTHETIC Raw acceptance','SYNTHETIC related content candidate.',$4::uuid,'SYNTHETIC raw secondary reference check',$5::jsonb)", [rawDraftId, ids.tenant, primary.id, ids.owner, JSON.stringify({ kind: "proposal", proposalId: proposal.id, trust: "untrusted_source_data" })]);
        await tx.execute("update knowledge_sources set draft_version_id=$1::uuid,kc_revision=kc_revision+1,status='needs-review' where id=$2::uuid", [rawDraftId, primary.id]);
        await tx.execute("update knowledge_change_proposals set status='accepted',revision=revision+1,accepted_version_id=$1::uuid,updated_by=$2::uuid,reason='SYNTHETIC raw acceptance must reject stale secondary' where id=$3::uuid", [rawDraftId, ids.owner, proposal.id]);
      }, options), (error: unknown) => code("23514")(error) && /Another proposal reference became stale/.test((error as Error).message));
      assert.equal((await current(primary.id)).draftVersionId, primary.draftVersionId);
      assert.equal((await listKnowledgeVersions(owner, { sourceId: primary.id }, options)).length, 1);
      assert.equal((await current(secondary.id)).draftVersionId, secondary.draftVersionId);
      assert.equal((await db.admin.query("select status from knowledge_change_proposals where id=$1", [proposal.id])).rows[0].status, "open");
    });

    await t.test("configured maintenance persists review proposals without changing content and respects the feature gate", async () => {
      const incomplete = await createKnowledgeSource(staff, { areaId: visibleArea.id, name: "SYNTHETIC Structured property", type: "structured", structuredData: { projectName: "SYNTHETIC project" } }, options);
      const configuration = { action: "configure", areaId: visibleArea.id, fields: [{ fieldPath: "description", required: true, sourceTypes: ["structured" as const] }], staleAfterDays: 30, reason: "SYNTHETIC trusted review configuration" };
      await assert.rejects(executeKnowledgeWorkflow(staff, configuration, options), code("FORBIDDEN"));
      await executeKnowledgeWorkflow(owner, configuration, options);
      const savedConfiguration = (await loadKnowledgeWorkflow(owner, { sourceId: incomplete.id }, options)).configurations[0];
      assert.equal(savedConfiguration.areaId, visibleArea.id);
      assert.equal(savedConfiguration.staleAfterDays, 30);
      assert.equal(savedConfiguration.enabled, false);
      assert.equal(savedConfiguration.nextAnalysisAt, null);
      assert.deepEqual(savedConfiguration.fields, configuration.fields);
      await assert.rejects(executeKnowledgeWorkflow(staff, { action: "analyze", areaId: hiddenArea.id }, options));
      await executeKnowledgeWorkflow(staff, { action: "analyze", areaId: visibleArea.id }, options);
      const proposals = (await db.admin.query("select id,kind,changes,references_json,approval_level from knowledge_change_proposals where source_id=$1 and kind='missing_required_field'", [incomplete.id])).rows;
      assert.equal(proposals.length, 1);
      assert.deepEqual(proposals[0].changes, {});
      assert.equal(proposals[0].references_json[0].sourceId, incomplete.id);
      assert.equal(proposals[0].references_json[0].versionId, incomplete.draftVersionId);
      assert.equal(proposals[0].approval_level, 2);
      await executeKnowledgeWorkflow(owner, { action: "analyze", areaId: visibleArea.id }, options);
      assert.equal((await db.admin.query("select count(*)::integer as count from knowledge_change_proposals where source_id=$1 and kind='missing_required_field'", [incomplete.id])).rows[0].count, 1);
      const unchanged = await current(incomplete.id);
      assert.equal(unchanged.revision, incomplete.revision);
      assert.equal(unchanged.draftVersionId, incomplete.draftVersionId);
      assert.equal(unchanged.approvedVersionId, null);
      assert.deepEqual(unchanged.version?.structuredData, incomplete.version?.structuredData);
      await db.admin.query("update knowledge_center_entitlements set features=features||'{\"advancedMaintenance\":false}'::jsonb where workspace_id=$1", [ids.tenant]);
      try { await assert.rejects(executeKnowledgeWorkflow(owner, { action: "analyze", areaId: visibleArea.id }, options), code("ENTITLEMENT_REQUIRED")); }
      finally { await db.admin.query("update knowledge_center_entitlements set features=features||'{\"advancedMaintenance\":true}'::jsonb where workspace_id=$1", [ids.tenant]); }
    });

    await t.test("only enabled due configurations run, persist the next day and stop after disabling", async () => {
      const now = new Date(Date.now() + 1000).toISOString();
      assert.equal((await runConfiguredKnowledgeMaintenance(owner, { now }, options)).analyzedAreaCount, 0);
      await assert.rejects(runConfiguredKnowledgeMaintenance(staff, { now }, options), code("FORBIDDEN"));
      assert.equal((await runConfiguredKnowledgeMaintenance(otherOwner, { now }, options)).analyzedAreaCount, 0);
      const configuration = { action: "configure", areaId: visibleArea.id, fields: [{ fieldPath: "description", required: true, sourceTypes: ["structured" as const] }], staleAfterDays: 30, enabled: true, reason: "SYNTHETIC human enabled internal daily review" };
      await executeKnowledgeWorkflow(owner, configuration, options);
      const before = (await db.admin.query("select id,kc_revision,draft_version_id,approved_version_id from knowledge_sources where workspace_id=$1 order by id", [ids.tenant])).rows;
      const originalFetch = globalThis.fetch;
      let externalCalls = 0;
      globalThis.fetch = async () => { externalCalls++; throw new Error("SYNTHETIC maintenance must not call external services"); };
      try {
        const run = await runConfiguredKnowledgeMaintenance(owner, { now }, options);
        assert.equal(run.analyzedAreaCount, 1);
        assert.ok(run.proposals.length > 0);
        assert.equal((await runConfiguredKnowledgeMaintenance(owner, { now }, options)).analyzedAreaCount, 0);
        const saved = (await db.admin.query("select enabled,last_analyzed_at,next_analysis_at from knowledge_maintenance_configurations where area_id=$1", [visibleArea.id])).rows[0];
        assert.equal(saved.enabled, true);
        assert.equal(saved.last_analyzed_at.toISOString(), now);
        assert.equal(saved.next_analysis_at.toISOString(), new Date(Date.parse(now) + 86400000).toISOString());
        await executeKnowledgeWorkflow(owner, { ...configuration, enabled: false, reason: "SYNTHETIC human disabled daily review" }, options);
        assert.equal((await runConfiguredKnowledgeMaintenance(owner, { now: saved.next_analysis_at.toISOString() }, options)).analyzedAreaCount, 0);
        const disabled = (await db.admin.query("select enabled,next_analysis_at from knowledge_maintenance_configurations where area_id=$1", [visibleArea.id])).rows[0];
        assert.equal(disabled.enabled, false);
        assert.equal(disabled.next_analysis_at, null);
      } finally { globalThis.fetch = originalFetch; }
      assert.equal(externalCalls, 0);
      assert.deepEqual((await db.admin.query("select id,kc_revision,draft_version_id,approved_version_id from knowledge_sources where workspace_id=$1 order by id", [ids.tenant])).rows, before);
    });

    await t.test("audit failure atomically rolls back proposal acceptance, content and the internal event", async () => {
      const candidate = await createKnowledgeSource(staff, { areaId: area.id, name: "SYNTHETIC Rollback draft", type: "manual", content: "SYNTHETIC rollback original." }, options);
      const proposal = await proposalFor(candidate, `SYNTHETIC:rollback:${candidate.id}`, "SYNTHETIC rollback candidate.");
      await db.admin.query("create function synthetic_reject_workflow_audit() returns trigger language plpgsql as $$begin if new.action='knowledge.proposal.accept' then raise exception 'SYNTHETIC workflow audit unavailable' using errcode='23514'; end if; return new; end$$; create trigger synthetic_reject_workflow_audit before insert on audit_logs for each row execute function synthetic_reject_workflow_audit()");
      try {
        await assert.rejects(executeKnowledgeWorkflow(owner, { action: "proposal-accept", proposalId: proposal.id, proposalRevision: proposal.revision, reason: "SYNTHETIC rejected audit must roll back" }, options), code("23514"));
      } finally { await db.admin.query("drop trigger synthetic_reject_workflow_audit on audit_logs; drop function synthetic_reject_workflow_audit()"); }
      const unchanged = await current(candidate.id);
      assert.equal(unchanged.draftVersionId, candidate.draftVersionId);
      assert.equal(unchanged.revision, candidate.revision);
      assert.equal((await listKnowledgeVersions(owner, { sourceId: candidate.id }, options)).length, 1);
      const saved = (await db.admin.query("select status,revision,accepted_version_id from knowledge_change_proposals where id=$1", [proposal.id])).rows[0];
      assert.equal(saved.status, "open");
      assert.equal(saved.revision, proposal.revision);
      assert.equal(saved.accepted_version_id, null);
      assert.equal((await db.admin.query("select count(*)::integer as count from knowledge_workflow_events where source_id=$1 and event_type='knowledge.proposal.accept'", [candidate.id])).rows[0].count, 0);
    });

    await t.test("workflow tables force RLS and internal events cannot be changed", async () => {
      const tables = ["knowledge_publication_workflows", "knowledge_change_proposals", "knowledge_workflow_events", "knowledge_maintenance_configurations"];
      const metadata = (await db.admin.query("select c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolsuper,r.rolbypassrls from pg_class c join pg_roles r on r.oid=c.relowner where c.relname=any($1::text[])", [tables])).rows;
      assert.equal(metadata.length, tables.length);
      assert.ok(metadata.every(row => row.relrowsecurity && row.relforcerowsecurity && !row.rolsuper && !row.rolbypassrls));
      await withTenantTransaction({ actorId: ids.assistant, workspaceId: ids.tenant }, async tx => {
        for (const table of tables) assert.equal((await tx.query(`select * from ${table}`)).length, 0);
      }, options);
      await withTenantTransaction({ actorId: ids.otherOwner, workspaceId: ids.otherTenant }, async tx => {
        for (const table of tables) assert.equal((await tx.query(`select * from ${table} where workspace_id=$1::uuid`, [ids.tenant])).length, 0);
      }, options);
      const hidden = await transition("submit", owner, hiddenSource);
      const hiddenProposal = await proposalFor(hidden, `SYNTHETIC:hidden:${hidden.id}`, "SYNTHETIC private candidate.");
      await withTenantTransaction({ actorId: ids.staff, workspaceId: ids.tenant }, async tx => {
        assert.equal((await tx.query("select id from knowledge_change_proposals where id=$1::uuid", [hiddenProposal.id])).length, 0);
        assert.equal((await tx.query("select version_id from knowledge_publication_workflows where source_id=$1::uuid", [hidden.id])).length, 0);
        assert.equal((await tx.query("select id from knowledge_workflow_events where source_id=$1::uuid", [hidden.id])).length, 0);
      }, options);
      const event = (await db.admin.query("select id,visibility,delivery_state from knowledge_workflow_events where workspace_id=$1 limit 1", [ids.tenant])).rows[0];
      assert.ok(event);
      assert.equal(event.visibility, "internal");
      assert.equal(event.delivery_state, "pending");
      await assert.rejects(withTenantTransaction({ actorId: ids.owner, workspaceId: ids.tenant }, tx => tx.execute("update knowledge_workflow_events set details='{}'::jsonb where id=$1::uuid", [event.id]), options), code("42501"));
      await assert.rejects(withTenantTransaction({ actorId: ids.owner, workspaceId: ids.tenant }, tx => tx.execute("delete from knowledge_workflow_events where id=$1::uuid", [event.id]), options), code("42501"));
    });
  } finally { await db.stop(); }
});
