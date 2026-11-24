import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { withCrmRead } from "../src/lib/crm-command";
import { mutateSeoWorkspace, readSeoWorkspace } from "../src/lib/db/marketing-seo-repository";
import { parseSeoReport, seoAuditPowerShellCommand, seoSearchSummary, seoSiteOrigin, type SeoReport } from "../src/lib/marketing-seo";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";

const workspace = randomUUID(), foreignWorkspace = randomUUID(), owner = randomUUID(), limited = randomUUID(), foreignOwner = randomUUID(), project = randomUUID(), hiddenProject = randomUUID(), foreignProject = randomUUID();
const origin = "https://seo.example.invalid";
const session = (workspaceId = workspace, userId = owner, role: AppSession["role"] = "owner", productRole: AppSession["productRole"] = "customer_owner"): AppSession => ({ authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC SEO", name: "SYNTHETIC SEO operator", email: "operator@example.invalid", role, productRole, permissions: [], productPermissions: [] });
function report(id = `seo-${randomUUID()}`, tenantId = workspace, projectId: string | null = project): SeoReport {
  return { version: "novalure.seo.v1", reportId: id, tenantId, projectId, siteUrl: origin, generatedAt: new Date().toISOString(), coverage: { attempted: 1, checked: 1, discovered: 1, complete: true, excluded: 0, errors: [] }, pages: [{ url: `${origin}/`, status: 200, title: null, description: null, canonical: "http://legacy.example.invalid/", headings: ["SYNTHETIC"], robots: [], htmlLang: "de", bytes: 100, structuredDataTypes: [], structuredDataValid: null, internalLinks: [] }], findings: [{ id: "finding-title", code: "TITLE_MISSING", severity: "high", url: `${origin}/`, evidence: "SYNTHETIC: title element absent.", recommendation: "Review title in source repository." }], searchData: { source: "google-search-console", period: { startDate: "2026-10-01", endDate: "2026-10-31" }, rows: [{ query: "SYNTHETIC query", page: `${origin}/`, country: "AUT", device: "MOBILE", clicks: 3, impressions: 30, ctr: 0.1, position: 6 }] }, actions: [{ id: "action-title", findingId: "finding-title", url: `${origin}/`, priority: "P1", title: "Review missing title", status: "planned" }] };
}
let db: Awaited<ReturnType<typeof startLocalSalesDb>>, siteId: string, savedId: string, registerAudit: string, updateAudit: string;
let completedRegistration: { input: Record<string, unknown>; metadata: ReturnType<typeof meta> };
const options = () => ({ pool: db.pool as unknown as TenantPool });
const meta = () => ({ idempotencyKey: randomUUID(), correlationId: randomUUID() });
const mutate = (input: Record<string, unknown>, metadata = meta(), actor = session()) => mutateSeoWorkspace(actor, { projectId: project, ...input }, metadata, options());
before(async () => {
  db = await startLocalSalesDb(); await applySalesSchema(db, { maxMigrationNumber: 106 });
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC SEO','self_service_customer'),($2,'SYNTHETIC Foreign SEO','self_service_customer')", [workspace, foreignWorkspace]);
  for (const [id, target, role, product] of [[owner, workspace, "owner", "customer_owner"], [limited, workspace, "agent", "project_sales_member"], [foreignOwner, foreignWorkspace, "owner", "customer_owner"]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC SEO',$3,$4,$5,'active')", [id, target, `${id}@example.invalid`, role, product]);
  for (const [id, target] of [[project, workspace], [hiddenProject, workspace], [foreignProject, foreignWorkspace]]) await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC SEO Project','Test')", [id, target]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [workspace, project, limited]);
});
after(async () => { await db?.stop(); });

test("SEO schema readiness stays explicit before migration; unchanged baseline remains readable", async () => {
  const empty = await readSeoWorkspace(session(), project, undefined, options()); assert.equal(empty.installed, false); assert.deepEqual(empty.reports, []);
  await assert.rejects(mutate({ action: "registerSite", siteUrl: origin }), /not been installed/);
  await db.admin.query(await readFile("migrations/189_marketing_seo_workspace.sql", "utf8"));
  assert.equal((await readSeoWorkspace(session(), project, undefined, options())).installed, true);
});
test("strict report contract rejects foreign paths, secret URLs, made-up fields, inconsistent coverage and search rows", () => {
  const valid = report(); assert.equal(parseSeoReport(valid).pages[0].canonical, "http://legacy.example.invalid/");
  const altered = (change: (value: SeoReport) => void) => { const value = structuredClone(valid); change(value); return value; };
  assert.throws(() => parseSeoReport({ ...valid, rawHtml: "<html>untrusted</html>" }), /unknown/);
  assert.throws(() => parseSeoReport(altered(r => { r.pages[0].url = "https://foreign.example.invalid/"; })), /another site/);
  assert.throws(() => parseSeoReport(altered(r => { r.pages[0].url += "?access_token=do-not-retain"; })), /credential/);
  assert.throws(() => parseSeoReport(altered(r => { r.coverage.checked = 2; })), /coverage/);
  assert.throws(() => parseSeoReport(altered(r => { r.searchData.rows.push(r.searchData.rows[0]); })), /duplicate search/);
  assert.throws(() => parseSeoReport(altered(r => { r.searchData.rows[0].clicks = 100; })), /clicks exceed/);
  assert.throws(() => parseSeoReport(altered(r => { r.searchData.source = "none"; })), /mismatch/);
  assert.throws(() => parseSeoReport(altered(r => { r.actions[0].findingId = "absent"; })), /finding mismatch/);
  for (const host of ["a;calc.example.com", "a&b.example.com", "a$(test).example.com", "a`calc.example.com", "a'b.example.com"]) {
    assert.throws(() => seoSiteOrigin(`https://${host}`), /DNS/);
    assert.throws(() => seoAuditPowerShellCommand(workspace, project, `https://${host}`), /DNS/);
  }
  assert.equal(seoAuditPowerShellCommand(workspace, project, origin), `npm run seo:audit -- --site '${origin}' --tenant-id '${workspace}' --project-id '${project}'`);
});
test("site registration, immutable evidence import and retry use actual scoped SQL plus audit receipts", async () => {
  const createMeta = meta(), create = { action: "registerSite", siteUrl: `${origin}/` };
  completedRegistration = { input: create, metadata: createMeta };
  const site = await mutate(create, createMeta); siteId = site.data.id; registerAudit = site.auditReference;
  assert.equal((await mutate(create, createMeta)).replayed, true);
  assert.equal((await mutate({ action: "registerSite", siteUrl: origin })).data.id, siteId);
  const input = { action: "importReport", siteId, report: report() }, metadata = meta();
  const imported = await mutate(input, metadata); savedId = imported.data.id;
  const replay = await mutate(input, metadata); assert.equal(replay.replayed, true); assert.equal(replay.data.id, savedId);
  const duplicate = await mutate(input); assert.equal(duplicate.data.id, savedId);
  const read = await readSeoWorkspace(session(), project, savedId, options()); assert.equal(read.selected?.report.reportId, input.report.reportId); assert.equal(read.selected?.actions[0].revision, 1); assert.equal(read.selected?.actions[0].status, "planned");
  await assert.rejects(mutate({ ...input, report: { ...input.report, findings: [] } }, metadata), /finding mismatch/);
  await assert.rejects(mutate({ ...input, report: { ...input.report, pages: [{ ...input.report.pages[0], title: "changed" }] } }), /immutable evidence/);
  await assert.rejects(db.admin.query("update crm_seo_reports set report_hash=repeat('a',64) where id=$1", [savedId]), /immutable/i);
  const audit = (await db.admin.query("select a.action,e.revision,e.status from crm_seo_action_events e join audit_logs a on a.id=e.audit_reference where e.report_id=$1", [savedId])).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].action, "crm.marketing.seo.importReport");
  const missingVersion = structuredClone(input.report) as unknown as Record<string, unknown>; delete missingVersion.version;
  await assert.rejects(withCrmRead(session(), tx => tx.execute("insert into crm_seo_reports(workspace_id,project_id,site_id,external_report_id,report,report_hash,generated_at,imported_by,audit_reference) values($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,repeat('a',64),now(),$6::uuid,$7::uuid)", [workspace, project, siteId, input.report.reportId, JSON.stringify(missingVersion), owner, registerAudit]), options()), /report scope mismatch/);
});
test("imports cannot rebind tenant, project, domain or supply unreviewed completion", async () => {
  await assert.rejects(mutate({ action: "importReport", siteId, report: report(undefined, foreignWorkspace) }), /does not match/);
  await assert.rejects(mutate({ action: "importReport", siteId, report: report(undefined, workspace, null) }), /does not match/);
  const otherSite = (await mutate({ action: "registerSite", siteUrl: "https://other.example.invalid" })).data.id;
  await assert.rejects(mutate({ action: "importReport", siteId: otherSite, report: report() }), /origin/);
  const ready = report(); ready.actions[0].status = "verified";
  await assert.rejects(mutate({ action: "importReport", siteId, report: ready }), /start planned/);
  await assert.rejects(mutate({ action: "registerSite", siteUrl: "https://operator:password@example.invalid" }), /HTTPS|URL/);
});
test("direct tenant SQL cannot import completed actions or commit a report without original action states", async () => {
  const rawInsert = async (body: SeoReport, forceCompleteness = false) => {
    // Explicit raw application-role transaction tests DB constraints beneath the
    // repository API. Only this disposable synthetic cluster is reachable.
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [workspace, owner]);
      await client.query("insert into crm_seo_reports(workspace_id,project_id,site_id,external_report_id,report,report_hash,generated_at,imported_by,audit_reference) values($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,repeat('a',64),$6::timestamptz,$7::uuid,$8::uuid)", [workspace, project, siteId, body.reportId, JSON.stringify(body), body.generatedAt, owner, registerAudit]);
      if (forceCompleteness) await client.query("set constraints seo_report_actions_binding immediate");
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  };
  const completed = report(); completed.actions[0].status = "verified";
  await assert.rejects(rawInsert(completed), /must start planned/);
  await assert.rejects(rawInsert(report(), true), /complete original action states/);
  await assert.rejects(withCrmRead(session(), tx => tx.execute("insert into crm_seo_sites(workspace_id,project_id,site_url,created_by,audit_reference) values($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid)", [workspace, project, "https://a;calc.example.invalid", owner, registerAudit]), options()), /check constraint/);
});
test("action review requires exact revision and evidence; history binds actor, source and audit without rewriting report", async () => {
  const input = { action: "updateAction", reportId: savedId, actionId: "action-title", expectedRevision: 1, status: "verified", note: "SYNTHETIC: reviewed source commit abc123 and local rendered title." };
  await assert.rejects(mutate({ ...input, note: "fine" }), /evidence note/);
  const metadata = meta(), changed = await mutate(input, metadata); updateAudit = changed.auditReference; assert.ok("revision" in changed.data); assert.equal(changed.data.revision, 2);
  assert.equal((await mutate(input, metadata)).replayed, true);
  await assert.rejects(mutate(input), /changed/);
  const saved = await readSeoWorkspace(session(), project, savedId, options());
  assert.equal(saved.selected?.actions[0].status, "verified"); assert.equal(saved.selected?.actions[0].note, input.note); assert.equal(saved.selected?.report.actions[0].status, "planned");
  const events = (await db.admin.query("select actor_id,status,revision,audit_reference from crm_seo_action_events where report_id=$1 order by revision", [savedId])).rows;
  assert.deepEqual(events.map(row => row.revision), [1, 2]); assert.equal(events[1].actor_id, owner); assert.equal(events[1].audit_reference, changed.auditReference);
  await assert.rejects(withCrmRead(session(), tx => tx.execute("insert into crm_seo_action_events(workspace_id,project_id,report_id,action_id,revision,status,note,actor_id,audit_reference) values($1::uuid,$2::uuid,$3::uuid,'action-title',99,'verified','fabricated review',$4::uuid,$5::uuid)", [workspace, project, savedId, owner, changed.auditReference]), options()), /must match current source/);
  await assert.rejects(db.admin.query("delete from crm_seo_action_events where report_id=$1", [savedId]), /immutable/i);
});
test("deferred audit binding rejects unrelated/foreign command reuse and rolls action state back", async () => {
  const foreign = await mutateSeoWorkspace(session(foreignWorkspace, foreignOwner), { action: "registerSite", projectId: foreignProject, siteUrl: "https://audit.example.invalid" }, meta(), options());
  const forge = (auditId: string) => withCrmRead(session(), tx => tx.execute("update crm_seo_actions set status='verified',note='SYNTHETIC forged unrelated audit',revision=revision+1,updated_by=$4::uuid,audit_reference=$5::uuid where workspace_id=$1::uuid and project_id=$2::uuid and report_id=$3::uuid and action_id='action-title'", [workspace, project, savedId, owner, auditId]), options());
  await assert.rejects(forge(registerAudit), /audit must match exact/);
  await assert.rejects(forge(foreign.auditReference), /audit must match exact/);
  await assert.rejects(forge(updateAudit), /scope\/revision\/audit mismatch|unique/i);
  const saved = await readSeoWorkspace(session(), project, savedId, options()); assert.equal(saved.selected?.actions[0].revision, 2);
  assert.equal((await db.admin.query("select count(*)::int as count from crm_seo_action_events where report_id=$1", [savedId])).rows[0].count, 2);
});
test("project/tenant isolation and fresh revocation protect reads, actions and idempotent replay", async () => {
  const hidden = (await mutate({ action: "registerSite", projectId: hiddenProject, siteUrl: origin })).data.id;
  const foreign = session(foreignWorkspace, foreignOwner);
  await mutateSeoWorkspace(foreign, { action: "registerSite", projectId: foreignProject, siteUrl: origin }, meta(), options());
  const actor = session(workspace, limited, "agent", "project_sales_member"), visible = await readSeoWorkspace(actor, null, undefined, options());
  assert.equal(visible.sites.length, 2); assert.ok(visible.sites.some(site => site.id === siteId)); assert.equal(visible.sites.some(site => site.id === hidden), false);
  await assert.rejects(readSeoWorkspace(actor, hiddenProject, undefined, options()), /grant|access/i);
  await assert.rejects(readSeoWorkspace(foreign, foreignProject, savedId, options()), /unavailable/);
  await withCrmRead(actor, async tx => { assert.equal((await tx.query("select id from crm_seo_sites where id=$1::uuid", [hidden])).length, 0); }, options());
  const input = { action: "registerSite", siteUrl: "https://limited.example.invalid" }, metadata = meta();
  assert.equal((await readSeoWorkspace(actor, project, undefined, options())).canEdit, true);
  await mutate(input, metadata, actor);
  await db.admin.query("delete from project_pipeline_permissions where workspace_id=$1 and user_id=$2", [workspace, limited]);
  assert.equal((await readSeoWorkspace(actor, null, undefined, options())).sites.length, 0);
  await assert.rejects(mutate(input, metadata, actor), /grant|access/i);
  await assert.rejects(mutate({ action: "updateAction", reportId: savedId, actionId: "action-title", expectedRevision: 2, status: "planned", note: "" }, meta(), actor), /grant|capability|access/i);
  await db.admin.query("update workspace_users set status='suspended' where id=$1", [limited]);
  await assert.rejects(readSeoWorkspace(actor, null, undefined, options()), /membership/);
});
test("search summaries weight measured rows and preserve unknown positions without promising ranking effect", () => {
  assert.deepEqual(seoSearchSummary([]), { clicks: 0, impressions: 0, ctr: null, position: null });
  const rows = report().searchData.rows;
  rows.push({ query: "other", page: null, country: null, device: null, clicks: 1, impressions: 10, ctr: 0.1, position: 2 });
  assert.deepEqual(seoSearchSummary(rows), { clicks: 4, impressions: 40, ctr: 0.1, position: 5 });
});
test("disabled analytics module fails closed for SEO reads and writes", async () => {
  await db.admin.query("update workspaces set setup_state=jsonb_build_object('enabledModules',jsonb_build_object('analytics',false)) where id=$1", [workspace]);
  await assert.rejects(readSeoWorkspace(session(), project, savedId, options()), /unavailable/);
  await assert.rejects(mutate({ action: "registerSite", siteUrl: origin }), /unavailable/);
  await assert.rejects(mutate(completedRegistration.input, completedRegistration.metadata), /unavailable/);
});
