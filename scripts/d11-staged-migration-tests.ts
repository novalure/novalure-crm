import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { evelynOwnerApprovalBindingDigest } from "../src/lib/evelyn-approval-client";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const expandFile = "migrations/087_d11_crm_source_of_truth_closure.sql";
const backfillFile = "migrations/staged/087_d11_crm_source_of_truth_backfill.sql";
const contractFile = "migrations/staged/087_d11_crm_source_of_truth_contract.sql";
const rollbackFile = "migrations/staged/087_d11_crm_source_of_truth_contract_rollback.sql";

async function apply(pool: { query(sql: string): Promise<unknown> }, file: string) {
  const sql = await readFile(file, "utf8");
  await pool.query("begin");
  try {
    await pool.query(sql);
    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback");
    throw error;
  }
}

test("D11 Expand, bounded Backfill, Contract and rollback remain staged and compatible", { timeout: 240_000 }, async () => {
  const db = await startLocalSalesDb();
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const projectId = randomUUID();
  const webProjectId = randomUUID();
  const contactId = randomUUID();
  const leadId = randomUUID();
  try {
    const baseline = await applySalesSchema(db, { maxMigrationNumber: 86 });
    assert.equal(baseline.some((name: string) => name.startsWith("087_")), false);
    await db.admin.query(
      "insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC D11 staged migration','managed_by_novalure')",
      [workspaceId],
    );
    await db.admin.query(
      "insert into workspace_users(id,workspace_id,name,email,role,product_role) values($1,$2,'SYNTHETIC Owner','d11-owner@example.invalid','owner','customer_owner')",
      [ownerId, workspaceId],
    );
    await db.admin.query(
      "insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC legacy project','Bauträger')",
      [projectId, workspaceId],
    );
    await db.admin.query(
      "insert into contacts(id,workspace_id,project_id,owner_user_id,name,role) values($1,$2,$3,$4,'SYNTHETIC Buyer','Käufer')",
      [contactId, workspaceId, projectId, ownerId],
    );
    await db.admin.query(
      "insert into leads(id,workspace_id,project_id,contact_id,type,buyer_profile) values($1,$2,$3,$4,'Käufer','{}')",
      [leadId, workspaceId, projectId, contactId],
    );

    await apply(db.admin, expandFile);
    const expanded = await db.admin.query(
      "select is_nullable from information_schema.columns where table_schema='public' and table_name='projects' and column_name='division'",
    );
    assert.equal(expanded.rows[0].is_nullable, "YES");
    assert.equal((await db.admin.query("select division from projects where id=$1", [projectId])).rows[0].division, null);

    const compatibleLeadId = randomUUID();
    await db.admin.query(
      "insert into leads(id,workspace_id,project_id,contact_id,type,buyer_profile) values($1,$2,$3,$4,'Käufer','{}')",
      [compatibleLeadId, workspaceId, projectId, contactId],
    );
    assert.equal(
      (await db.admin.query("select division from leads where id=$1", [compatibleLeadId])).rows[0].division,
      "REAL_ESTATE_GROWTH",
    );

    await apply(db.admin, backfillFile);
    const firstAudit = await db.admin.query(
      "select updated_counts,remaining_counts from crm_d11_migration_audit where phase='BACKFILL' order by id desc limit 1",
    );
    assert.equal(firstAudit.rows[0].remaining_counts.projects, 0);
    assert.equal(firstAudit.rows[0].remaining_counts.leads, 0);
    assert.ok(Number(firstAudit.rows[0].updated_counts.projects) >= 1);
    await apply(db.admin, backfillFile);
    const secondAudit = await db.admin.query(
      "select updated_counts from crm_d11_migration_audit where phase='BACKFILL' order by id desc limit 1",
    );
    assert.ok(Object.values(secondAudit.rows[0].updated_counts).every(value => Number(value) === 0));

    const digestInput = {
      approvalReference: randomUUID(),
      approvalClass: "A3" as const,
      approverRole: "OWNER" as const,
      delegated: false as const,
      ownerBound: true as const,
      tenantId: workspaceId,
      actionId: randomUUID(),
      resourceId: randomUUID(),
      actionVersion: 3,
      actionHash: "a".repeat(64),
    };
    const sqlDigest = await db.admin.query(
      "select crm_owner_authority_digest($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid) as digest",
      [digestInput.tenantId,digestInput.actionId,digestInput.resourceId,digestInput.actionVersion,digestInput.actionHash,digestInput.approvalReference],
    );
    assert.equal(sqlDigest.rows[0].digest, evelynOwnerApprovalBindingDigest(digestInput));

    await apply(db.admin, contractFile);
    const contracted = await db.admin.query(
      "select is_nullable from information_schema.columns where table_schema='public' and table_name='projects' and column_name='division'",
    );
    assert.equal(contracted.rows[0].is_nullable, "NO");
    const compatibleProject = await db.admin.query(
      "insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC old writer after contract','Bauträger') returning division::text",
      [randomUUID(),workspaceId],
    );
    assert.equal(compatibleProject.rows[0].division, "REAL_ESTATE_GROWTH");
    await db.admin.query(
      "insert into projects(id,workspace_id,name,type,division) values($1,$2,'SYNTHETIC web project','Agentur','WEB_DESIGN')",
      [webProjectId, workspaceId],
    );
    const webContactId = randomUUID();
    await db.admin.query(
      "insert into contacts(id,workspace_id,project_id,owner_user_id,name,role) values($1,$2,$3,$4,'SYNTHETIC Web Buyer','Käufer')",
      [webContactId, workspaceId, webProjectId, ownerId],
    );
    const webLeadId = randomUUID();
    await db.admin.query(
      "insert into leads(id,workspace_id,project_id,contact_id,type,buyer_profile) values($1,$2,$3,$4,'Käufer','{}')",
      [webLeadId, workspaceId, webProjectId, webContactId],
    );
    assert.equal((await db.admin.query("select division from leads where id=$1", [webLeadId])).rows[0].division, "WEB_DESIGN");
    const strictTriggers = await db.admin.query(
      "select count(*)::int as count from pg_trigger where tgname=any($1::text[]) and not tgisinternal",
      [["crm_offer_owner_a3","crm_contract_approval_owner_a3","crm_contract_execution_owner_a3","crm_project_division_immutable"]],
    );
    assert.equal(strictTriggers.rows[0].count, 4);

    await apply(db.admin, rollbackFile);
    const rolledBack = await db.admin.query(
      "select is_nullable from information_schema.columns where table_schema='public' and table_name='projects' and column_name='division'",
    );
    assert.equal(rolledBack.rows[0].is_nullable, "YES");
    await db.admin.query(
      "insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC compatible rollback project','Bauträger')",
      [randomUUID(), workspaceId],
    );
    assert.equal(
      (await db.admin.query("select count(*)::int as count from crm_d11_migration_audit where phase='CONTRACT_ROLLBACK'")).rows[0].count,
      1,
    );
  } finally {
    await db.stop();
  }
});
