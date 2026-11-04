import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { withCrmRead, type TenantTransactionOptions } from "../src/lib/crm-command";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";

type MigrationMap = { migrations: Array<{ original: string; release: string; originalSha256: string; originalLedgerChecksum: string }> };

test("renumbered release chain applies transactionally after the existing billing baseline without changing old SQL", { timeout: 180000 }, async () => {
  const db = await startLocalSalesDb();
  try {
    const map = JSON.parse(await readFile("docs/marketing-release-migration-map-2026-11-04.json", "utf8")) as MigrationMap;
    assert.equal(map.migrations.length, 31);
    await applySalesSchema(db, { maxMigrationNumber: 153 });
    const priorLedger = (await db.admin.query("select version,checksum from novalure_schema_migrations order by version")).rows;
    for (const item of map.migrations) {
      const sql = await readFile(`migrations/${item.release}`, "utf8");
      if (!item.release.startsWith("181_")) assert.equal(createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex"), item.originalLedgerChecksum);
      const client = await db.admin.connect();
      try {
        await client.query("begin");
        await client.query("set local lock_timeout='5s'");
        await client.query(sql);
        await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)", [item.release.replace(/\.sql$/, ""), item.release, createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex")]);
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    }
    const unchanged = (await db.admin.query("select version,checksum from novalure_schema_migrations where left(version,3)::integer<154 order by version")).rows;
    assert.deepEqual(unchanged, priorLedger);
    const installed = (await db.admin.query("select to_regclass('public.crm_automations') is not null as flows,to_regclass('public.crm_marketing_tags') is not null as marketing,to_regclass('public.crm_mailbox_auto_settings') is not null as mail,to_regclass('public.web_expose_brand_assets') is not null as brand,to_regprocedure('public.crm_funnel_live_lookup(text,text)') is not null as funnels")).rows[0];
    assert.deepEqual(installed, { flows: true, marketing: true, mail: true, brand: true, funnels: true });
    assert.equal((await db.admin.query("select count(*)::integer as n from crm_mailbox_auto_settings where enabled")).rows[0].n, 0);
    assert.equal((await db.admin.query("select count(*)::integer as n from crm_marketing_contact_policy where rules->>'enabled'='true'")).rows[0].n, 0);
  } finally { await db.stop(); }
});

test("funnel cutover refuses unknown historical classification atomically and preserves explicitly reviewed original responses", { timeout: 180000 }, async () => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    const workspaceId = randomUUID(), userId = randomUUID(), projectId = randomUUID(), funnelId = randomUUID(), submissionId = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC migration owner','self_service_customer')", [workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC owner',$3,'owner','customer_owner','active')", [userId, workspaceId, `${userId}@example.invalid`]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC historical project','Service')", [projectId, workspaceId]);
    await db.admin.query("insert into funnels(id,workspace_id,project_id,owner_user_id,name,goal,audience,entry_channel) values($1,$2,$3,$4,'SYNTHETIC historical funnel','SYNTHETIC','Käufer','Website')", [funnelId, workspaceId, projectId, userId]);
    await db.admin.query("insert into funnel_submissions(id,workspace_id,project_id,funnel_id,answers) values($1,$2,$3,$4,'{\"synthetic\":true}')", [submissionId, workspaceId, projectId, funnelId]);
    const sql = await readFile("migrations/181_funnel_live_templates.sql", "utf8"), client = await db.admin.connect();
    try {
      await client.query("begin");
      await assert.rejects(client.query(sql), /Historical funnel responses require reviewed classification/);
      await client.query("rollback");
    } finally { client.release(); }
    assert.equal((await db.admin.query("select count(*)::integer as n from funnel_submissions where id=$1", [submissionId])).rows[0].n, 1);
    assert.equal((await db.admin.query("select relrowsecurity as enabled from pg_class where oid='public.funnel_submissions'::regclass")).rows[0].enabled, false);
    // This is an isolated test's explicit review, not an automatic production backfill.
    await db.admin.query("alter table funnel_submissions add column data_classification text not null default 'UNCLASSIFIED',add column data_purpose text not null default 'crm_sales'");
    await db.admin.query("update funnel_submissions set data_classification='CUSTOMER_TENANT' where id=$1 and workspace_id=$2 and project_id=$3 and funnel_id=$4", [submissionId, workspaceId, projectId, funnelId]);
    const legacyTracking = { legacyId: "SYNTHETIC legacy", publicToken: "SYNTHETIC-PRIVATE-OLD-TOKEN", publishToken: "SYNTHETIC-PRIVATE-OLD-PUBLISH", otherSetting: "retained" };
    const history = [{ id: "SYNTHETIC past", blueprint: { status: "aktiv" } }];
    await db.admin.query("update funnels set status='aktiv',tracking=$2::jsonb,blueprint=$3::jsonb where id=$1", [funnelId, JSON.stringify(legacyTracking), JSON.stringify({ funnel: { status: "aktiv" }, versions: history })]);
    const reviewedFunnel = randomUUID(), reviewedTracking = { livePublication: { schemaVersion: 1, tokenHash: "a".repeat(64), versionId: randomUUID(), blueprint: { status: "aktiv" } } };
    await db.admin.query("insert into funnels(id,workspace_id,project_id,owner_user_id,name,goal,audience,entry_channel,status,tracking) values($1,$2,$3,$4,'SYNTHETIC already reviewed','SYNTHETIC','Käufer','Website','aktiv',$5::jsonb)", [reviewedFunnel, workspaceId, projectId, userId, JSON.stringify(reviewedTracking)]);
    await db.admin.query(sql);
    const migrated = (await db.admin.query("select status,tracking,blueprint from funnels where id=$1", [funnelId])).rows[0];
    assert.equal(migrated.status, "entwurf");
    for (const [key, value] of Object.entries(legacyTracking)) assert.equal(migrated.tracking[key], value);
    assert.equal(migrated.tracking.publicationReview.required, true);
    assert.equal(migrated.blueprint.funnel.status, "entwurf");
    assert.deepEqual(migrated.blueprint.versions, history);
    assert.deepEqual((await db.admin.query("select status,tracking from funnels where id=$1", [reviewedFunnel])).rows[0], { status: "aktiv", tracking: reviewedTracking });
    const audit = (await db.admin.query("select actor_user_id,before,after from audit_logs where entity_id=$1 and action='funnel.legacy_publication_review_required'", [funnelId])).rows;
    assert.equal(audit.length, 1); assert.equal(audit[0].actor_user_id, null);
    assert.equal(audit[0].after.releaseMigration, "181_funnel_live_templates");
    assert.doesNotMatch(JSON.stringify(audit), /SYNTHETIC-PRIVATE-OLD|publicToken|publishToken/);
    assert.equal((await db.admin.query("select count(*)::integer as n from pg_policies where schemaname='public' and policyname in('funnel_release_owner_update','funnel_release_owner_audit')")).rows[0].n, 0);
    const session: AppSession = { authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC", name: "SYNTHETIC", email: `${userId}@example.invalid`, role: "owner", productRole: "customer_owner", permissions: [], productPermissions: [] };
    const options: TenantTransactionOptions = { pool: db.pool as unknown as TenantPool };
    const own = await withCrmRead(session, tx => tx.queryOne<{ id: string }>("select id from funnel_submissions where id=$1::uuid", [submissionId]), options);
    assert.equal(own?.id, submissionId);
  } finally { await db.stop(); }
});
