import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, after, test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { emptyNewsletterDraft, normalizeNewsletterDraft, newsletterReadyIssues, renderApprovedNewsletter } from "../src/lib/newsletter-workspace";
import { approveNewsletter, createNewsletterDraft, previewNewsletterRecipients, readNewsletterWorkspace, saveNewsletterDraft, sendNewsletterBatch, sendNewsletterTest } from "../src/lib/db/newsletter-workspace-repository";
import { applyNewsletterUnsubscribe, checkNewsletterUnsubscribe } from "../src/lib/newsletter-unsubscribe";
import type { NewsletterDispatch } from "../src/lib/newsletter-provider";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";

function readyDraft() { return { ...emptyNewsletterDraft("mailing@example.invalid", "SYNTHETIC Company"), language: "en" as const, legalAddress: "SYNTHETIC Example Street 1, Example City", subject: "Hello {{contact.name}}", previewText: "SYNTHETIC project news", contentBlocks: [{ id: "text-1", type: "text" as const, text: "Update for {{project.name}} from {{agent.name}}." }] }; }
test("mailing drafts retain structured content and block script URLs, header injection and unknown fields", () => {
  const draft = readyDraft(); assert.deepEqual(normalizeNewsletterDraft(draft), draft); assert.deepEqual(newsletterReadyIssues(draft), []);
  for (const value of [{ ...draft, ownerUserId: randomUUID() }, { ...draft, fromName: "Name\r\nBcc: wrong@example.invalid" }, { ...draft, contentBlocks: [{ id: "x", type: "button", label: "Go", url: "javascript:alert(1)" }] }, { ...draft, contentBlocks: [{ id: "x", type: "image", alt: "x", caption: "", imageUrl: "data:text/html,evil" }] }]) assert.throws(() => normalizeNewsletterDraft(value));
  assert.ok(newsletterReadyIssues({ ...draft, legalAddress: "", contentBlocks: [{ id: "x", type: "text", text: "{{secret.token}}" }] }).length >= 2);
  const html = renderApprovedNewsletter({ ...draft, contentBlocks: [{ id: "x", type: "text", text: "<script>wrong</script> {{contact.name}}" }] }, { contactName: '<img src="wrong">', projectName: "SYNTHETIC", agentName: "SYNTHETIC", unsubscribeUrl: "https://example.invalid/unsubscribe?token=synthetic" });
  assert.doesNotMatch(html, /<script>|<img src="wrong">/); assert.match(html, /&lt;script&gt;/); assert.match(html, /<html lang="en">/); assert.match(html, /unsubscribe\?token=synthetic/);
});

let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
const w = randomUUID(), foreignW = randomUUID(), owner = randomUUID(), agent = randomUUID(), foreignOwner = randomUUID(), project = randomUUID(), hiddenProject = randomUUID(), foreignProject = randomUUID();
const eligible = randomUUID(), missing = randomUUID(), optedOut = randomUUID(), suppressed = randomUUID(), invalid = randomUUID(), broker = randomUUID(), foreignContact = randomUUID();
const sent: NewsletterDispatch[] = [];
const provider = () => ({ configured: true, external: true, provider: "resend" as const, from: "SYNTHETIC <mailing@example.invalid>", reason: null });
const transport = async (message: NewsletterDispatch) => { sent.push(message); return { status: "accepted" as const, messageId: "synthetic-provider-" + sent.length }; };
const options = () => ({ pool: db.pool as unknown as TenantPool, provider, transport, origin: "https://mailing.example.invalid" });
const meta = () => ({ idempotencyKey: randomUUID(), correlationId: randomUUID() });
function session(actor = owner, role: AppSession["role"] = "owner", productRole: AppSession["productRole"] = "customer_owner"): AppSession { return { authenticated: true, userId: actor, workspaceId: w, workspaceName: "SYNTHETIC Mailing", name: "SYNTHETIC Owner", email: "owner@example.invalid", role, productRole, permissions: [], productPermissions: [], source: "database" }; }
async function create(audience = "Käufer") {
  const campaign = await createNewsletterDraft(session(), { projectId: project, name: "SYNTHETIC " + randomUUID(), audience, language: "en" }, meta(), options());
  const saved = await saveNewsletterDraft(session(), { campaignId: campaign.data.campaignId, expectedRevision: 1, draft: readyDraft() }, meta(), options());
  return { campaignId: campaign.data.campaignId, expectedRevision: saved.data.revision };
}
before(async () => {
  db = await startLocalSalesDb(); await applySalesSchema(db, { maxMigrationNumber: 106 });
  await db.admin.query(await readFile("migrations/157_newsletter_workspace.sql", "utf8"));
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Mailing','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')", [w, foreignW]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$4,'SYNTHETIC Owner','owner@example.invalid','owner','customer_owner','active'),($2,$4,'SYNTHETIC Agent','agent@example.invalid','agent','project_sales_member','active'),($3,$5,'SYNTHETIC Foreign','foreign@example.invalid','owner','customer_owner','active')", [owner, agent, foreignOwner, w, foreignW]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$4,'SYNTHETIC Project','Test'),($2,$4,'SYNTHETIC Hidden','Test'),($3,$5,'SYNTHETIC Foreign','Test')", [project, hiddenProject, foreignProject, w, foreignW]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [w, project, agent]);
  for (const [id, email, role, workspace, target, actor] of [[eligible, "eligible@example.invalid", "Käufer", w, project, owner], [missing, "missing@example.invalid", "Käufer", w, project, owner], [optedOut, "optout@example.invalid", "Käufer", w, project, owner], [suppressed, "suppressed@example.invalid", "Käufer", w, project, owner], [invalid, "invalid", "Käufer", w, project, owner], [broker, "broker@example.invalid", "Makler", w, project, owner], [foreignContact, "foreign@example.invalid", "Käufer", foreignW, foreignProject, foreignOwner]]) await db.admin.query("insert into contacts(id,workspace_id,project_id,owner_user_id,name,email,role,consent_label) values($1,$2,$3,$4,'SYNTHETIC Recipient',$5,$6,'Opt-in')", [id, workspace, target, actor, email, role]);
  for (const customer of [eligible, optedOut, suppressed, invalid, broker]) await db.admin.query("insert into consent_records(workspace_id,project_id,contact_id,channel,status,source,captured_at) values($1,$2,$3,'Newsletter','Opt-in','SYNTHETIC explicit consent','2020-01-01')", [w, project, customer]);
  await db.admin.query("insert into consent_records(workspace_id,project_id,contact_id,channel,status,source,captured_at) values($1,$2,$3,'Newsletter','Abgemeldet','SYNTHETIC revoked','2021-01-01')", [w, project, optedOut]);
  await db.admin.query("insert into newsletter_suppressions(workspace_id,email,reason,source) values($1,'suppressed@example.invalid','complaint','SYNTHETIC')", [w]);
  const bulk = await db.admin.query<{ id: string }>("insert into contacts(workspace_id,project_id,owner_user_id,name,email,role,consent_label) select $1,$2,$3,'SYNTHETIC Bulk '||n,'bulk'||n||'@example.invalid','Investor','Nur CRM' from generate_series(1,52) n returning id", [w, project, owner]);
  for (const row of bulk.rows) await db.admin.query("insert into consent_records(workspace_id,project_id,contact_id,channel,status,source) values($1,$2,$3,'Newsletter','Opt-in','SYNTHETIC explicit consent')", [w, project, row.id]);
});
after(async () => { if (db) await db.stop(); });

test("saved campaigns survive reload and legacy campaigns are adopted without losing their source IDs", async () => {
  const campaign = await create(), source = await readNewsletterWorkspace(session(), project, options());
  assert.equal(source.drafts.find(row => row.campaignId === campaign.campaignId)?.input.subject, readyDraft().subject);
  const legacy = randomUUID(); await db.admin.query("insert into newsletter_campaigns(id,workspace_id,project_id,name,subject,content_blocks) values($1,$2,$3,'SYNTHETIC legacy','SYNTHETIC legacy subject','[\"SYNTHETIC legacy body\"]')", [legacy, w, project]);
  const row = (await readNewsletterWorkspace(session(), project, options())).drafts.find(row => row.campaignId === legacy)!;
  assert.equal(row.revision, 0); assert.equal(row.input.contentBlocks[0].type, "text");
  const saved = await saveNewsletterDraft(session(), { campaignId: legacy, expectedRevision: 0, draft: { ...readyDraft(), subject: row.input.subject } }, meta(), options());
  assert.equal(saved.data.campaignId, legacy); assert.equal(saved.data.revision, 1);
  await assert.rejects(saveNewsletterDraft(session(), { campaignId: legacy, expectedRevision: 0, draft: readyDraft() }, meta(), options()), /geändert/);
});

test("recipient preview uses current explicit consent, suppression, audience and accessible project", async () => {
  const campaign = await create(), preview = await previewNewsletterRecipients(session(), campaign.campaignId, options());
  assert.equal(preview.eligible, 1); assert.equal(preview.excluded, 4);
  assert.equal(preview.recipients.find(row => row.contactId === eligible)?.eligible, true);
  assert.equal(preview.recipients.find(row => row.contactId === missing)?.reason, "missing_opt_in");
  assert.equal(preview.recipients.find(row => row.contactId === optedOut)?.reason, "opt_out");
  assert.equal(preview.recipients.find(row => row.contactId === suppressed)?.reason, "newsletter_suppression");
  assert.equal(preview.recipients.find(row => row.contactId === invalid)?.reason, "missing_address");
  assert.ok(!preview.recipients.some(row => row.contactId === broker || row.contactId === foreignContact));
  await assert.rejects(previewNewsletterRecipients(session(agent, "agent", "project_sales_member"), campaign.campaignId, options()), /Versandberechtigung/);
  await assert.rejects(readNewsletterWorkspace(session(agent, "agent", "project_sales_member"), hiddenProject, options()), /Project access/);
  await assert.rejects(createNewsletterDraft(session(), { projectId: foreignProject, name: "SYNTHETIC forbidden", audience: "Alle", language: "en" }, meta(), options()), /Project access/);
});

test("unapproved or stale revisions never dispatch and editing cancels pending recipients", async () => {
  const campaign = await create(), before = sent.length;
  await assert.rejects(sendNewsletterBatch(session(), campaign, meta(), options()), /Freigabe/);
  await approveNewsletter(session(), campaign, meta(), options());
  const version = await db.admin.query("select input from crm_newsletter_versions where campaign_id=$1", [campaign.campaignId]);
  await saveNewsletterDraft(session(), { campaignId: campaign.campaignId, expectedRevision: campaign.expectedRevision, draft: { ...readyDraft(), subject: "SYNTHETIC edited" } }, meta(), options());
  assert.deepEqual((await db.admin.query("select input from crm_newsletter_versions where campaign_id=$1", [campaign.campaignId])).rows, version.rows);
  assert.equal((await db.admin.query("select status from crm_newsletter_deliveries where campaign_id=$1", [campaign.campaignId])).rows[0].status, "cancelled");
  await assert.rejects(sendNewsletterBatch(session(), campaign, meta(), options()), /Freigabe/); assert.equal(sent.length, before);
});

test("approved recipient snapshots dispatch in at most 50 and do not silently drop the rest or resend on replay", async () => {
  const campaign = await create("Investor"); await approveNewsletter(session(), campaign, meta(), options());
  const before = sent.length, metadata = meta();
  const first = await sendNewsletterBatch(session(), campaign, metadata, options());
  assert.equal(first.dispatched, 50); assert.equal(sent.length - before, 50);
  assert.equal(first.statuses.find(row => row.status === "pending")?.count, 2);
  assert.equal(first.statuses.find(row => row.status === "accepted")?.count, 50);
  const replay = await sendNewsletterBatch(session(), campaign, metadata, options());
  assert.equal(replay.replayed, true); assert.equal(replay.dispatched, 0); assert.equal(sent.length - before, 50);
  const second = await sendNewsletterBatch(session(), campaign, meta(), options());
  assert.equal(second.dispatched, 2); assert.equal(sent.length - before, 52); assert.equal(second.statuses.find(row => row.status === "pending"), undefined);
  assert.equal(new Set(sent.slice(before).map(message => message.idempotencyKey)).size, 52);
  for (const message of sent.slice(before)) { assert.match(message.to, /^bulk\d+@example.invalid$/); assert.match(message.html, /SYNTHETIC Project/); assert.match(message.html, /token=/); assert.match(message.unsubscribeUrl!, /^https:\/\/mailing.example.invalid\/api\/public\/newsletter\/unsubscribe/); }
});

test("a consent withdrawal after approval is checked again before the provider boundary", async () => {
  const campaign = await create(); await approveNewsletter(session(), campaign, meta(), options());
  await db.admin.query("insert into consent_records(workspace_id,project_id,contact_id,channel,status,source) values($1,$2,$3,'Newsletter','Abgemeldet','SYNTHETIC later withdrawal')", [w, project, eligible]);
  const before = sent.length, result = await sendNewsletterBatch(session(), campaign, meta(), options());
  assert.equal(sent.length, before); assert.equal(result.statuses.find(row => row.status === "suppressed")?.count, 1);
});

test("unknown provider outcomes remain durable and block automatic resend or a new draft revision", async () => {
  const campaign = await create("Makler"); await approveNewsletter(session(), campaign, meta(), options());
  let calls = 0; const uncertainOptions = { ...options(), transport: async () => { calls++; return { status: "uncertain" as const, error: "SYNTHETIC lost response" }; } };
  const metadata = meta(), first = await sendNewsletterBatch(session(), campaign, metadata, uncertainOptions);
  assert.equal(first.statuses.find(row => row.status === "uncertain")?.count, 1);
  await sendNewsletterBatch(session(), campaign, metadata, uncertainOptions); await assert.rejects(sendNewsletterBatch(session(), campaign, meta(), uncertainOptions),/ungeklärt/); assert.equal(calls, 1);
  await assert.rejects(saveNewsletterDraft(session(), { campaignId: campaign.campaignId, expectedRevision: campaign.expectedRevision, draft: readyDraft() }, meta(), options()), /geklärt/);
});

test("unsubscribe GET checks do not change preferences; per-recipient POST capability is narrow and idempotent", async () => {
  const delivery = (await db.admin.query<{ id: string; contact_id: string; to_email: string; payload: { unsubscribeUrl: string } }>("select id,contact_id,to_email,payload from crm_newsletter_deliveries where workspace_id=$1 and status='accepted' limit 1", [w])).rows[0];
  const token = new URL(delivery.payload.unsubscribeUrl).searchParams.get("token")!;
  const publicQuery = async (sql: string, params: unknown[]) => (await db.pool.query<{ result: unknown }>(sql, params)).rows[0] ?? null;
  const count = (await db.admin.query("select count(*) from newsletter_suppressions")).rows[0].count;
  assert.equal((await checkNewsletterUnsubscribe(token, publicQuery))?.unsubscribed, false);
  assert.equal((await db.admin.query("select count(*) from newsletter_suppressions")).rows[0].count, count);
  assert.equal(await applyNewsletterUnsubscribe("A".repeat(43), publicQuery), false);
  assert.equal(await applyNewsletterUnsubscribe(token, publicQuery), true); assert.equal(await applyNewsletterUnsubscribe(token, publicQuery), true);
  assert.equal((await checkNewsletterUnsubscribe(token, publicQuery))?.unsubscribed, true);
  assert.equal((await db.admin.query("select count(*) from newsletter_suppressions where workspace_id=$1 and lower(email)=$2", [w, delivery.to_email])).rows[0].count, "1");
  assert.equal((await db.admin.query("select count(*) from consent_records where workspace_id=$1 and contact_id=$2 and source='Newsletter capability'", [w, delivery.contact_id])).rows[0].count, "1");
});

test("a deliberate test uses the saved campaign version and only the signed-in member address", async () => {
  const campaign = await create(), metadata = meta(), before = sent.length;
  const first = await sendNewsletterTest(session(), campaign, metadata, options());
  assert.equal(first.campaignId, campaign.campaignId); assert.equal(first.email, "owner@example.invalid"); assert.equal(first.status, "accepted");
  assert.equal(sent.length, before + 1); assert.equal(sent.at(-1)?.to, "owner@example.invalid"); assert.match(sent.at(-1)!.subject, /^\[TEST\]/); assert.match(sent.at(-1)!.html, /Test message to the signed-in user account/); assert.equal(sent.at(-1)?.unsubscribeUrl, undefined);
  const replay = await sendNewsletterTest(session(), campaign, metadata, options()); assert.equal(replay.replayed, true); assert.equal(sent.length, before + 1);
  assert.equal((await db.admin.query("select count(*) from crm_newsletter_deliveries where campaign_id=$1", [campaign.campaignId])).rows[0].count, "0");
  await assert.rejects(sendNewsletterTest(session(agent, "agent", "project_sales_member"), campaign, meta(), options()), /Versandberechtigung/);
});
