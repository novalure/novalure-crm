import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getPayloadFromClientToken } from "@vercel/blob/client";
import type { AppSession } from "../src/lib/auth/session";
import { decryptAuthValue, encryptAuthValue } from "../src/lib/auth/auth-security";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { extractKnowledgeDocument } from "../src/lib/knowledge-center/document-extraction";
import type { KnowledgeDocumentUploadMetadata, VerifiedKnowledgeDocumentUpload } from "../src/lib/knowledge-center/document-upload";
import { KnowledgeCenterError } from "../src/lib/knowledge-center/policy";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { createNearLimitDocx, createNearLimitPdf, DOCX_MIME } from "./lib/knowledge-document-fixtures";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const applicationMaximumBytes = 10 * 1024 * 1024;

test("actual PDF and DOCX files at the unchanged 10 MiB limit retain their text and tables", { timeout: 30_000 }, async () => {
  const pdf = await createNearLimitPdf();
  const docx = createNearLimitDocx();
  assert.equal(pdf.byteLength, applicationMaximumBytes);
  assert.equal(docx.byteLength, applicationMaximumBytes);
  const parsedPdf = await extractKnowledgeDocument({ bytes: pdf, fileName: "synthetic-limit.pdf", mimeType: "application/pdf" });
  assert.equal(parsedPdf.status, "ready");
  assert.match(parsedPdf.content, /SYNTHETIC near-limit private PDF ALPHA/);
  const parsedDocx = await extractKnowledgeDocument({ bytes: docx, fileName: "synthetic-limit.docx", mimeType: DOCX_MIME });
  assert.equal(parsedDocx.status, "ready");
  assert.match(parsedDocx.content, /SYNTHETIC paragraph ALPHA/);
  assert.match(parsedDocx.content, /Table one\n\tTable two/);
  assert.match(parsedDocx.content, /Final paragraph BETA/);
});

test("durable private upload reservations serialize capacity, tenant isolation and finalize replay", { timeout: 180_000 }, async (t) => {
  const db = await startLocalSalesDb();
  const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "knowledge-direct-upload-"));
  const keys = ["DATABASE_URL", "CRM_LOCAL_TEST_DATABASE", "NODE_ENV", "NOVALURE_MEDIA_ROOT", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN", "BLOB_PRIVATE_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const code = (expected: string) => (error: unknown) => error instanceof KnowledgeCenterError && error.code === expected;
  try {
    await applySalesSchema(db, { maxMigrationNumber: 108 });
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, CRM_LOCAL_TEST_DATABASE: "1", NODE_ENV: "test", NOVALURE_MEDIA_ROOT: mediaRoot });
    const repository = await import("../src/lib/knowledge-center/repository");
    const { withCrmRead } = await import("../src/lib/crm-command");
    const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
    async function fixture(maxSources: number, maxStorageBytes: number) {
      const workspaceId = randomUUID(), userId = randomUUID();
      await db.admin.query("insert into workspaces(id,name) values($1,'SYNTHETIC direct upload quota')", [workspaceId]);
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC Upload Owner',$3,'owner','customer_owner')", [userId, workspaceId, `${userId}@example.invalid`]);
      await db.admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits) values($1,true,$2,$3,100,'SYNTHETIC-DIRECT-UPLOAD','{"webchatAccess":true,"voiceAccess":true}','{"maxAreas":10,"maxWebsites":5,"maxScansPerMonth":5,"maxUsers":20,"maxAssistants":20}')`, [workspaceId, maxSources, maxStorageBytes]);
      const owner: AppSession = { authenticated: true, userId, workspaceId, workspaceName: "SYNTHETIC", name: "Owner", email: `${userId}@example.invalid`, role: "owner", permissions: getRolePermissions("owner"), productRole: "customer_owner", productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" };
      const area = await repository.createKnowledgeArea(owner, { name: "SYNTHETIC Direct Upload", kind: "company" }, options);
      return { owner, area };
    }
    function reservation(owner: AppSession, areaId: string, sizeBytes: number, changes: Partial<KnowledgeDocumentUploadMetadata> = {}): VerifiedKnowledgeDocumentUpload {
      const uploadId = randomUUID(), expiresAt = Date.now() + 60_000;
      return {
        uploadId, expiresAt, pathname: `${owner.workspaceId}/knowledge-staging-${owner.userId}/${expiresAt}-${uploadId}.txt`,
        metadata: { areaId, name: "SYNTHETIC document", fileName: "synthetic.txt", mimeType: "text/plain", sizeBytes, sha256: "a".repeat(64), ...changes },
      };
    }
    const fingerprint = createHash("sha256").update("SYNTHETIC private test store").digest("hex");

    await t.test("concurrent prepares reserve a single remaining source slot and block multipart bypass", async () => {
      const { owner, area } = await fixture(1, 1_000_000);
      const uploads = [reservation(owner, area.id, 60), reservation(owner, area.id, 60)];
      const outcomes = await Promise.allSettled(uploads.map((upload) => repository.reserveKnowledgeDocumentUpload(owner, upload, fingerprint, options)));
      assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = outcomes.find((result): result is PromiseRejectedResult => result.status === "rejected");
      assert.ok(rejected && code("LIMIT_EXCEEDED")(rejected.reason));
      await assert.rejects(repository.importKnowledgeDocument(owner, { areaId: area.id, file: new File(["SYNTHETIC no bypass"], "another.txt", { type: "text/plain" }) }, options), code("LIMIT_EXCEEDED"));
      const rows = await db.admin.query("select count(*)::int as count from audit_logs where workspace_id=$1 and action='knowledge.document.upload_reserved'", [owner.workspaceId]);
      assert.equal(rows.rows[0].count, 1);
      assert.equal((await repository.loadKnowledgeCenter(owner, options)).usage.sources, 0);
    });

    await t.test("storage reservations survive expiry until confirmed cleanup and stay tenant isolated", async () => {
      const { owner, area } = await fixture(20, 100);
      const foreign = await fixture(20, 100);
      const uploads = [reservation(owner, area.id, 60), reservation(owner, area.id, 60)];
      const outcomes = await Promise.allSettled(uploads.map((upload) => repository.reserveKnowledgeDocumentUpload(owner, upload, fingerprint, options)));
      assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
      const index = outcomes.findIndex((result) => result.status === "fulfilled"), pending = uploads[index];
      const rejected = outcomes.find((result): result is PromiseRejectedResult => result.status === "rejected");
      assert.ok(rejected && code("LIMIT_EXCEEDED")(rejected.reason));
      await repository.releaseKnowledgeDocumentUpload(owner, pending.uploadId, options);
      assert.deepEqual(await repository.expiredKnowledgeDocumentUploads(owner, options), []);
      await assert.rejects(repository.importKnowledgeDocument(owner, { areaId: area.id, file: new File(["x".repeat(41)], "over-quota.txt", { type: "text/plain" }) }, options), code("LIMIT_EXCEEDED"));
      const now = t.mock.method(Date, "now", () => pending.expiresAt + 60_001);
      try {
        assert.equal((await repository.expiredKnowledgeDocumentUploads(owner, options))[0].uploadId, pending.uploadId);
        assert.deepEqual(await repository.expiredKnowledgeDocumentUploads(foreign.owner, options), []);
        await repository.releaseKnowledgeDocumentUpload(foreign.owner, pending.uploadId, options);
        assert.equal((await repository.expiredKnowledgeDocumentUploads(owner, options)).length, 1);
        await assert.rejects(repository.reserveKnowledgeDocumentUpload(owner, reservation(owner, area.id, 41), fingerprint, options), code("LIMIT_EXCEEDED"));
        await assert.rejects(repository.releaseKnowledgeDocumentUpload(owner, pending.uploadId, options), code("DOCUMENT_UNAVAILABLE"));
        await assert.rejects(repository.releaseKnowledgeDocumentUpload(owner, pending.uploadId, options, async () => { throw new Error("SYNTHETIC private storage deletion failed"); }), /private storage deletion failed/);
        assert.equal((await repository.expiredKnowledgeDocumentUploads(owner, options)).length, 1);
        const simulatedPrivateStore = new Map([[pending.pathname, Buffer.alloc(60)]]);
        await repository.releaseKnowledgeDocumentUpload(owner, pending.uploadId, options, async (upload) => {
          assert.equal(upload.pathname, pending.pathname);
          assert.equal(simulatedPrivateStore.delete(upload.pathname), true);
          assert.equal(simulatedPrivateStore.has(upload.pathname), false);
        });
        assert.deepEqual(await repository.expiredKnowledgeDocumentUploads(owner, options), []);
        await repository.reserveKnowledgeDocumentUpload(owner, reservation(owner, area.id, 100), fingerprint, options);
      } finally { now.mock.restore(); }
      const releaseRows = await db.admin.query("select workspace_id::text as workspace from audit_logs where entity_id=$1 and action='knowledge.document.upload_released'", [pending.uploadId]);
      assert.deepEqual(releaseRows.rows, [{ workspace: owner.workspaceId }]);
    });

    await t.test("extracted text cannot consume another upload's reserved byte budget", async () => {
      const { owner, area } = await fixture(20, 100);
      await repository.reserveKnowledgeDocumentUpload(owner, reservation(owner, area.id, 60), fingerprint, options);
      // Raw bytes fit, but raw + extracted text + '{}' + pending = 102 bytes.
      await assert.rejects(repository.importKnowledgeDocument(owner, {
        areaId: area.id, file: new File(["x".repeat(20)], "over-text-budget.txt", { type: "text/plain" }),
      }, options), code("LIMIT_EXCEEDED"));
      assert.equal((await repository.loadKnowledgeCenter(owner, options)).usage.storageBytes, 0);
      assert.equal((await db.admin.query("select count(*)::int as count from media_assets where workspace_id=$1", [owner.workspaceId])).rows[0].count, 0);
      // The neighboring valid boundary includes both text and the reservation.
      await repository.importKnowledgeDocument(owner, {
        areaId: area.id, file: new File(["x".repeat(19)], "fits-text-budget.txt", { type: "text/plain" }),
      }, options);
      assert.equal((await repository.loadKnowledgeCenter(owner, options)).usage.storageBytes, 40);
      await assert.rejects(repository.reserveKnowledgeDocumentUpload(owner, reservation(owner, area.id, 1), fingerprint, options), code("LIMIT_EXCEEDED"));
    });

    await t.test("replacement at source quota keeps active approval and replays after staging removal", async () => {
      const { owner, area } = await fixture(1, 1_000_000);
      const first = await repository.importKnowledgeDocument(owner, { areaId: area.id, file: new File(["SYNTHETIC approved earlier bytes"], "earlier.txt", { type: "text/plain" }) }, options);
      const published = await repository.publishKnowledgeSource(owner, { sourceId: first.source.id, versionId: first.source.draftVersionId!, expectedVersion: first.source.revision }, options);
      const bytes = Buffer.from("SYNTHETIC replacement after private transport");
      const pending = reservation(owner, area.id, bytes.length, { sourceId: first.source.id, expectedVersion: published.revision, sha256: createHash("sha256").update(bytes).digest("hex") });
      await repository.reserveKnowledgeDocumentUpload(owner, pending, fingerprint, options);
      assert.equal(await repository.findKnowledgeDocumentImport(owner, pending.metadata, options), null);
      const simulatedPrivateStore = new Map([[pending.pathname, bytes]]);
      const imported = await repository.importKnowledgeDocument(owner, { ...pending.metadata, uploadReservationId: pending.uploadId, file: new File([bytes], pending.metadata.fileName, { type: pending.metadata.mimeType }) }, options);
      assert.equal(imported.source.approvedVersionId, published.approvedVersionId);
      assert.equal(imported.source.version?.content, bytes.toString());
      assert.equal((await repository.loadKnowledgeCenter(owner, options)).usage.sources, 1);
      simulatedPrivateStore.delete(pending.pathname);
      const replay = await repository.findKnowledgeDocumentImport(owner, pending.metadata, options);
      assert.ok(replay);
      assert.equal(replay.reused, true);
      assert.equal(replay.asset.id, imported.asset.id);
      assert.equal(replay.source.version?.id, imported.source.version?.id);
      assert.equal(simulatedPrivateStore.size, 0);
      const foreign = await fixture(1, 1_000_000);
      await assert.rejects(repository.findKnowledgeDocumentImport(foreign.owner, pending.metadata, options), code("NOT_FOUND"));
    });

    await t.test("cleanup of a committed private media path releases the reservation without deleting the document", async () => {
      const { owner, area } = await fixture(1, 1_000_000);
      const pending = reservation(owner, area.id, 60), assetId = randomUUID();
      await repository.reserveKnowledgeDocumentUpload(owner, pending, fingerprint, options);
      await withCrmRead(owner, (tx) => tx.execute(`insert into media_assets(id,workspace_id,name,original_name,folder,mime_type,size_bytes,url,relative_path,storage_provider,storage_access,is_public,public_token) values($1,$2,'SYNTHETIC committed upload','synthetic.txt',$3,'text/plain',60,$4,$5,'vercel-blob','private',false,null)`, [assetId, owner.workspaceId, `knowledge-private-${owner.userId}`, `/api/media/files/${assetId}`, pending.pathname]), options);
      // Atomic finalization leaves media metadata at this exact private pathname.
      // A subsequent reservation must not count the same bytes or slot twice.
      await repository.reserveKnowledgeDocumentUpload(owner, reservation(owner, area.id, 60), fingerprint, options);
      const now = t.mock.method(Date, "now", () => pending.expiresAt + 60_001);
      let discarded = false;
      try {
        await repository.releaseKnowledgeDocumentUpload(owner, pending.uploadId, options, async () => { discarded = true; });
        assert.equal(discarded, false);
        assert.ok(!(await repository.expiredKnowledgeDocumentUploads(owner, options)).some((upload) => upload.uploadId === pending.uploadId));
      } finally { now.mock.restore(); }
      assert.equal((await db.admin.query("select count(*)::int as count from media_assets where id=$1", [assetId])).rows[0].count, 1);
    });
  } finally {
    await closeLocalTestPool();
    await db.stop();
    await rm(mediaRoot, { recursive: true, force: true });
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});

test("private direct-upload tickets constrain one actor, tenant, immutable object and exact document bytes", async (t) => {
  const environmentKeys = ["NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN", "BLOB_PRIVATE_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN"];
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const privateProviderToken = "vercel_blob_rw_syntheticstore_SYNTHETICONLY";
  for (const key of environmentKeys) delete process.env[key];
  Object.assign(process.env, { NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN: privateProviderToken });
  try {
    const upload = await import("../src/lib/knowledge-center/document-upload");
    const session = { userId: randomUUID(), workspaceId: randomUUID() };
    const bytes = Buffer.from("SYNTHETIC direct private document");
    const metadata = {
      areaId: randomUUID(), name: "SYNTHETIC document", fileName: "synthetic.txt", mimeType: "text/plain",
      sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const rejectKnowledge = (error: unknown) => error instanceof KnowledgeCenterError;

    await t.test("metadata rejects unsupported files, invalid byte budgets and forged relationships", () => {
      assert.deepEqual(upload.parseKnowledgeDocumentUploadMetadata(metadata), metadata);
      assert.equal(upload.parseKnowledgeDocumentUploadMetadata({ ...metadata, sizeBytes: applicationMaximumBytes }).sizeBytes, applicationMaximumBytes);
      for (const changes of [
        { sizeBytes: 0 }, { sizeBytes: -1 }, { sizeBytes: 1.5 }, { sizeBytes: Infinity }, { sizeBytes: applicationMaximumBytes + 1 },
        { sha256: "a".repeat(63) }, { sha256: "g".repeat(64) }, { fileName: "../foreign.txt" },
        { fileName: "synthetic.pdf" }, { fileName: "active.svg", mimeType: "image/svg+xml" }, { areaId: "foreign" },
        { sourceId: randomUUID() }, { expectedVersion: 1 },
      ]) {
        assert.throws(() => upload.parseKnowledgeDocumentUploadMetadata({ ...metadata, ...changes }), rejectKnowledge, JSON.stringify(changes));
      }
      const replacement = { ...metadata, sourceId: randomUUID(), expectedVersion: 3 };
      assert.deepEqual(upload.parseKnowledgeDocumentUploadMetadata(replacement), replacement);
    });

    await t.test("provider token allows only one bounded path and cannot overwrite staged bytes", async () => {
      const before = Date.now();
      const issued = await upload.createKnowledgeDocumentUploadTicket(session, metadata);
      const decoded = getPayloadFromClientToken(issued.clientToken);
      const verified = upload.verifyKnowledgeDocumentUploadTicket(session, issued.ticket);
      assert.equal(decoded.pathname, issued.pathname);
      assert.ok(issued.pathname.includes(session.workspaceId));
      assert.ok(issued.pathname.includes(session.userId));
      assert.equal(decoded.maximumSizeInBytes, metadata.sizeBytes);
      assert.deepEqual(decoded.allowedContentTypes, [metadata.mimeType]);
      assert.equal(decoded.allowOverwrite, false);
      assert.equal(decoded.addRandomSuffix, false);
      assert.ok(decoded.validUntil > before && decoded.validUntil <= before + 5 * 60_000 + 1_000);
      assert.deepEqual(verified.metadata, metadata);
      assert.equal(verified.pathname, issued.pathname);
      assert.ok(verified.expiresAt >= decoded.validUntil);
      assert.notEqual(issued.clientToken, privateProviderToken);
      assert.ok(!JSON.stringify(issued).includes(privateProviderToken));
      const repeated = await upload.createKnowledgeDocumentUploadTicket(session, metadata);
      assert.notEqual(repeated.pathname, issued.pathname, "new staging requests cannot replace an earlier immutable object");
    });

    await t.test("tampered, cross-tenant, cross-actor and expired tickets fail before file reads", async () => {
      const issued = await upload.createKnowledgeDocumentUploadTicket(session, metadata);
      assert.throws(() => upload.verifyKnowledgeDocumentUploadTicket({ ...session, workspaceId: randomUUID() }, issued.ticket), rejectKnowledge);
      assert.throws(() => upload.verifyKnowledgeDocumentUploadTicket({ ...session, userId: randomUUID() }, issued.ticket), rejectKnowledge);
      const parts = issued.ticket.split(".");
      const last = parts[parts.length - 1];
      parts[parts.length - 1] = (last[0] === "A" ? "B" : "A") + last.slice(1);
      assert.throws(() => upload.verifyKnowledgeDocumentUploadTicket(session, parts.join(".")), rejectKnowledge);
      for (const ticket of [null, "", "garbage", issued.ticket + ".suffix"]) assert.throws(() => upload.verifyKnowledgeDocumentUploadTicket(session, ticket), rejectKnowledge);
      const expiry = upload.verifyKnowledgeDocumentUploadTicket(session, issued.ticket).expiresAt;
      const now = t.mock.method(Date, "now", () => expiry + 1);
      try { assert.throws(() => upload.verifyKnowledgeDocumentUploadTicket(session, issued.ticket), rejectKnowledge); }
      finally { now.mock.restore(); }
    });

    await t.test("ticket purpose and storage reference remain bound after authenticated decryption", async () => {
      const issued = await upload.createKnowledgeDocumentUploadTicket(session, metadata);
      const claims = decryptAuthValue<Record<string, unknown>>(issued.ticket);
      assert.ok(claims);
      for (const changes of [
        { purpose: "other-auth-value" },
        { pathname: `${session.workspaceId}/../foreign/private.txt` },
        { pathname: issued.pathname.replace(session.workspaceId, randomUUID()) },
        { expiresAt: Date.now() + 10 * 60_000 },
      ]) assert.throws(() => upload.verifyKnowledgeDocumentUploadTicket(session, encryptAuthValue({ ...claims, ...changes })), rejectKnowledge);
      const verified = upload.verifyKnowledgeDocumentUploadTicket(session, issued.ticket);
      await assert.rejects(upload.readKnowledgeDocumentUpload({ ...verified }), rejectKnowledge);
      await upload.discardKnowledgeDocumentUpload({ ...verified });
    });

    await t.test("a public storage credential never substitutes for the private provider", async () => {
      delete process.env.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN;
      process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_publicstore_SYNTHETICONLY";
      try { await assert.rejects(upload.createKnowledgeDocumentUploadTicket(session, metadata), rejectKnowledge); }
      finally { process.env.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN = privateProviderToken; }
    });

    await t.test("same-store key rotation preserves bounded tickets and expired cleanup while another store is rejected", async () => {
      const issued = await upload.createKnowledgeDocumentUploadTicket(session, metadata);
      const claims = decryptAuthValue<Record<string, unknown>>(issued.ticket);
      assert.ok(claims);
      const verified = upload.verifyKnowledgeDocumentUploadTicket(session, issued.ticket);
      const rotated = "vercel_blob_rw_syntheticstore_ROTATEDSYNTHETICONLY";
      process.env.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN = rotated;
      try {
        assert.equal(upload.verifyKnowledgeDocumentUploadTicket(session, issued.ticket).pathname, issued.pathname);
        assert.equal(upload.knowledgeDocumentUploadStoreFingerprint(), claims.storeFingerprint);
        const now = t.mock.method(Date, "now", () => verified.expiresAt + 60_001);
        const expired = { uploadId: verified.uploadId, pathname: verified.pathname, expiresAt: verified.expiresAt, actorId: session.userId, storeFingerprint: String(claims.storeFingerprint) };
        let deleted = false;
        try {
          await upload.discardExpiredKnowledgeDocumentUpload(session, expired, async (pathname, token) => {
            assert.equal(pathname, issued.pathname);
            assert.equal(token, rotated);
            deleted = true;
          });
          assert.equal(deleted, true);
          process.env.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_replacementstore_SYNTHETICONLY";
          deleted = false;
          await assert.rejects(upload.discardExpiredKnowledgeDocumentUpload(session, expired, async () => { deleted = true; }), rejectKnowledge);
          assert.equal(deleted, false);
        } finally { now.mock.restore(); }
        assert.throws(() => upload.verifyKnowledgeDocumentUploadTicket(session, issued.ticket), rejectKnowledge);
      }
      finally { process.env.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN = privateProviderToken; }
    });

    await t.test("finalized streams must match the bound size and SHA-256, including chunked streams", async () => {
      const stream = (chunks: Uint8Array[], onCancel?: () => void) => new ReadableStream<Uint8Array>({
        start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
        cancel: onCancel,
      });
      const actual = await upload.readKnowledgeUploadBytes(stream([bytes.subarray(0, 3), bytes.subarray(3)]), metadata);
      assert.deepEqual(Buffer.from(actual), bytes);
      await assert.rejects(upload.readKnowledgeUploadBytes(stream([bytes.subarray(1)]), metadata), rejectKnowledge);
      await assert.rejects(upload.readKnowledgeUploadBytes(stream([Buffer.alloc(bytes.length, 65)]), metadata), rejectKnowledge);
      let cancelled = false;
      const overrun = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); controller.enqueue(new Uint8Array([0])); },
        cancel() { cancelled = true; },
      });
      await assert.rejects(upload.readKnowledgeUploadBytes(overrun, metadata), rejectKnowledge);
      assert.equal(cancelled, true);
    });
  } finally {
    for (const key of environmentKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});
