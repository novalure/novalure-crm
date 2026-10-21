import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction, type TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const textFile = (content = "SYNTHETIC blueberry delivery is Monday.", name = "delivery.txt") => new File([content], name, { type: "text/plain" });

test("private document pipeline: bytes, immutable results, replay, approval, replacement and changed authority", { timeout: 240000 }, async t => {
  const db = await startLocalSalesDb();
  const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "knowledge-pipeline-"));
  const keys = ["DATABASE_URL", "CRM_LOCAL_TEST_DATABASE", "NODE_ENV", "NOVALURE_MEDIA_ROOT", "VERCEL", "VERCEL_ENV", "VERCEL_URL"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    await applySalesSchema(db, { maxMigrationNumber: 107 });
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, CRM_LOCAL_TEST_DATABASE: "1", NODE_ENV: "test", NOVALURE_MEDIA_ROOT: mediaRoot });
    const workspaceId = randomUUID(), ownerId = randomUUID(), staffId = randomUUID(), viewerId = randomUUID(), projectId = randomUUID();
    await db.admin.query("insert into workspaces(id,name) values($1,'SYNTHETIC document import')", [workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$3,'SYNTHETIC Owner','owner@example.invalid','owner','customer_owner'),($2,$3,'SYNTHETIC Staff','staff@example.invalid','agent','project_sales_member')", [ownerId, staffId, workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC Viewer','viewer@example.invalid','assistant','viewer')", [viewerId, workspaceId]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC hidden project','Bauträger')", [projectId, workspaceId]);
    await db.admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits) values($1,true,20,20000000,100,'SYNTHETIC-DOCUMENT-IMPORT','{"webchatAccess":true,"voiceAccess":true}','{"maxAreas":10,"maxWebsites":5,"maxScansPerMonth":5,"maxUsers":20,"maxAssistants":20}')`, [workspaceId]);
    const owner: AppSession = { authenticated: true, userId: ownerId, workspaceId, workspaceName: "SYNTHETIC", name: "Owner", email: "owner@example.invalid", role: "owner", permissions: getRolePermissions("owner"), productRole: "customer_owner", productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" };
    const staff: AppSession = { ...owner, userId: staffId, role: "agent", permissions: getRolePermissions("agent"), productRole: "project_sales_member", productPermissions: getProductRoleCapabilities("project_sales_member") };
    const viewer: AppSession = { ...owner, userId: viewerId, role: "assistant", permissions: getRolePermissions("assistant"), productRole: "viewer", productPermissions: getProductRoleCapabilities("viewer") };
    const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
    const repository = await import("../src/lib/knowledge-center/repository");
    const media = await import("../src/lib/media-store");
    const area = await repository.createKnowledgeArea(owner, { name: "SYNTHETIC Import", kind: "company" }, options);
    const hidden = await repository.createKnowledgeArea(owner, { name: "SYNTHETIC Restricted", kind: "project", projectId }, options);
    let imported: Awaited<ReturnType<typeof repository.importKnowledgeDocument>>;

    await t.test("automatic extraction creates one private draft under concurrent retries", async () => {
      const results = await Promise.all([1, 2].map(() => repository.importKnowledgeDocument(staff, { areaId: area.id, file: textFile() }, options)));
      imported = results[0];
      assert.equal(results[0].asset.id, results[1].asset.id);
      assert.equal(results[0].source.id, results[1].source.id);
      assert.equal(results.filter(item => item.reused).length, 1);
      assert.equal(imported.source.version?.content, "SYNTHETIC blueberry delivery is Monday.");
      assert.equal(imported.source.version?.processingStatus, "ready");
      assert.equal(imported.source.version?.processingFormat, "text");
      assert.equal(imported.source.approvedVersionId, null);
      assert.equal("url" in imported.asset, false);
      assert.equal((await repository.queryKnowledgeCenter(owner, { query: "blueberry" }, options)).grounded, false);
      assert.equal((await db.admin.query("select count(*)::int as count from media_assets where workspace_id=$1", [workspaceId])).rows[0].count, 1);
      assert.equal((await db.admin.query("select count(*)::int as count from knowledge_source_versions where source_id=$1", [imported.source.id])).rows[0].count, 1);
      assert.equal((await db.admin.query("select document_sha256 from knowledge_source_versions where id=$1", [imported.source.version!.id])).rows[0].document_sha256, createHash("sha256").update("SYNTHETIC blueberry delivery is Monday.").digest("hex"));
      assert.equal(await media.findWorkspaceMediaAsset(imported.asset.id, workspaceId), null);
      await assert.rejects(repository.publishKnowledgeSource(staff, { sourceId: imported.source.id, versionId: imported.source.draftVersionId!, expectedVersion: imported.source.revision }, options), code("FORBIDDEN"));
      imported.source = await repository.publishKnowledgeSource(owner, { sourceId: imported.source.id, versionId: imported.source.draftVersionId!, expectedVersion: imported.source.revision }, options);
      assert.equal((await repository.queryKnowledgeCenter(owner, { query: "blueberry" }, options)).grounded, true);
    });

    await t.test("replacement works at source quota and retains only approved grounding until review", async () => {
      await db.admin.query("update knowledge_center_entitlements set max_sources=1 where workspace_id=$1", [workspaceId]);
      const previous = imported.source;
      imported = await repository.importKnowledgeDocument(staff, { areaId: area.id, sourceId: previous.id, expectedVersion: previous.revision, file: textFile("SYNTHETIC cranberry delivery is Friday.") }, options);
      assert.equal(imported.source.revision, previous.revision + 1);
      assert.equal(imported.source.approvedVersionId, previous.approvedVersionId);
      assert.equal((await repository.queryKnowledgeCenter(owner, { query: "blueberry" }, options)).grounded, true);
      assert.equal((await repository.queryKnowledgeCenter(owner, { query: "cranberry" }, options)).grounded, false);
      const replay = await repository.importKnowledgeDocument(staff, { areaId: area.id, sourceId: previous.id, expectedVersion: previous.revision, file: textFile("SYNTHETIC cranberry delivery is Friday.") }, options);
      assert.equal(replay.reused, true);
      await assert.rejects(repository.importKnowledgeDocument(staff, { areaId: area.id, sourceId: previous.id, expectedVersion: previous.revision, file: textFile("different stale file") }, options), code("VERSION_CONFLICT"));
      await assert.rejects(repository.importKnowledgeDocument(staff, { areaId: area.id, file: textFile("another source") }, options), code("LIMIT_EXCEEDED"));
      await db.admin.query("update knowledge_center_entitlements set max_sources=20 where workspace_id=$1", [workspaceId]);
      const approvedDocument = await repository.getKnowledgeDocument(viewer, { sourceId: previous.id }, options);
      const historicalDocument = await repository.getKnowledgeDocument(staff, { sourceId: previous.id, versionId: previous.approvedVersionId! }, options);
      assert.equal(approvedDocument.downloadPath, `/api/knowledge-center/sources/${previous.id}/document`);
      assert.equal(historicalDocument.downloadPath, `/api/knowledge-center/sources/${previous.id}/document?versionId=${previous.approvedVersionId}`);
      assert.equal(historicalDocument.assetId, approvedDocument.assetId);
      assert.notEqual(historicalDocument.assetId, imported.asset.id);
      assert.equal((await repository.getKnowledgeDocument(staff, { sourceId: previous.id }, options)).assetId, imported.asset.id);
      await assert.rejects(repository.getKnowledgeDocument(viewer, { sourceId: previous.id, versionId: imported.source.draftVersionId! }, options), code("NOT_FOUND"));
      const { withCrmRead } = await import("../src/lib/crm-command");
      const oldContent = await withCrmRead(staff, async () => {
        const asset = await media.authorizedKnowledgeMediaAsset(historicalDocument.assetId, workspaceId);
        assert.ok(asset);
        const content = await media.readMediaAssetContent(asset);
        assert.ok(content);
        return new Response(content.body).text();
      }, options);
      assert.equal(oldContent, "SYNTHETIC blueberry delivery is Monday.");
      imported.source = await repository.publishKnowledgeSource(owner, { sourceId: imported.source.id, versionId: imported.source.draftVersionId!, expectedVersion: imported.source.revision }, options);
      assert.equal((await repository.getKnowledgeDocument(viewer, { sourceId: previous.id }, options)).assetId, imported.asset.id);
      await assert.rejects(repository.getKnowledgeDocument(viewer, { sourceId: previous.id, versionId: previous.approvedVersionId! }, options), code("NOT_FOUND"));
      assert.equal((await repository.getKnowledgeDocument(staff, { sourceId: previous.id, versionId: previous.approvedVersionId! }, options)).assetId, historicalDocument.assetId);
    });

    await t.test("parse failures retain private bytes and cannot be approved or cleared by generic edits", async () => {
      const failed = await repository.importKnowledgeDocument(staff, { areaId: area.id, file: new File(["%PDF-1.7\nSYNTHETIC corrupt PDF\n%%EOF"], "broken.pdf", { type: "application/pdf" }) }, options);
      assert.equal(failed.source.version?.processingStatus, "failed");
      assert.ok(failed.source.version?.processingMessage);
      assert.equal((await repository.getKnowledgeDocument(staff, { sourceId: failed.source.id }, options)).assetId, failed.asset.id);
      await assert.rejects(repository.getKnowledgeDocument(staff, { sourceId: failed.source.id, versionId: imported.source.approvedVersionId! }, options), code("NOT_FOUND"));
      assert.equal(await media.findWorkspaceMediaAsset(failed.asset.id, workspaceId), null);
      const repeated = await repository.importKnowledgeDocument(staff, { areaId: area.id, file: new File(["%PDF-1.7\nSYNTHETIC corrupt PDF\n%%EOF"], "broken.pdf", { type: "application/pdf" }) }, options);
      assert.equal(repeated.reused, true);
      assert.equal(repeated.source.version!.id, failed.source.version!.id);
      const edited = await repository.updateKnowledgeSource(staff, { sourceId: failed.source.id, expectedVersion: failed.source.revision, content: "forged successful transcript", structuredData: { processingStatus: "ready" } }, options);
      assert.equal(edited.version?.processingStatus, "failed");
      await assert.rejects(repository.publishKnowledgeSource(owner, { sourceId: edited.id, versionId: edited.draftVersionId!, expectedVersion: edited.revision }, options), code("DOCUMENT_NOT_READY"));
      await assert.rejects(withTenantTransaction({ actorId: ownerId, workspaceId }, tx => tx.execute("update knowledge_source_versions set status='approved',approved_by=$1::uuid,approved_at=now() where id=$2::uuid", [ownerId, edited.draftVersionId]), options), code("23514"));
      await assert.rejects(withTenantTransaction({ actorId: ownerId, workspaceId }, tx => tx.execute("update knowledge_source_versions set processing_status='ready' where id=$1::uuid", [edited.draftVersionId]), options), code("42501"));
      const bypass = await repository.createKnowledgeSource(staff, { areaId: area.id, type: "file", name: "SYNTHETIC bypass", mediaAssetId: failed.asset.id, content: "forged new source transcript" }, options);
      assert.equal(bypass.version?.processingStatus, "needs_ocr");
      await assert.rejects(repository.publishKnowledgeSource(owner, { sourceId: bypass.id, versionId: bypass.draftVersionId!, expectedVersion: bypass.revision }, options), code("DOCUMENT_NOT_READY"));
    });

    await t.test("a scanned PDF becomes an actionable OCR draft with no publishable content", async () => {
      const { PDFDocument } = await import("pdf-lib");
      const pdf = await PDFDocument.create(); pdf.addPage();
      const scanned = await repository.importKnowledgeDocument(staff, { areaId: area.id, file: new File([Uint8Array.from(await pdf.save())], "scan.pdf", { type: "application/pdf" }) }, options);
      assert.equal(scanned.source.version?.processingStatus, "needs_ocr");
      assert.equal(scanned.source.version?.content, "");
      assert.match(scanned.source.version?.processingMessage ?? "", /OCR/);
      await assert.rejects(repository.publishKnowledgeSource(owner, { sourceId: scanned.source.id, versionId: scanned.source.draftVersionId!, expectedVersion: scanned.source.revision }, options), code("DOCUMENT_NOT_READY"));
    });

    await t.test("hidden areas and revoked membership during byte work cannot create assets or versions", async () => {
      await assert.rejects(repository.importKnowledgeDocument(staff, { areaId: hidden.id, file: textFile() }, options));
      const before = Number((await db.admin.query("select count(*) from media_assets where workspace_id=$1", [workspaceId])).rows[0].count);
      class RevokedFile extends File {
        async arrayBuffer(): Promise<ArrayBuffer> {
          await db.admin.query("update workspace_users set role='assistant',product_role='assistant_backoffice' where id=$1", [staffId]);
          return super.arrayBuffer();
        }
      }
      try {
        await assert.rejects(repository.importKnowledgeDocument(staff, { areaId: area.id, file: new RevokedFile(["SYNTHETIC authority changed"], "revoked.txt", { type: "text/plain" }) }, options), code("FORBIDDEN"));
      } finally { await db.admin.query("update workspace_users set role='agent',product_role='project_sales_member' where id=$1", [staffId]); }
      assert.equal(Number((await db.admin.query("select count(*) from media_assets where workspace_id=$1", [workspaceId])).rows[0].count), before);
    });

    await t.test("audit rollback removes stored bytes after authoritative metadata absence", async () => {
      const fileCount = async () => (await readdir(mediaRoot, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).length;
      const beforeFiles = await fileCount(), beforeUsage = (await repository.loadKnowledgeCenter(owner, options)).usage;
      await db.admin.query(`create function synthetic_reject_document_audit() returns trigger language plpgsql as $$begin if new.action='knowledge.document.imported' then raise exception 'SYNTHETIC audit failure' using errcode='23514'; end if; return new; end$$;
        create trigger synthetic_reject_document_audit before insert on audit_logs for each row execute function synthetic_reject_document_audit()`);
      try {
        await assert.rejects(repository.importKnowledgeDocument(staff, { areaId: area.id, file: textFile("SYNTHETIC audit rollback bytes", "rollback.txt") }, options), code("23514"));
      } finally { await db.admin.query("drop trigger synthetic_reject_document_audit on audit_logs; drop function synthetic_reject_document_audit()"); }
      assert.equal(await fileCount(), beforeFiles);
      assert.deepEqual((await repository.loadKnowledgeCenter(owner, options)).usage, beforeUsage);
    });

    await t.test("a committed upload survives discard attempts with its opaque capability", async () => {
      const { withCrmRead } = await import("../src/lib/crm-command");
      const committed = await withCrmRead(staff, () => media.saveKnowledgeFile({ actorId: staffId, workspaceId, file: textFile("SYNTHETIC committed upload", "committed.txt") }), options);
      assert.equal(await withCrmRead(staff, () => media.discardUncommittedKnowledgeFile({ ...committed }), options), false);
      assert.equal(await withCrmRead(staff, () => media.discardUncommittedKnowledgeFile(committed), options), false);
      assert.equal(await media.mediaAssetExists(committed), true);
    });

    await t.test("a lost COMMIT acknowledgement preserves committed bytes and replays the durable version", async () => {
      let commits = 0;
      const uncertainPool = { connect: async () => {
        const client = await db.pool.connect();
        return new Proxy(client, { get(target, property) {
          if (property === "query") return async (...args: unknown[]) => {
            const response = await Reflect.apply(target.query, target, args);
            if (args[0] === "commit" && ++commits === 3) throw new Error("SYNTHETIC lost COMMIT acknowledgement");
            return response;
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      } } as unknown as NonNullable<TenantTransactionOptions["pool"]>;
      const input = { areaId: area.id, file: textFile("SYNTHETIC uncertain commit survives", "uncertain.txt") };
      await assert.rejects(repository.importKnowledgeDocument(staff, input, { pool: uncertainPool }), /lost COMMIT acknowledgement/);
      const replay = await repository.importKnowledgeDocument(staff, input, options);
      assert.equal(replay.reused, true);
      const { withCrmRead } = await import("../src/lib/crm-command");
      const stored = await withCrmRead(staff, () => media.authorizedKnowledgeMediaAsset(replay.asset.id, workspaceId), options);
      assert.ok(stored);
      assert.equal(await media.mediaAssetExists(stored), true);
    });
  } finally {
    await closeLocalTestPool();
    await db.stop();
    await rm(mediaRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
