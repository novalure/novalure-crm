import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { readMarketingOverview } from "../src/lib/db/marketing-overview-repository";
import { createNewsletterDraft } from "../src/lib/db/newsletter-workspace-repository";

let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
const workspace = randomUUID(), owner = randomUUID(), limited = randomUUID(), foreignWorkspace = randomUUID(), foreignOwner = randomUUID();
const project = randomUUID(), hiddenProject = randomUUID(), foreignProject = randomUUID();
const session = (workspaceId = workspace, userId = owner, role: AppSession["role"] = "owner", productRole: AppSession["productRole"] = "customer_owner"): AppSession => ({ authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC Marketing overview", name: "Synthetic owner", email: "owner@example.invalid", role, productRole, permissions: [], productPermissions: [] });
const options = () => ({ pool: db.pool as unknown as TenantPool });
const create = (target: string, label: string, actor = session()) => createNewsletterDraft(actor, { projectId: target, name: label, audience: "Alle", language: "de" }, { idempotencyKey: randomUUID(), correlationId: randomUUID() }, options());
let firstId: string;
before(async () => {
  db = await startLocalSalesDb();
  await applySalesSchema(db, { maxMigrationNumber: 106 });
  for (const file of ["157_newsletter_workspace.sql", "180_marketing_data.sql"]) await db.admin.query(await readFile(`migrations/${file}`, "utf8"));
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Overview','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')", [workspace, foreignWorkspace]);
  for (const [id, target, role, product] of [[owner, workspace, "owner", "customer_owner"], [limited, workspace, "agent", "project_sales_member"], [foreignOwner, foreignWorkspace, "owner", "customer_owner"]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC Owner',$3,$4,$5,'active')", [id, target, `${id}@example.invalid`, role, product]);
  for (const [id, target] of [[project, workspace], [hiddenProject, workspace], [foreignProject, foreignWorkspace]]) await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC Project','Test')", [id, target]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [workspace, project, limited]);
  firstId = (await create(project, "SYNTHETIC Visible mailing")).data.campaignId;
  await create(hiddenProject, "SYNTHETIC Hidden mailing");
  await create(foreignProject, "SYNTHETIC Foreign mailing", session(foreignWorkspace, foreignOwner));
});
after(async () => { await db?.stop(); });

test("overview reads actual current drafts and opens exact original IDs; absent modules stay unknown", async () => {
  const all = await readMarketingOverview(session(), null, options());
  assert.equal(all.counts.mailings, 2);
  assert.equal(all.counts.approvalNeeded, 2);
  assert.equal(all.counts.flows, null);
  assert.equal(all.counts.publications, null);
  assert.equal(all.review.length, 2);
  assert.equal(all.review.some(row => row.title.includes("Foreign")), false);
  const scoped = await readMarketingOverview(session(), project, options());
  assert.equal(scoped.counts.mailings, 1);
  assert.deepEqual(scoped.review[0].target, { kind: "newsletter", id: firstId, projectId: project });
});

test("project-limited and revoked grants do not leak reviews or cross-tenant counts", async () => {
  const actor = session(workspace, limited, "agent", "project_sales_member");
  const visible = await readMarketingOverview(actor, null, options());
  assert.equal(visible.counts.mailings, 1);
  assert.equal(visible.review[0].target.id, firstId);
  await assert.rejects(readMarketingOverview(actor, hiddenProject, options()), /access|grant|project/i);
  await assert.rejects(readMarketingOverview(session(), foreignProject, options()), /access|grant|project/i);
  await db.admin.query("delete from project_pipeline_permissions where workspace_id=$1 and user_id=$2", [workspace, limited]);
  const revoked = await readMarketingOverview(actor, null, options());
  assert.equal(revoked.counts.mailings, 0);
  assert.equal(revoked.review.length, 0);
});

test("disabled modules contribute neither numbers nor review records", async () => {
  await db.admin.query("update workspaces set setup_state=jsonb_build_object('enabledModules',jsonb_build_object('newsletter',false,'tasks',false,'funnels',false)) where id=$1", [workspace]);
  const result = await readMarketingOverview(session(), null, options());
  assert.equal(result.modules.newsletter, false);
  assert.equal(result.counts.mailings, null);
  assert.equal(result.counts.funnels, null);
  assert.deepEqual(result.review, []);
});
