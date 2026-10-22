import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction } from "../src/lib/db/tenant-client";
import type { TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { archiveKnowledgeArea, archiveKnowledgeSource, assignKnowledgeAreas, createKnowledgeArea, createKnowledgeSource, getKnowledgeDocument, getKnowledgeScanSource, listKnowledgeVersions, loadKnowledgeCenter, publishKnowledgeSource, queryKnowledgeCenter, updateKnowledgeSource } from "../src/lib/knowledge-center/repository";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const ids = { tenant: randomUUID(), otherTenant: randomUUID(), owner: randomUUID(), staff: randomUUID(), assistant: randomUUID(), otherOwner: randomUUID(), project: randomUUID(), hiddenProject: randomUUID(), otherProject: randomUUID(), bot: randomUUID(), otherBot: randomUUID() };
function session(actor: "owner" | "staff" | "assistant" | "otherOwner"): AppSession {
  const role = actor === "staff" ? "agent" : actor === "assistant" ? "assistant" : "owner";
  const productRole = actor === "staff" ? "project_sales_member" : actor === "assistant" ? "assistant_backoffice" : "customer_owner";
  return { authenticated: true, userId: ids[actor], workspaceId: actor === "otherOwner" ? ids.otherTenant : ids.tenant, workspaceName: "SYNTHETIC Knowledge tenant", email: `${actor}@example.invalid`, name: "SYNTHETIC", role, permissions: getRolePermissions(role), productRole, productPermissions: getProductRoleCapabilities(productRole), source: "database" };
}
const errorCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

test("Knowledge Center real PostgreSQL: forced RLS, approved-only grants, retained quotas and atomic audit", { timeout: 180000 }, async t => {
  const db = await startLocalSalesDb();
  const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
  try {
    // Explicit sales fixture limitations: historical optional vector column/index
    // substituted; manual production cutovers excluded. 101 runs unchanged.
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    const sql = await readFile("migrations/101_knowledge_center.sql", "utf8");
    const migrationOwner = `knowledge_owner_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await db.admin.query(`create role ${migrationOwner} nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication`);
    await db.admin.query(`grant usage,create on schema public to ${migrationOwner}`);
    await db.admin.query(`grant all on all tables in schema public to ${migrationOwner}`);
    // Actual production-style owner: FORCE RLS still applies inside definers.
    for (const table of ["knowledge_sources", "knowledge_chunks", "projects", "bots", "media_assets", "media_asset_shares", "workspace_module_settings", "bot_conversations", "bot_messages", "bot_tool_calls"]) await db.admin.query(`alter table ${table} owner to ${migrationOwner}`);
    const migrationClient = await db.admin.connect();
    try {
      await migrationClient.query("begin");
      await migrationClient.query(`set local role ${migrationOwner}`);
      await migrationClient.query(sql);
      await migrationClient.query(await readFile("migrations/102_knowledge_document_processing.sql", "utf8"));
      await migrationClient.query(await readFile("migrations/108_knowledge_connected_assistant_quota.sql", "utf8"));
      await migrationClient.query("commit");
    } catch (error) { await migrationClient.query("rollback"); throw error; } finally { migrationClient.release(); }
    await db.admin.query(`insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Knowledge','managed_by_novalure'),($2,'SYNTHETIC other Knowledge','managed_by_novalure')`, [ids.tenant, ids.otherTenant]);
    for (const actor of ["owner", "staff", "assistant", "otherOwner"] as const) {
      const member = session(actor);
      await db.admin.query(`insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC',$3,$4,$5)`, [member.userId, member.workspaceId, member.email, member.role, member.productRole]);
    }
    await db.admin.query(`insert into projects(id,workspace_id,name,type) values($1,$4,'SYNTHETIC accessible','Bauträger'),($2,$4,'SYNTHETIC hidden','Bauträger'),($3,$5,'SYNTHETIC foreign','Bauträger')`, [ids.project, ids.hiddenProject, ids.otherProject, ids.tenant, ids.otherTenant]);
    await db.admin.query(`insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true),($1,$2,$4,true,false)`, [ids.tenant, ids.project, ids.staff, ids.assistant]);
    await db.admin.query(`insert into bots(id,workspace_id,project_id,name,role) values($1,$3,$4,'SYNTHETIC project bot','advisor'),($2,$5,$6,'SYNTHETIC foreign bot','advisor')`, [ids.bot, ids.otherBot, ids.tenant, ids.project, ids.otherTenant, ids.otherProject]);
    const owner = session("owner"), staff = session("staff"), assistant = session("assistant"), otherOwner = session("otherOwner");
    await t.test("default commercial state is disabled and client role fields cannot enable it", async () => {
      assert.equal((await loadKnowledgeCenter(owner, options)).available, false);
      await assert.rejects(createKnowledgeArea(owner, { name: "SYNTHETIC unavailable", kind: "company" }, options), errorCode("ENTITLEMENT_REQUIRED"));
      await assert.rejects(db.pool.query(`insert into knowledge_center_entitlements(workspace_id,enabled) values($1,false)`, [ids.tenant]), errorCode("42501"));
    });
    for (const workspace of [ids.tenant, ids.otherTenant]) await db.admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits) values($1,true,100,20000000,100,'SYNTHETIC-CONTRACT-NOT-COMMERCIAL','{"websiteImport":true,"webchatAccess":true,"voiceAccess":true}'::jsonb,'{"maxAreas":100,"maxWebsites":10,"maxScansPerMonth":5,"maxUsers":10,"maxAssistants":10}'::jsonb)`, [workspace]);
    const company = await createKnowledgeArea(owner, { name: "SYNTHETIC company", kind: "company" }, options);
    const project = await createKnowledgeArea(owner, { name: "SYNTHETIC project", kind: "project", projectId: ids.project }, options);
    const hidden = await createKnowledgeArea(owner, { name: "SYNTHETIC hidden project", kind: "project", projectId: ids.hiddenProject }, options);
    const foreignArea = await createKnowledgeArea(otherOwner, { name: "SYNTHETIC other company", kind: "company" }, options);
    let companySource = await createKnowledgeSource(staff, { areaId: company.id, name: "SYNTHETIC operating hours", type: "faq", content: "SYNTHETIC office opens at 09:00; mango code ALPHA." }, options);
    let projectSource = await createKnowledgeSource(staff, { areaId: project.id, name: "SYNTHETIC project guide", type: "structured", structuredData: { guide: "SYNTHETIC project mango ALPHA" } }, options);
    const hiddenSource = await createKnowledgeSource(owner, { areaId: hidden.id, name: "SYNTHETIC secret project", type: "manual", content: "SYNTHETIC hidden pineapple" }, options);
    await t.test("staff draft foundation and inaccessible project/source/tenant denial", async () => {
      assert.equal(companySource.version?.status, "draft");
      assert.equal((await queryKnowledgeCenter(assistant, { query: "mango" }, options)).matches.length, 0);
      assert.equal((await loadKnowledgeCenter(assistant, options)).sources.length, 0);
      await assert.rejects(listKnowledgeVersions(assistant, { sourceId: companySource.id }, options), errorCode("NOT_FOUND"));
      await assert.rejects(createKnowledgeSource(staff, { areaId: hidden.id, name: "SYNTHETIC forbidden", type: "manual", content: "never" }, options));
      await assert.rejects(createKnowledgeSource(owner, { areaId: foreignArea.id, name: "SYNTHETIC forbidden", type: "manual", content: "never" }, options), errorCode("NOT_FOUND"));
      await assert.rejects(publishKnowledgeSource(staff, { sourceId: companySource.id, versionId: companySource.draftVersionId!, expectedVersion: companySource.revision }, options), errorCode("FORBIDDEN"));
      await assert.rejects(createKnowledgeArea(assistant, { name: "SYNTHETIC forbidden", kind: "business" }, options), errorCode("FORBIDDEN"));
    });
    companySource = await publishKnowledgeSource(owner, { sourceId: companySource.id, versionId: companySource.draftVersionId!, expectedVersion: companySource.revision }, options);
    projectSource = await publishKnowledgeSource(owner, { sourceId: projectSource.id, versionId: projectSource.draftVersionId!, expectedVersion: projectSource.revision }, options);
    await publishKnowledgeSource(owner, { sourceId: hiddenSource.id, versionId: hiddenSource.draftVersionId!, expectedVersion: hiddenSource.revision }, options);
    await t.test("bot/channel grants are explicit and project grants remain required", async () => {
      assert.equal((await queryKnowledgeCenter(assistant, { query: "mango", botId: ids.bot, channel: "webchat" }, options)).matches.length, 0);
      await assignKnowledgeAreas(owner, { botId: ids.bot, channel: "webchat", areaIds: [company.id, project.id] }, options);
      assert.equal((await queryKnowledgeCenter(assistant, { query: "mango", botId: ids.bot, channel: "webchat" }, options)).matches.length, 2);
      assert.equal((await queryKnowledgeCenter(assistant, { query: "mango", botId: ids.bot, channel: "whatsapp" }, options)).matches.length, 0);
      await assert.rejects(assignKnowledgeAreas(owner, { botId: ids.bot, channel: "webchat", areaIds: [hidden.id] }, options), errorCode("PROJECT_SCOPE_MISMATCH"));
      await assert.rejects(queryKnowledgeCenter(owner, { query: "mango", botId: ids.otherBot, channel: "webchat" }, options), errorCode("NOT_FOUND"));
      assert.equal((await queryKnowledgeCenter(assistant, { query: "pineapple" }, options)).matches.length, 0);
      const noContext = await db.pool.query("select count(*)::int as count from knowledge_sources");
      assert.equal(noContext.rows[0].count, 0);
      const forced = await db.admin.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in('knowledge_sources','knowledge_chunks','knowledge_areas','knowledge_source_versions')");
      assert.equal(forced.rows.length, 4); assert.ok(forced.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
    });
    await t.test("webchat and voice plans are independent, missing flags deny and disabled assistants still permit revocation", async () => {
      try {
        await db.admin.query(`update knowledge_center_entitlements set features=features||'{"voiceAccess":false}'::jsonb where workspace_id=$1`, [ids.tenant]);
        assert.equal((await queryKnowledgeCenter(assistant, { query: "mango", botId: ids.bot, channel: "webchat" }, options)).matches.length, 2);
        for (const target of ["voice", "telephone"] as const) {
          await assert.rejects(queryKnowledgeCenter(owner, { query: "mango", botId: ids.bot, channel: target }, options), errorCode("ENTITLEMENT_REQUIRED"));
          await assert.rejects(assignKnowledgeAreas(owner, { botId: ids.bot, channel: target, areaIds: [company.id] }, options), errorCode("ENTITLEMENT_REQUIRED"));
          assert.deepEqual((await assignKnowledgeAreas(owner, { botId: ids.bot, channel: target, areaIds: [] }, options)).areaIds, []);
        }
        await db.admin.query("update knowledge_center_entitlements set features=features-'webchatAccess'-'voiceAccess' where workspace_id=$1", [ids.tenant]);
        await assert.rejects(queryKnowledgeCenter(owner, { query: "mango", botId: ids.bot, channel: "webchat" }, options), errorCode("ENTITLEMENT_REQUIRED"));
        assert.equal((await queryKnowledgeCenter(owner, { query: "mango", botId: ids.bot, channel: "email" }, options)).matches.length, 0);
        assert.equal((await queryKnowledgeCenter(owner, { query: "mango" }, options)).grounded, true);
        await db.admin.query(`update knowledge_center_entitlements set features=features||'{"webchatAccess":true,"voiceAccess":true}'::jsonb where workspace_id=$1`, [ids.tenant]);
        await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'bots',false)", [ids.tenant]);
        for (const target of ["webchat", "voice", "email"] as const) await assert.rejects(queryKnowledgeCenter(owner, { query: "mango", botId: ids.bot, channel: target }, options), errorCode("ENTITLEMENT_REQUIRED"));
        await assert.rejects(assignKnowledgeAreas(owner, { botId: ids.bot, channel: "webchat", areaIds: [company.id] }, options), errorCode("ENTITLEMENT_REQUIRED"));
        assert.deepEqual((await assignKnowledgeAreas(owner, { botId: ids.bot, channel: "webchat", areaIds: [] }, options)).areaIds, []);
        assert.equal((await queryKnowledgeCenter(owner, { query: "mango" }, options)).grounded, true);
      } finally {
        await db.admin.query(`update knowledge_center_entitlements set features=features||'{"webchatAccess":true,"voiceAccess":true}'::jsonb where workspace_id=$1`, [ids.tenant]);
        await db.admin.query("update workspace_module_settings set enabled=true where workspace_id=$1 and module_key='bots'", [ids.tenant]);
        await assignKnowledgeAreas(owner, { botId: ids.bot, channel: "webchat", areaIds: [company.id, project.id] }, options);
      }
    });
    await t.test("chat history forces saved bot/project/channel scope for messages and tools", async () => {
      const hiddenBot = randomUUID(), visibleConversation = randomUUID(), hiddenConversation = randomUUID(), foreignConversation = randomUUID();
      await db.admin.query("insert into bots(id,workspace_id,project_id,name,role) values($1,$2,$3,'SYNTHETIC hidden history bot','advisor')", [hiddenBot, ids.tenant, ids.hiddenProject]);
      await withTenantTransaction({ actorId: ids.owner, workspaceId: ids.tenant }, async tx => {
        await tx.execute("insert into bot_conversations(id,workspace_id,project_id,bot_id,metadata) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'{\"channel\":\"webchat\"}'::jsonb),($5::uuid,$2::uuid,$6::uuid,$7::uuid,'{\"channel\":\"whatsapp\"}'::jsonb)", [visibleConversation, ids.tenant, ids.project, ids.bot, hiddenConversation, ids.hiddenProject, hiddenBot]);
        await tx.execute("insert into bot_messages(workspace_id,conversation_id,role,content) values($1::uuid,$2::uuid,'assistant','SYNTHETIC visible history'),($1::uuid,$3::uuid,'assistant','SYNTHETIC hidden history')", [ids.tenant, visibleConversation, hiddenConversation]);
        await tx.execute("insert into bot_tool_calls(workspace_id,conversation_id,bot_id,tool_name) values($1::uuid,$2::uuid,$3::uuid,'SYNTHETIC visible tool')", [ids.tenant, visibleConversation, ids.bot]);
      }, options);
      await withTenantTransaction({ actorId: ids.otherOwner, workspaceId: ids.otherTenant }, async tx => {
        await tx.execute("insert into bot_conversations(id,workspace_id,project_id,bot_id,metadata) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'{\"channel\":\"webchat\"}'::jsonb)", [foreignConversation, ids.otherTenant, ids.otherProject, ids.otherBot]);
      }, options);
      await withTenantTransaction({ actorId: ids.assistant, workspaceId: ids.tenant }, async tx => {
        assert.equal((await tx.query("select id from bot_conversations")).length, 1);
        assert.equal((await tx.query("select id from bot_messages")).length, 1);
        assert.equal((await tx.query("select id from bot_tool_calls")).length, 1);
        await tx.execute("insert into bot_messages(workspace_id,conversation_id,role,content) values($1::uuid,$2::uuid,'user','SYNTHETIC authorized reply')", [ids.tenant, visibleConversation]);
      }, options);
      await assert.rejects(withTenantTransaction({ actorId: ids.owner, workspaceId: ids.tenant }, tx => tx.execute("update bot_conversations set metadata='{}'::jsonb where id=$1::uuid", [visibleConversation]), options), errorCode("42501"));
      await assert.rejects(withTenantTransaction({ actorId: ids.owner, workspaceId: ids.tenant }, tx => tx.execute("insert into bot_conversations(workspace_id,project_id,bot_id,metadata) values($1::uuid,$2::uuid,$3::uuid,'{\"channel\":\"webchat\"}'::jsonb)", [ids.tenant, ids.hiddenProject, ids.bot]), options), errorCode("42501"));
      await assert.rejects(withTenantTransaction({ actorId: ids.assistant, workspaceId: ids.tenant }, tx => tx.execute("insert into bot_messages(workspace_id,conversation_id,role,content) values($1::uuid,$2::uuid,'user','SYNTHETIC forbidden')", [ids.tenant, hiddenConversation]), options), errorCode("42501"));
      await assert.rejects(withTenantTransaction({ actorId: ids.owner, workspaceId: ids.tenant }, tx => tx.execute("insert into bot_messages(workspace_id,conversation_id,role,content) values($1::uuid,$2::uuid,'user','SYNTHETIC foreign')", [ids.tenant, foreignConversation]), options), errorCode("42501"));
      await assert.rejects(withTenantTransaction({ actorId: ids.owner, workspaceId: ids.tenant }, tx => tx.execute("insert into bot_tool_calls(workspace_id,conversation_id,bot_id,tool_name) values($1::uuid,$2::uuid,$3::uuid,'SYNTHETIC mismatched tool')", [ids.tenant, visibleConversation, hiddenBot]), options), errorCode("42501"));
    });
    await t.test("edits stay immutable drafts while previous approved content remains grounded", async () => {
      const previous = companySource;
      companySource = await updateKnowledgeSource(staff, { sourceId: companySource.id, expectedVersion: companySource.revision, name: "SYNTHETIC secret draft title", content: "SYNTHETIC dragonfruit DRAFT_ONLY" }, options);
      assert.equal((await queryKnowledgeCenter(assistant, { query: "dragonfruit" }, options)).matches.length, 0);
      const approved = await queryKnowledgeCenter(assistant, { query: "mango" }, options);
      assert.ok(approved.matches.some(row => row.sourceId === companySource.id && !row.title.includes("secret")));
      await assert.rejects(updateKnowledgeSource(staff, { sourceId: companySource.id, expectedVersion: previous.revision, content: "stale" }, options), errorCode("VERSION_CONFLICT"));
      assert.equal((await listKnowledgeVersions(owner, { sourceId: companySource.id }, options)).length, 2);
      assert.equal((await listKnowledgeVersions(assistant, { sourceId: companySource.id }, options)).length, 1);
      await withTenantTransaction({ actorId: ids.staff, workspaceId: ids.tenant }, async tx => {
        await assert.rejects(tx.execute("update knowledge_source_versions set content='tampered' where id=$1::uuid", [companySource.draftVersionId]), errorCode("42501"));
      }, options).catch(error => { if (!errorCode("42501")(error)) throw error; });
      await assert.rejects(withTenantTransaction({ actorId: ids.staff, workspaceId: ids.tenant }, tx => tx.execute("update knowledge_sources set approved_version_id=$1::uuid where id=$2::uuid", [companySource.draftVersionId, companySource.id]), options));
      await assert.rejects(withTenantTransaction({ actorId: ids.owner, workspaceId: ids.tenant }, tx => tx.execute("update knowledge_sources set approved_version_id=$1::uuid where id=$2::uuid", [companySource.draftVersionId, companySource.id]), options), errorCode("23514"));
      await assert.rejects(withTenantTransaction({ actorId: ids.owner, workspaceId: ids.tenant }, tx => tx.execute("insert into knowledge_area_grants(workspace_id,bot_id,area_id,channel,created_by) values($1::uuid,$2::uuid,$3::uuid,'email',$4::uuid)", [ids.tenant, ids.bot, hidden.id, ids.owner]), options), errorCode("42501"));
    });
    await t.test("exact tenant quota includes hidden projects and permits only one concurrent last slot", async () => {
      const ownerUsage = (await loadKnowledgeCenter(owner, options)).usage;
      assert.deepEqual((await loadKnowledgeCenter(staff, options)).usage, ownerUsage);
      await db.admin.query("update knowledge_center_entitlements set max_sources=$1 where workspace_id=$2", [ownerUsage.sources + 1, ids.tenant]);
      const concurrent = await Promise.allSettled(["A", "B"].map(name => createKnowledgeSource(staff, { areaId: company.id, name: `SYNTHETIC last source ${name}`, type: "manual", content: "SYNTHETIC quota test" }, options)));
      assert.equal(concurrent.filter(row => row.status === "fulfilled").length, 1);
      assert.equal(concurrent.filter(row => row.status === "rejected" && errorCode("LIMIT_EXCEEDED")(row.reason)).length, 1);
      const beforeQuery = (await loadKnowledgeCenter(owner, options)).usage;
      await db.admin.query("update knowledge_center_entitlements set max_queries_per_month=$1 where workspace_id=$2", [beforeQuery.queriesThisMonth + 1, ids.tenant]);
      const queries = await Promise.allSettled([queryKnowledgeCenter(owner, { query: "mango" }, options), queryKnowledgeCenter(owner, { query: "mango" }, options)]);
      assert.equal(queries.filter(row => row.status === "fulfilled").length, 1);
      assert.equal(queries.filter(row => row.status === "rejected" && errorCode("LIMIT_EXCEEDED")(row.reason)).length, 1);
      await db.admin.query("update knowledge_center_entitlements set max_sources=100,max_queries_per_month=100 where workspace_id=$1", [ids.tenant]);
    });
    await t.test("unbound or public media is refused and reserved private documents stay tenant scoped", async () => {
      const asset = randomUUID(), foreignAsset = randomUUID(), ordinary = randomUUID();
      for (const [assetId, workspace, folder, actor] of [[asset, ids.tenant, `knowledge-private-${ids.owner}`, ids.owner], [foreignAsset, ids.otherTenant, `knowledge-private-${ids.otherOwner}`, ids.otherOwner], [ordinary, ids.tenant, "media-uploads", ids.owner]]) {
        const client = await db.admin.connect();
        try {
          await client.query("begin");
          await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [workspace, actor]);
          await client.query(`insert into media_assets(id,workspace_id,name,original_name,folder,mime_type,size_bytes,url,relative_path,storage_provider,storage_access,is_public) values($1::uuid,$2,'SYNTHETIC.pdf','SYNTHETIC.pdf',$3,'application/pdf',100,'/api/media/files/'||$1::text,$1::text,'local','private',false)`, [assetId, workspace, folder]);
          await client.query("commit");
        } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
      }
      await assert.rejects(withTenantTransaction({ actorId: ids.owner, workspaceId: ids.tenant }, tx => tx.execute("update media_assets set folder='media-uploads' where id=$1::uuid", [asset]), options), errorCode("42501"));
      await assert.rejects(withTenantTransaction({ actorId: ids.owner, workspaceId: ids.tenant }, tx => tx.execute("insert into media_asset_shares(asset_id,workspace_id,token_hash,expires_at) values($1::uuid,$2,$3,now()+interval '1 day')", [asset, ids.tenant, "a".repeat(64)]), options), errorCode("42501"));
      await withTenantTransaction({ actorId: ids.staff, workspaceId: ids.tenant }, async tx => {
        assert.equal((await tx.queryOne<{ absent: boolean }>("select knowledge_document_upload_absent($1::uuid) as absent", [asset]))?.absent, false);
        assert.equal((await tx.queryOne<{ absent: boolean }>("select knowledge_document_upload_absent($1::uuid) as absent", [randomUUID()]))?.absent, true);
      }, options);
      await assert.rejects(withTenantTransaction({ actorId: ids.assistant, workspaceId: ids.tenant }, tx => tx.query("select knowledge_document_upload_absent($1::uuid)", [asset]), options), errorCode("42501"));
      await assert.rejects(createKnowledgeSource(owner, { areaId: company.id, name: "SYNTHETIC foreign document", type: "file", mediaAssetId: foreignAsset }, options), errorCode("DOCUMENT_UNAVAILABLE"));
      await assert.rejects(createKnowledgeSource(owner, { areaId: company.id, name: "SYNTHETIC ordinary document", type: "file", mediaAssetId: ordinary }, options), errorCode("DOCUMENT_UNAVAILABLE"));
      const document = await createKnowledgeSource(owner, { areaId: project.id, name: "SYNTHETIC private document", type: "file", mediaAssetId: asset, content: "SYNTHETIC reviewed document text" }, options);
      const safe = await getKnowledgeDocument(owner, { sourceId: document.id }, options);
      assert.equal(safe.assetId, asset); assert.equal(safe.downloadPath, `/api/knowledge-center/sources/${document.id}/document`);
      assert.equal("url" in safe, false); assert.equal("relativePath" in safe, false);
      await assert.rejects(getKnowledgeDocument(otherOwner, { sourceId: document.id }, options), errorCode("NOT_FOUND"));
      const usageBeforeArchive = (await loadKnowledgeCenter(owner, options)).usage;
      await archiveKnowledgeSource(owner, { sourceId: document.id, expectedVersion: document.revision }, options);
      assert.equal((await loadKnowledgeCenter(owner, options)).usage.storageBytes, usageBeforeArchive.storageBytes);
    });
    await t.test("website scan quota reserves before network; module deactivation dominates contract", async () => {
      const website = await createKnowledgeSource(owner, { areaId: company.id, name: "SYNTHETIC website", type: "url", url: "https://example.invalid/", content: "SYNTHETIC scanned content" }, options);
      await assert.rejects(getKnowledgeScanSource(owner, { sourceId: website.id, expectedVersion: website.revision + 1 }, options), errorCode("VERSION_CONFLICT"));
      const scan = await getKnowledgeScanSource(owner, { sourceId: website.id, expectedVersion: website.revision }, options);
      assert.match(scan.contentHash!, /^[a-f0-9]{64}$/);
      await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'knowledge',false)", [ids.tenant]);
      assert.equal((await loadKnowledgeCenter(owner, options)).available, false);
      await assert.rejects(queryKnowledgeCenter(owner, { query: "mango" }, options), errorCode("ENTITLEMENT_REQUIRED"));
      await db.admin.query("update workspace_module_settings set enabled=true where workspace_id=$1 and module_key='knowledge'", [ids.tenant]);
    });
    await t.test("audit rejection rolls back source/version/usage; archive removes retrieval", async () => {
      const before = (await loadKnowledgeCenter(owner, options)).usage;
      await db.admin.query("create function synthetic_reject_knowledge_audit() returns trigger language plpgsql as $$begin if new.action='knowledge.source.created' then raise exception 'SYNTHETIC audit unavailable' using errcode='23514'; end if; return new; end$$; create trigger synthetic_reject_knowledge_audit before insert on audit_logs for each row execute function synthetic_reject_knowledge_audit()");
      try { await assert.rejects(createKnowledgeSource(owner, { areaId: company.id, name: "SYNTHETIC rolled back", type: "manual", content: "SYNTHETIC never saved" }, options), errorCode("23514")); }
      finally { await db.admin.query("drop trigger synthetic_reject_knowledge_audit on audit_logs; drop function synthetic_reject_knowledge_audit()"); }
      assert.deepEqual((await loadKnowledgeCenter(owner, options)).usage, before);
      await archiveKnowledgeArea(owner, { areaId: project.id }, options);
      assert.equal((await queryKnowledgeCenter(assistant, { query: "project mango" }, options)).matches.some(row => row.sourceId === projectSource.id), false);
    });
  } finally { await db.stop(); }
});
