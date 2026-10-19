import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { KnowledgeSource } from "../src/lib/knowledge-center/types";

type Handler = (request: Request) => Promise<Response>;

test("Knowledge HTTP handlers enforce cookie, CSRF, tenant membership, draft publication and private documents", { timeout: 240000 }, async (t) => {
  const db = await startLocalSalesDb();
  const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "knowledge-api-"));
  const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "NOVALURE_MEDIA_ROOT", "NOVALURE_DEMO_AUTH_ENABLED", "NOVALURE_TRUST_AUTH_HEADERS", "VERCEL", "VERCEL_ENV", "VERCEL_URL"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    await applySalesSchema(db);
    const owner = await seedSalesBrowser(db), foreign = await seedSalesBrowser(db);
    const secret = randomBytes(48).toString("base64url"), origin = "http://127.0.0.1:3000";
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret, NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex"), NOVALURE_MEDIA_ROOT: mediaRoot });
    const cookie = "v2." + randomBytes(32).toString("base64url"), sessionId = randomUUID();
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [sessionId, createHash("sha256").update(cookie).digest("hex"), owner.authIdentityId, owner.userId, owner.workspaceId]);
    const [snapshot, areas, sources, versions, assignments, query, publish, documents, document, scans, legacy, genericMedia] = await Promise.all([
      import("../src/app/api/knowledge-center/route"), import("../src/app/api/knowledge-center/areas/route"), import("../src/app/api/knowledge-center/sources/route"), import("../src/app/api/knowledge-center/versions/route"), import("../src/app/api/knowledge-center/assignments/route"), import("../src/app/api/knowledge-center/query/route"), import("../src/app/api/knowledge-center/publish/route"), import("../src/app/api/knowledge-center/documents/route"), import("../src/app/api/knowledge-center/sources/[sourceId]/document/route"), import("../src/app/api/knowledge-center/scans/route"), import("../src/app/api/bots/knowledge/route"), import("../src/app/api/media/files/[assetId]/route"),
    ]);
    const request = (pathname: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Request(origin + pathname, { method, headers: { cookie: "novalure_session=" + cookie, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(method === "GET" ? {} : { origin, "sec-fetch-site": "same-origin", "x-novalure-csrf-token": createCsrfToken({ method, pathname: pathname.split("?")[0], secret, sessionCookie: cookie })!.token }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    async function execute(handler: Handler, pathname: string, method: string, body?: unknown, expected = 200) {
      const response = await handler(request(pathname, method, body));
      assert.equal(response.status, expected, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      return response.json();
    }
    await t.test("no cookie, preview headers, duplicate cookies and missing CSRF cannot access handlers", async () => {
      for (const handler of [snapshot.GET, legacy.GET]) {
        const response = await handler(new Request(origin + "/api/knowledge-center"));
        assert.equal(response.status, 401);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
      }
      process.env.NOVALURE_TRUST_AUTH_HEADERS = "1";
      const preview = new Request(origin + "/api/knowledge-center", { headers: { "x-novalure-workspace-id": owner.workspaceId, "x-novalure-user-id": owner.userId, "x-novalure-role": "owner", "x-novalure-product-role": "novalureAdmin" } });
      assert.equal((await snapshot.GET(preview)).status, 401);
      delete process.env.NOVALURE_TRUST_AUTH_HEADERS;
      assert.equal((await snapshot.GET(request("/api/knowledge-center", "GET", undefined, { cookie: `novalure_session=${cookie}; novalure_session=${cookie}` }))).status, 401);
      assert.equal((await areas.POST(request("/api/knowledge-center/areas", "POST", { name: "Blocked", kind: "company" }, { "x-novalure-csrf-token": "" }))).status, 403);
    });
    await t.test("contracts are disabled by default and runtime API cannot provision them", async () => {
      assert.equal((await execute(snapshot.GET, "/api/knowledge-center", "GET")).snapshot.available, false);
      await execute(areas.POST, "/api/knowledge-center/areas", "POST", { name: "Disabled", kind: "company" }, 403);
      await execute(areas.POST, "/api/knowledge-center/areas", "POST", { name: "Denied", kind: "company", workspaceId: foreign.workspaceId }, 400);
      await db.admin.query("insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits) values($1,true,20,20000000,100,'SYNTHETIC-KNOWLEDGE-HTTP','{\"websiteImport\":true,\"webchatAccess\":true,\"voiceAccess\":true}', '{\"maxAreas\":10,\"maxWebsites\":5,\"maxScansPerMonth\":5,\"maxUsers\":20,\"maxAssistants\":20}')", [owner.workspaceId]);
    });
    let areaId: string, source: KnowledgeSource;
    const botId = randomUUID();
    await t.test("drafts are isolated from channel retrieval until current-version admin publication", async () => {
      areaId = (await execute(areas.POST, "/api/knowledge-center/areas", "POST", { name: "SYNTHETIC Company", kind: "company" }, 201)).area.id;
      const areaChanges = await import("../src/app/api/knowledge-center/areas/[areaId]/route");
      const updatedArea = await execute((req) => areaChanges.PATCH(req, { params: Promise.resolve({ areaId }) }), "/api/knowledge-center/areas/" + areaId, "PATCH", { action: "update", name: "SYNTHETIC Company updated", description: "Updated through authenticated HTTP" });
      assert.equal(updatedArea.area.name, "SYNTHETIC Company updated");
      source = (await execute(sources.POST, "/api/knowledge-center/sources", "POST", { areaId, name: "SYNTHETIC FAQ", type: "manual", content: "The synthetic delivery window is Tuesday." }, 201)).source;
      assert.equal(source.approvedVersionId, null);
      await db.admin.query("insert into bots(id,workspace_id,project_id,name,role) values($1,$2,$3,'SYNTHETIC HTTP Bot','Support')", [botId, owner.workspaceId, owner.projectId]);
      await execute(assignments.POST, "/api/knowledge-center/assignments", "POST", { botId, channel: "webchat", areaIds: [areaId] });
      assert.equal((await execute(query.POST, "/api/knowledge-center/query", "POST", { query: "Tuesday", botId, channel: "webchat" })).grounded, false);
      source = (await execute(publish.POST, "/api/knowledge-center/publish", "POST", { sourceId: source.id, versionId: source.draftVersionId, expectedVersion: source.revision })).source;
      assert.equal((await execute(query.POST, "/api/knowledge-center/query", "POST", { query: "Tuesday", botId, channel: "webchat" })).matches[0].sourceId, source.id);
      assert.equal((await execute(query.POST, "/api/knowledge-center/query", "POST", { query: "Tuesday", botId, channel: "whatsapp" })).grounded, false);
      await execute(legacy.GET, "/api/bots/knowledge?query=Tuesday", "GET", undefined, 400);
      await execute(legacy.POST, "/api/bots/knowledge", "POST", { areaId, title: "SYNTHETIC legacy", contentOrLocation: "Tuesday", approval: "approved" }, 400);
      const draft = (await execute(versions.POST, "/api/knowledge-center/versions", "POST", { sourceId: source.id, expectedVersion: source.revision, content: "The synthetic delivery window is Thursday." }, 201)).source as KnowledgeSource;
      assert.equal((await execute(query.POST, "/api/knowledge-center/query", "POST", { query: "Thursday", botId, channel: "webchat" })).grounded, false);
      assert.equal((await execute(versions.GET, "/api/knowledge-center/versions?sourceId=" + source.id, "GET")).versions.length, 2);
      await execute(versions.POST, "/api/knowledge-center/versions", "POST", { sourceId: source.id, expectedVersion: source.revision, content: "Stale" }, 409);
      source = draft;
    });
    await t.test("HTTP channel gates deny voice independently while webchat remains grounded", async () => {
      await db.admin.query(`update knowledge_center_entitlements set features=features||'{"voiceAccess":false}'::jsonb where workspace_id=$1`, [owner.workspaceId]);
      try {
        const denied = await execute(query.POST, "/api/knowledge-center/query", "POST", { query: "Tuesday", botId, channel: "voice" }, 403);
        assert.equal(denied.code, "ENTITLEMENT_REQUIRED");
        assert.match(denied.error, /Telefonassistent/);
        assert.equal((await execute(query.POST, "/api/knowledge-center/query", "POST", { query: "Tuesday", botId, channel: "webchat" })).grounded, true);
        await execute(assignments.POST, "/api/knowledge-center/assignments", "POST", { botId, channel: "voice", areaIds: [areaId] }, 403);
        await execute(assignments.POST, "/api/knowledge-center/assignments", "POST", { botId, channel: "voice", areaIds: [] });
      } finally { await db.admin.query(`update knowledge_center_entitlements set features=features||'{"voiceAccess":true}'::jsonb where workspace_id=$1`, [owner.workspaceId]); }
    });
    await t.test("streamed byte limits, malformed JSON and client-selected tenants fail without writes", async () => {
      const pathname = "/api/knowledge-center/sources";
      const base = request(pathname, "POST", {});
      base.headers.set("content-length", "1");
      const oversized = new Request(base.url, { method: "POST", headers: base.headers, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(270000))); controller.close(); } }), duplex: "half" } as RequestInit);
      assert.equal((await sources.POST(oversized)).status, 413);
      const invalid = request(pathname, "POST", {});
      assert.equal((await sources.POST(new Request(invalid.url, { method: "POST", headers: invalid.headers, body: "{" }))).status, 400);
      await execute(snapshot.GET, "/api/knowledge-center?workspaceId=" + owner.workspaceId + "&workspaceId=" + foreign.workspaceId, "GET", undefined, 400);
      await execute(snapshot.GET, "/api/knowledge-center?workspaceId=" + foreign.workspaceId, "GET", undefined, 403);
      await execute(sources.POST, pathname, "POST", { areaId: randomUUID(), name: "Foreign", type: "manual", content: "no access" }, 404);
      const headerAttempt = await snapshot.GET(request("/api/knowledge-center", "GET", undefined, { "x-novalure-workspace-id": foreign.workspaceId, "x-novalure-user-id": foreign.userId }));
      assert.equal((await headerAttempt.json()).snapshot.workspace.id, owner.workspaceId);
      const once = request("/api/knowledge-center/areas", "POST", { name: "SYNTHETIC CSRF once", kind: "business" }), replay = once.clone();
      assert.equal((await areas.POST(once)).status, 201);
      assert.equal((await areas.POST(replay)).status, 403);
    });
    await t.test("workspace selection requires explicit membership and preserves the target role", async () => {
      const targetMemberId = randomUUID();
      await db.admin.query("insert into workspace_users(id,workspace_id,auth_identity_id,name,email,role,product_role,status) values($1,$2,$3,'SYNTHETIC target operator',$4,'agent','novalure_operator','active')", [targetMemberId, foreign.workspaceId, owner.authIdentityId, owner.email]);
      const pathname = "/api/knowledge-center?workspaceId=" + foreign.workspaceId;
      const selected = (await execute(snapshot.GET, pathname, "GET")).snapshot;
      assert.equal(selected.workspace.id, foreign.workspaceId);
      assert.equal(selected.permissions.canPublish, false);
      assert.equal(selected.permissions.canWrite, true);
      const audits = await db.admin.query("select count(*) from audit_logs where workspace_id=$1 and actor_user_id=$2 and action='workspace.cross_workspace_view'", [foreign.workspaceId, targetMemberId]);
      assert.ok(Number(audits.rows[0].count) >= 1);
      await execute(versions.GET, "/api/knowledge-center/versions?sourceId=" + source.id + "&workspaceId=" + foreign.workspaceId, "GET", undefined, 403);
      await db.admin.query("update workspace_users set status='invited' where id=$1", [targetMemberId]);
      await execute(snapshot.GET, pathname, "GET", undefined, 403);
    });
    await t.test("documents use private upload and source authorization; generic media delivery denies", async () => {
      const uploadPath = "/api/knowledge-center/documents";
      const form = new FormData();
      form.set("file", new File(["%PDF-1.7\nSYNTHETIC PRIVATE DOCUMENT\n%%EOF"], "synthetic.pdf", { type: "application/pdf" }));
      form.set("areaId", areaId);
      const headers = new Headers(request(uploadPath, "POST").headers);
      headers.delete("content-type");
      const uploaded = await documents.POST(new Request(origin + uploadPath, { method: "POST", headers, body: form }));
      assert.equal(uploaded.status, 201, await uploaded.clone().text());
      const importResult = await uploaded.json();
      const asset = importResult.asset;
      assert.equal(asset.url, undefined);
      const fileSource = importResult.source as KnowledgeSource;
      assert.equal(fileSource.version?.processingStatus, "failed");
      const pathname = `/api/knowledge-center/sources/${fileSource.id}/document`;
      const delivered = await document.GET(request(pathname), { params: Promise.resolve({ sourceId: fileSource.id }) });
      assert.equal(delivered.status, 200, await delivered.clone().text());
      assert.match(delivered.headers.get("content-disposition") ?? "", /attachment/);
      assert.match(await delivered.text(), /SYNTHETIC PRIVATE DOCUMENT/);
      const generic = await genericMedia.GET(request("/api/media/files/" + asset.id), { params: Promise.resolve({ assetId: asset.id }) });
      assert.equal(generic.status, 404);
      const missing = await document.GET(request("/api/knowledge-center/sources/" + randomUUID() + "/document"), { params: Promise.resolve({ sourceId: randomUUID() }) });
      assert.equal(missing.status, 404);
    });
    await t.test("website URL comes from authorized source and unsafe hosts never become draft content", async () => {
      const urlSource = (await execute(sources.POST, "/api/knowledge-center/sources", "POST", { areaId, name: "SYNTHETIC denied website", type: "url", url: "https://127.0.0.1/private" }, 201)).source as KnowledgeSource;
      await execute(scans.POST, "/api/knowledge-center/scans", "POST", { sourceId: urlSource.id, expectedVersion: urlSource.revision, url: "https://example.com" }, 400);
      await execute(scans.POST, "/api/knowledge-center/scans", "POST", { sourceId: urlSource.id, expectedVersion: urlSource.revision + 1 }, 409);
      assert.equal(Number((await db.admin.query("select scan_count from knowledge_query_usage where workspace_id=$1", [owner.workspaceId])).rows[0].scan_count), 0);
      await execute(scans.POST, "/api/knowledge-center/scans", "POST", { sourceId: urlSource.id, expectedVersion: urlSource.revision }, 422);
      assert.equal(Number((await db.admin.query("select count(*) from knowledge_source_versions where source_id=$1", [urlSource.id])).rows[0].count), 1);
    });
    await t.test("current role restricts publication and session revocation ends all knowledge access", async () => {
      await db.admin.query("update workspace_users set role='agent',product_role='novalure_operator' where id=$1", [owner.userId]);
      await execute(publish.POST, "/api/knowledge-center/publish", "POST", { sourceId: source.id, versionId: source.draftVersionId, expectedVersion: source.revision }, 403);
      await execute(assignments.POST, "/api/knowledge-center/assignments", "POST", { botId, channel: "webchat", areaIds: [areaId] }, 403);
      await db.admin.query("update auth_sessions set revoked_at=now(),revoked_reason='SYNTHETIC HTTP test' where id=$1", [sessionId]);
      await execute(snapshot.GET, "/api/knowledge-center", "GET", undefined, 401);
    });
  } finally {
    await closeLocalTestPool();
    await db.stop();
    await rm(mediaRoot, { recursive: true, force: true });
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  }
});
