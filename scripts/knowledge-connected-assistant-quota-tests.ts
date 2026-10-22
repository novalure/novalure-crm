import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction, type TenantTransactionOptions } from "../src/lib/db/tenant-client";
import { archiveKnowledgeArea, assignKnowledgeAreas, createKnowledgeArea, createKnowledgeSource, loadKnowledgeCenter } from "../src/lib/knowledge-center/repository";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test("connected-assistant quota: complete tenant count, last-place race and reversible grants", { timeout: 180000 }, async t => {
  const db = await startLocalSalesDb();
  const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
  const ids = { workspace: randomUUID(), foreignWorkspace: randomUUID(), owner: randomUUID(), staff: randomUUID(), foreignOwner: randomUUID(), project: randomUUID(), hiddenProject: randomUUID(), botA: randomUUID(), botB: randomUUID(), hiddenBot: randomUUID(), foreignBot: randomUUID() };
  const session = (actor: "owner" | "staff" | "foreignOwner" = "owner"): AppSession => {
    const role = actor === "staff" ? "agent" : "owner";
    const productRole = actor === "staff" ? "project_sales_member" : "customer_owner";
    return { authenticated: true, source: "database", userId: ids[actor], workspaceId: actor === "foreignOwner" ? ids.foreignWorkspace : ids.workspace, workspaceName: "SYNTHETIC quota tenant", name: "SYNTHETIC quota user", email: `${actor}@example.invalid`, role, permissions: getRolePermissions(role), productRole, productPermissions: getProductRoleCapabilities(productRole) };
  };
  const count = (actor = session(), targetWorkspace = actor.workspaceId, botId: string | null = null) => withTenantTransaction({ actorId: actor.userId, workspaceId: actor.workspaceId }, async tx => {
    const row = await tx.queryOne<{ count: number }>("select public.knowledge_connected_assistant_count($1::uuid,$2::uuid) as count", [targetWorkspace, botId]);
    return row!.count;
  }, options);
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    const migrationOwner = `knowledge_quota_owner_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await db.admin.query(`create role ${migrationOwner} nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication`);
    await db.admin.query(`grant usage,create on schema public to ${migrationOwner}`);
    await db.admin.query(`grant all on all tables in schema public to ${migrationOwner}`);
    for (const table of ["knowledge_sources", "knowledge_chunks", "projects", "bots", "media_assets", "media_asset_shares", "workspace_module_settings", "bot_conversations", "bot_messages", "bot_tool_calls"]) await db.admin.query(`alter table ${table} owner to ${migrationOwner}`);
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      await client.query(`set local role ${migrationOwner}`);
      for (const file of ["101_knowledge_center.sql", "108_knowledge_connected_assistant_quota.sql"]) await client.query(await readFile(`migrations/${file}`, "utf8"));
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC quota A','managed_by_novalure'),($2,'SYNTHETIC quota B','managed_by_novalure')", [ids.workspace, ids.foreignWorkspace]);
    for (const actor of ["owner", "staff", "foreignOwner"] as const) {
      const member = session(actor);
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC quota user',$3,$4,$5)", [member.userId, member.workspaceId, member.email, member.role, member.productRole]);
    }
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$3,'SYNTHETIC visible','synthetic'),($2,$3,'SYNTHETIC hidden','synthetic')", [ids.project, ids.hiddenProject, ids.workspace]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [ids.workspace, ids.project, ids.staff]);
    for (const [id, workspace, project] of [[ids.botA, ids.workspace, ids.project], [ids.botB, ids.workspace, ids.project], [ids.hiddenBot, ids.workspace, ids.hiddenProject], [ids.foreignBot, ids.foreignWorkspace, null]]) {
      await db.admin.query("insert into bots(id,workspace_id,project_id,name,role,status) values($1,$2,$3,'SYNTHETIC quota bot','advisor','inactive')", [id, workspace, project]);
    }
    for (const workspace of [ids.workspace, ids.foreignWorkspace]) await db.admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits)
      values($1,true,20,1000000,100,'SYNTHETIC-QUOTA-NOT-COMMERCIAL','{"webchatAccess":true,"voiceAccess":true}','{"maxAreas":20,"maxWebsites":5,"maxScansPerMonth":5,"maxUsers":10,"maxAssistants":2}')`, [workspace]);
    const company = await createKnowledgeArea(session(), { name: "SYNTHETIC shared quota area", kind: "company" }, options);
    const hidden = await createKnowledgeArea(session(), { name: "SYNTHETIC hidden quota area", kind: "project", projectId: ids.hiddenProject }, options);
    const foreignArea = await createKnowledgeArea(session("foreignOwner"), { name: "SYNTHETIC foreign quota area", kind: "company" }, options);
    await assignKnowledgeAreas(session(), { botId: ids.hiddenBot, channel: "webchat", areaIds: [hidden.id] }, options);
    await assignKnowledgeAreas(session("foreignOwner"), { botId: ids.foreignBot, channel: "webchat", areaIds: [foreignArea.id] }, options);

    await t.test("the non-bypass definer counts hidden projects without exposing their grants", async () => {
      assert.equal(await count(session("staff")), 1);
      await assert.rejects(count(session("staff"), ids.workspace, ids.hiddenBot), code("42501"));
      assert.equal(await count(session("staff"), ids.workspace, ids.botA), 0);
      const visible = await withTenantTransaction({ actorId: ids.staff, workspaceId: ids.workspace }, tx => tx.query("select bot_id from knowledge_area_grants"), options);
      assert.deepEqual(visible, []);
      const state = (await db.admin.query("select r.rolsuper,r.rolbypassrls,c.relrowsecurity,c.relforcerowsecurity from pg_proc p join pg_roles r on r.oid=p.proowner join pg_class c on c.oid='public.knowledge_area_grants'::regclass where p.oid='public.knowledge_connected_assistant_count(uuid,uuid)'::regprocedure")).rows[0];
      assert.deepEqual(state, { rolsuper: false, rolbypassrls: false, relrowsecurity: true, relforcerowsecurity: true });
      await assert.rejects(count(session(), ids.foreignWorkspace), code("42501"));
      await assert.rejects(db.pool.query("select public.knowledge_connected_assistant_count($1::uuid)", [ids.workspace]), code("42501"));
    });

    let winner = "", loser = "";
    await t.test("only one concurrent connection can take the final place", async () => {
      const bots = [ids.botA, ids.botB];
      const results = await Promise.allSettled(bots.map(botId => assignKnowledgeAreas(session(), { botId, channel: "webchat", areaIds: [company.id] }, options)));
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.filter(result => result.status === "rejected" && code("LIMIT_EXCEEDED")(result.reason)).length, 1);
      winner = bots[results.findIndex(result => result.status === "fulfilled")];
      loser = bots.find(id => id !== winner)!;
      assert.equal(await count(), 2);
      assert.equal((await loadKnowledgeCenter(session(), options)).usage.connectedAssistants, 2);
      assert.equal(await count(session("foreignOwner")), 1);
    });

    await t.test("channels, repeated assignments, paused bots and archived areas do not create or free places", async () => {
      await assignKnowledgeAreas(session(), { botId: winner, channel: "voice", areaIds: [company.id] }, options);
      await assignKnowledgeAreas(session(), { botId: winner, channel: "webchat", areaIds: [company.id, company.id] }, options);
      await db.admin.query("update bots set status='paused' where id=$1", [winner]);
      await archiveKnowledgeArea(session(), { areaId: hidden.id }, options);
      assert.equal(await count(), 2);
      assert.equal(await count(session(), ids.workspace, winner), 1);
      await assert.rejects(assignKnowledgeAreas(session(), { botId: loser, channel: "email", areaIds: [company.id] }, options), code("LIMIT_EXCEEDED"));
    });

    await t.test("only the final explicit revocation releases a place", async () => {
      await assignKnowledgeAreas(session(), { botId: winner, channel: "webchat", areaIds: [] }, options);
      assert.equal(await count(), 2);
      await assignKnowledgeAreas(session(), { botId: winner, channel: "voice", areaIds: [] }, options);
      assert.equal(await count(), 1);
      await assignKnowledgeAreas(session(), { botId: loser, channel: "webchat", areaIds: [company.id] }, options);
      assert.equal(await count(), 2);
    });

    await t.test("foreign bots and foreign areas cannot consume this tenant's places", async () => {
      await assert.rejects(assignKnowledgeAreas(session(), { botId: ids.foreignBot, channel: "voice", areaIds: [company.id] }, options), code("NOT_FOUND"));
      await assert.rejects(assignKnowledgeAreas(session(), { botId: loser, channel: "voice", areaIds: [foreignArea.id] }, options), code("NOT_FOUND"));
      assert.equal(await count(), 2);
      assert.equal(await count(session("foreignOwner")), 1);
    });

    await t.test("disabled contracts expose only authorized revocation metadata, including archived grants", async () => {
      const secret = "SYNTHETIC_SOURCE_CONTENT_MUST_NOT_LEAVE_DISABLED_KNOWLEDGE";
      await createKnowledgeSource(session(), { areaId: company.id, type: "manual", name: secret, content: secret }, options);
      try {
        for (const reference of ["SYNTHETIC-QUOTA-NOT-COMMERCIAL", null]) {
          await db.admin.query("update knowledge_center_entitlements set enabled=false,contract_reference=$2 where workspace_id=$1", [ids.workspace, reference]);
          const snapshot = await loadKnowledgeCenter(session(), options);
          assert.equal(snapshot.available, false);
          assert.equal(snapshot.assignmentManagementAvailable, true);
          assert.equal(snapshot.permissions.canAssign, true);
          assert.deepEqual(snapshot.areas, []);
          assert.deepEqual(snapshot.sources, []);
          assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
          assert.deepEqual(snapshot.bots.map(item => item.id).sort(), [ids.botA, ids.botB, ids.hiddenBot].sort());
          assert.deepEqual(snapshot.projects.map(item => item.id).sort(), [ids.project, ids.hiddenProject].sort());
          assert.ok(snapshot.assignments.some(item => item.botId === ids.hiddenBot && item.areaId === hidden.id));
          assert.equal(snapshot.usage.connectedAssistants, 2);
          assert.ok(snapshot.assignments.every(item => item.botId !== ids.foreignBot && item.areaId !== foreignArea.id));
          const staff = await loadKnowledgeCenter(session("staff"), options);
          assert.equal(staff.available, false);
          assert.ok(!staff.assignmentManagementAvailable);
          assert.deepEqual(staff.bots, []);
          assert.deepEqual(staff.assignments, []);
          assert.deepEqual(staff.sources, []);
        }
      } finally {
        await db.admin.query("update knowledge_center_entitlements set enabled=true,contract_reference='SYNTHETIC-QUOTA-NOT-COMMERCIAL' where workspace_id=$1", [ids.workspace]);
      }
    });

    await t.test("a lowered quota permits existing-assistant changes and revocation despite contract/module shutdown", async () => {
      await db.admin.query(`update knowledge_center_entitlements set limits=limits||'{"maxAssistants":0}' where workspace_id=$1`, [ids.workspace]);
      await assignKnowledgeAreas(session(), { botId: loser, channel: "voice", areaIds: [company.id] }, options);
      await assert.rejects(assignKnowledgeAreas(session(), { botId: winner, channel: "webchat", areaIds: [company.id] }, options), code("LIMIT_EXCEEDED"));
      await db.admin.query("update knowledge_center_entitlements set enabled=false where workspace_id=$1", [ids.workspace]);
      await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'knowledge',false),($1,'bots',false)", [ids.workspace]);
      await assignKnowledgeAreas(session(), { botId: loser, channel: "webchat", areaIds: [] }, options);
      await assignKnowledgeAreas(session(), { botId: loser, channel: "voice", areaIds: [] }, options);
      await assignKnowledgeAreas(session(), { botId: ids.hiddenBot, channel: "webchat", areaIds: [] }, options);
      assert.equal(await count(), 0);
      await assert.rejects(assignKnowledgeAreas(session(), { botId: winner, channel: "webchat", areaIds: [company.id] }, options), code("ENTITLEMENT_REQUIRED"));
      assert.equal(await count(session("foreignOwner")), 1);
    });
  } finally { await db.stop(); }
});
