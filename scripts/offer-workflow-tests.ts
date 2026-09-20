import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseOfferContent, offerTotal, nextOfferStatus, assertOfferApproval, assertFreshOfferSession, requiredSalesApprovalSteps, assertOfferOnlyAction, type OfferStatus } from "../src/lib/offer-workflow";
import { executeOfferCommand, getOfferWorkflow, type OfferCommand } from "../src/lib/db/offer-repositories";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { chromium } from "@playwright/test";
import { createOfferPrintFrame } from "../src/components/offer-workflow";

const content = () => ({ subject: "SYNTHETIC Novalure proposal", recipientName: "Synthetic Buyer", recipientEmail: "buyer@example.invalid", terms: "Synthetic scope, setup plus three mandatory monthly periods. No contract is sent.", validUntil: new Date(Date.now() + 2 * 86400000).toISOString(), currency: "EUR" as const, taxBasis: "NET" as const, items: [{ description: "Setup", quantity: 1, unitNetCents: 990000 }, { description: "Monthly service", quantity: 3, unitNetCents: 349000 }] });
test("money: mandatory periods are included in exact EUR net total", () => { assert.equal(offerTotal(parseOfferContent(content())), 2037000); });
test("money and content reject negative, fractional, overflowing and ambiguous inputs", () => {
  for (const change of [{ currency: "USD" }, { taxBasis: "GROSS" }, { approved: true }, { items: [] }, { items: [{ description: "X", quantity: 1.5, unitNetCents: 10 }] }, { items: [{ description: "X", quantity: 1, unitNetCents: -1 }] }, { items: [{ description: "X", quantity: 100, unitNetCents: Number.MAX_SAFE_INTEGER }] }, { validUntil: "2027-02-30T10:00:00.000Z" }]) assert.throws(() => parseOfferContent({ ...content(), ...change }));
});
test("workflow denies skipping approval, queued-to-accepted and reopening terminal offers", () => {
  for (const [status, action] of [["DRAFT", "queue_send"], ["APPROVED", "accept"], ["QUEUED", "accept"], ["ACCEPTED", "revise"], ["REJECTED", "approve"]] as const) assert.throws(() => nextOfferStatus(status, action), /INVALID_OFFER_TRANSITION/);
  let state: OfferStatus = "DRAFT";
  for (const action of ["approve", "queue_send", "record_sent", "accept"] as const) state = nextOfferStatus(state, action);
  assert.equal(state, "ACCEPTED");
});
test("approval binds configured actor, revision, digest and explicit expiry", () => {
  const baseline = { revision: 2, digest: "digest", approverId: "actor", configuredApproverId: "actor", approval: { revision: 2, digest: "digest", actorId: "actor", expiresAt: "2030-01-01T10:00:00Z" }, now: Date.parse("2029-01-01") };
  assert.doesNotThrow(() => assertOfferApproval(baseline));
  for (const change of [{ revision: 3 }, { digest: "changed" }, { configuredApproverId: null }, { configuredApproverId: "another" }, { approval: null }, { now: Date.parse("2030-01-02") }]) assert.throws(() => assertOfferApproval({ ...baseline, ...change }));
});
test("approval requires recent authenticated session; offers never authorize contracts", () => {
  const now = Date.now();
  const valid = { authenticated: true, source: "database", authSessionId: randomUUID(), sessionCreatedAt: new Date(now - 1000) };
  assert.doesNotThrow(() => assertFreshOfferSession(valid, now));
  for (const change of [{ authenticated: false }, { source: "demo" }, { authSessionId: undefined }, { sessionCreatedAt: new Date(now - 16 * 60000) }, { sessionCreatedAt: new Date(now + 1000) }]) assert.throws(() => assertFreshOfferSession({ ...valid, ...change }, now));
  assert.equal(requiredSalesApprovalSteps("offer.send", 2037000), 1);
  assert.equal(requiredSalesApprovalSteps("contract.send", 499999), 1);
  assert.equal(requiredSalesApprovalSteps("contract.send", 500000), 2);
  assert.throws(() => assertOfferOnlyAction("contract.send"), /DISABLED/);
});

test("PostgreSQL offer workflow, constraints, isolation, idempotency and atomic outcome", { timeout: 180000 }, async t => {
  const db = await startLocalSalesDb();
  try {
    const migrations = await applySalesSchema(db);
    assert.ok(migrations.includes("081_crm_offer_workflow.sql"));
    const options = { pool: db.pool as unknown as TenantPool };
    const makeFixture = async () => {
      const workspaceId = randomUUID(), userId = randomUUID(), projectId = randomUUID(), organizationId = randomUUID(), contactId = randomUUID(), leadId = randomUUID(), dealId = randomUUID(), authSessionId = randomUUID();
      await db.admin.query(`insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC OFFER QA','novalure_internal','novalure_internal',$2::jsonb)`, [workspaceId, JSON.stringify({ salesApprovalUserId: userId })]);
      const user = await db.admin.query(`insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic approver',$3,'owner','novalureAdmin','active') returning auth_identity_id`, [userId, workspaceId, `${userId}@example.invalid`]);
      const authIdentityId = user.rows[0].auth_identity_id as string;
      await db.admin.query(`insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '2 hours')`, [authSessionId, createHash("sha256").update(randomUUID()).digest("hex"), authIdentityId, userId, workspaceId]);
      await db.admin.query(`insert into projects(id,workspace_id,name,type) values($1,$2,'Synthetic project','Service')`, [projectId, workspaceId]);
      await db.admin.query(`insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'Synthetic company','Unternehmen')`, [organizationId, workspaceId, projectId]);
      await db.admin.query(`insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,role,email,consent_label) values($1,$2,$3,$4,$5,'Synthetic Buyer','Kunde','buyer@example.invalid','Opt-in')`, [contactId, workspaceId, projectId, organizationId, userId]);
      await db.admin.query(`insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,source,type,status) values($1,$2,$3,$4,$5,'Manual','Käufer','Neu')`, [leadId, workspaceId, projectId, contactId, userId]);
      await db.admin.query(`insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,owner_user_id,name,stage,value_cents) values($1,$2,$3,$4,$5,$6,$7,'Synthetic deal','Qualifizieren',2037000)`, [dealId, workspaceId, projectId, contactId, organizationId, leadId, userId]);
      const session = { authenticated: true, userId, workspaceId, workspaceName: "SYNTHETIC OFFER QA", email: `${userId}@example.invalid`, name: "Synthetic approver", role: "owner", permissions: ["crm:read", "crm:write"], productRole: "novalureAdmin", productPermissions: ["pipeline:write", "novalure:internal"], source: "database", authIdentityId, authSessionId, sessionCreatedAt: new Date() } as AppSession;
      const command = async (operation: OfferCommand["operation"], payload: Record<string, unknown> = {}, overrides: Partial<OfferCommand> = {}, actor = session) => {
        const view = await getOfferWorkflow(session, dealId, options);
        return executeOfferCommand(actor, { operation, projectId, dealId, offerId: view.offer?.id, expectedVersion: view.offer?.version ?? view.dealVersion, payload, idempotencyKey: randomUUID(), correlationId: randomUUID(), ...overrides }, options);
      };
      const view = () => getOfferWorkflow(session, dealId, options);
      const create = () => command("create", { content: content(), leadId });
      const approve = async () => { const offer = (await view()).offer!; return command("approve", { revision: offer.revision, contentDigest: offer.contentDigest, expiresAt: new Date(Date.now() + 3600000).toISOString() }); };
      const sent = async () => { const offer = (await view()).offer!; return command("record_sent", { revision: offer.revision, contentDigest: offer.contentDigest, recipientEmail: offer.content.recipientEmail, reference: "SYNTHETIC manual test outbox receipt", sentAt: new Date().toISOString() }); };
      const respond = async (accepted: boolean) => { const offer = (await view()).offer!; return command(accepted ? "accept" : "reject", { revision: offer.revision, contentDigest: offer.contentDigest, reference: "SYNTHETIC customer answer", ...(accepted ? {} : { reason: "SYNTHETIC declined" }) }); };
      return { workspaceId, userId, projectId, contactId, leadId, dealId, organizationId, session, command, view, create, approve, sent, respond };
    };
    await t.test("real offer API view and queue consume the scope-bound approval reference", async () => {
      const f = await makeFixture(); await f.create(); await f.approve();
      const view = await f.view(), reference = view.approvalReference;
      assert.ok(reference); assert.equal(reference.status, "APPROVED"); assert.equal(reference.scope.action, "offer.send");
      assert.equal(reference.scope.resourceId, view.offer!.id); assert.equal(reference.scope.resourceVersion, view.offer!.revision);
      assert.equal(reference.scope.contentDigest, view.offer!.contentDigest); assert.equal(reference.scope.recipient, view.offer!.content.recipientEmail);
      assert.equal(reference.scope.totalNetCents, 2037000); assert.equal(reference.requiredSteps, 1); assert.equal(reference.contractOrPaymentAuthorized, false);
      const result = await f.command("queue_send"); assert.equal(result.data.offer!.status, "QUEUED");
      const delivery = (await db.admin.query("select approval_id,status from crm_offer_deliveries where offer_id=$1", [view.offer!.id])).rows[0];
      assert.equal(delivery.approval_id, reference.id); assert.equal(delivery.status, "QUEUED");
    });
    await t.test("draft is not sendable and cross-tenant read/write fail", async () => {
      const a = await makeFixture(), b = await makeFixture(); await a.create();
      await assert.rejects(a.command("queue_send"), /INVALID_OFFER_TRANSITION/);
      await assert.rejects(getOfferWorkflow(b.session, a.dealId, options));
      await assert.rejects(a.command("revise", { content: content() }, {}, b.session));
      const count = await db.admin.query(`select count(*)::int as n from crm_offer_deliveries where workspace_id=$1`, [a.workspaceId]); assert.equal(count.rows[0].n, 0);
    });
    await t.test("missing configured approver and stale persisted auth session are denied", async () => {
      const f = await makeFixture(); await f.create();
      await db.admin.query(`update workspaces set setup_state='{}'::jsonb where id=$1`, [f.workspaceId]);
      await assert.rejects(f.approve(), /APPROVER_NOT_CONFIGURED/);
      await db.admin.query(`update workspaces set setup_state=$2::jsonb where id=$1`, [f.workspaceId, JSON.stringify({ salesApprovalUserId: f.userId })]);
      await db.admin.query(`update auth_sessions set created_at=now()-interval '1 hour' where id=$1`, [f.session.authSessionId]);
      await assert.rejects(f.approve(), /FRESH_AUTHENTICATION_REQUIRED/);
    });
    await t.test("a different authorized sales user cannot impersonate the configured approver", async () => {
      const f = await makeFixture(); await f.create();
      const userId = randomUUID(), authSessionId = randomUUID();
      const added = await db.admin.query(`insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic sales',$3,'agent','novalure_sales','active') returning auth_identity_id`, [userId, f.workspaceId, `${userId}@example.invalid`]);
      const authIdentityId = added.rows[0].auth_identity_id as string;
      await db.admin.query(`insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '2 hours')`, [authSessionId, createHash("sha256").update(randomUUID()).digest("hex"), authIdentityId, userId, f.workspaceId]);
      const actor = { ...f.session, userId, authSessionId, authIdentityId };
      const offer = (await f.view()).offer!;
      await assert.rejects(f.command("approve", { revision: offer.revision, contentDigest: offer.contentDigest, expiresAt: new Date(Date.now()+3600000).toISOString() }, {}, actor), /APPROVER_REQUIRED/);
    });
    await t.test("invalid contact-lead link is refused before any offer is persisted", async () => {
      const a = await makeFixture(), b = await makeFixture();
      await assert.rejects(a.command("create", { content: content(), leadId: b.leadId }), /VALID_LEAD_REQUIRED/);
      assert.equal((await a.view()).offer, null);
    });
    await t.test("editing invalidates approval; immutable old revision remains", async () => {
      const f = await makeFixture(); await f.create(); await f.approve(); const old = (await f.view()).offer!;
      await f.command("revise", { content: { ...content(), terms: "SYNTHETIC changed scope" } });
      const edited = (await f.view()).offer!; assert.equal(edited.status, "DRAFT"); assert.equal(edited.revision, 2); assert.notEqual(edited.contentDigest, old.contentDigest);
      await assert.rejects(f.command("queue_send"), /INVALID_OFFER_TRANSITION/);
      await assert.rejects(f.command("approve", { revision: old.revision, contentDigest: old.contentDigest, expiresAt: new Date(Date.now() + 3600000).toISOString() }), /APPROVAL_SCOPE_MISMATCH/);
      await assert.rejects(db.admin.query(`update crm_offer_revisions set total_net_cents=1 where offer_id=$1`, [old.id]), /IMMUTABLE/);
    });
    await t.test("parallel commands and replay produce one queued delivery", async () => {
      const f = await makeFixture(); await f.create(); await f.approve(); const v = (await f.view()).offer!.version;
      const same = { idempotencyKey: randomUUID(), correlationId: randomUUID(), expectedVersion: v };
      const results = await Promise.all([f.command("queue_send", {}, same), f.command("queue_send", {}, same)]);
      assert.equal(results.filter(result => result.replayed).length, 1);
      await assert.rejects(f.command("queue_send", { unexpected: true }, same), /different command/);
      const count = await db.admin.query(`select count(*)::int as n from crm_offer_deliveries where workspace_id=$1`, [f.workspaceId]); assert.equal(count.rows[0].n, 1);
      assert.equal((await f.view()).offer!.status, "QUEUED");
      await assert.rejects(f.respond(true), /INVALID_OFFER_TRANSITION/);
    });
    await t.test("receipt binds recipient/content and unknown outcome cannot blindly requeue", async () => {
      const f = await makeFixture(); await f.create(); await f.approve(); await f.command("queue_send"); const offer = (await f.view()).offer!;
      const scope = { revision: offer.revision, contentDigest: offer.contentDigest, recipientEmail: offer.content.recipientEmail, reference: "SYNTHETIC receipt" };
      await assert.rejects(f.command("record_sent", { ...scope, recipientEmail: "wrong@example.invalid", sentAt: new Date().toISOString() }), /DELIVERY_SCOPE_MISMATCH/);
      await f.command("record_unknown", scope);
      await assert.rejects(f.command("queue_send"), /INVALID_OFFER_TRANSITION/);
      await assert.rejects(f.command("revoke", { reason: "SYNTHETIC stop" }), /DELIVERY_OUTCOME_UNKNOWN/);
      await f.sent(); assert.equal((await f.view()).offer!.status, "SENT");
    });
    await t.test("complete accepted flow updates existing customer and stops tasks atomically", async () => {
      const f = await makeFixture(); await f.create(); await f.approve(); await f.command("queue_send"); await f.sent();
      await f.command("schedule_follow_up", { dueAt: new Date(Date.now() + 3600000).toISOString() });
      await assert.rejects(f.command("schedule_follow_up", { dueAt: new Date(Date.now() + 7200000).toISOString() }), /FOLLOW_UP_ALREADY_SCHEDULED/);
      const result = await f.respond(true); const view = await f.view(); assert.equal(view.offer!.status, "ACCEPTED"); assert.equal(view.offer!.followUpStatus, "STOPPED");
      const state = await db.admin.query(`select d.stage,o.lifecycle_stage,(select count(*)::int from tasks t where t.workspace_id=d.workspace_id and t.status='open') as open_tasks from deals d join organizations o on o.id=d.organization_id where d.id=$1`, [f.dealId]);
      assert.deepEqual(state.rows[0], { stage: "Gewonnen", lifecycle_stage: "Kunde", open_tasks: 0 });
      assert.ok(result.auditReference); const audit = await db.admin.query(`select id from audit_logs where id=$1 and actor_user_id=$2`, [result.auditReference, f.userId]); assert.equal(audit.rowCount, 1);
      await assert.rejects(f.respond(true), /INVALID_OFFER_TRANSITION/);
      await assert.rejects(f.command("schedule_follow_up", { dueAt: new Date(Date.now() + 3600000).toISOString() }), /INVALID_OFFER_TRANSITION/);
    });
    await t.test("audit failure rolls back offer, customer, deal and follow-up outcome together", async () => {
      const f = await makeFixture(); await f.create(); await f.approve(); await f.command("queue_send"); await f.sent();
      await f.command("schedule_follow_up", { dueAt: new Date(Date.now()+3600000).toISOString() });
      await db.admin.query(`create function synthetic_offer_audit_failure() returns trigger language plpgsql as $$begin if new.action='offer.accept' then raise exception 'SYNTHETIC_AUDIT_OFFLINE'; end if; return new; end$$`);
      await db.admin.query(`create trigger synthetic_offer_audit_failure before insert on audit_logs for each row execute function synthetic_offer_audit_failure()`);
      try { await assert.rejects(f.respond(true), /SYNTHETIC_AUDIT_OFFLINE/); }
      finally { await db.admin.query(`drop trigger synthetic_offer_audit_failure on audit_logs`); await db.admin.query(`drop function synthetic_offer_audit_failure()`); }
      const after = await f.view(); assert.equal(after.offer!.status,"SENT"); assert.equal(after.offer!.followUpStatus,"SCHEDULED");
      const state = await db.admin.query(`select d.stage,o.lifecycle_stage from deals d join organizations o on o.id=d.organization_id where d.id=$1`,[f.dealId]);
      assert.deepEqual(state.rows[0],{stage:"Qualifizieren",lifecycle_stage:"Lead"});
    });
    await t.test("acceptance racing a scheduled follow-up cannot leave an open follow-up", async () => {
      const f = await makeFixture(); await f.create(); await f.approve(); await f.command("queue_send"); await f.sent();
      const offer = (await f.view()).offer!;
      const race = await Promise.allSettled([
        f.command("accept",{revision:offer.revision,contentDigest:offer.contentDigest,reference:"SYNTHETIC race acceptance"},{expectedVersion:offer.version}),
        f.command("schedule_follow_up",{dueAt:new Date(Date.now()+3600000).toISOString()},{expectedVersion:offer.version}),
      ]);
      assert.equal(race.filter(result=>result.status==="fulfilled").length,1);
      if ((await f.view()).offer!.status==="SENT") await f.respond(true);
      const tasks=await db.admin.query(`select id from tasks where workspace_id=$1 and status='open'`,[f.workspaceId]); assert.equal(tasks.rowCount,0);
    });
    await t.test("rejection records lost reason without promoting company to customer", async () => {
      const f = await makeFixture(); await f.create(); await f.approve(); await f.command("queue_send"); await f.sent(); await f.respond(false);
      const state = await db.admin.query(`select d.stage,d.lost_reason_detail,o.lifecycle_stage from deals d join organizations o on o.id=d.organization_id where d.id=$1`, [f.dealId]);
      assert.deepEqual(state.rows[0], { stage: "Verloren", lost_reason_detail: "SYNTHETIC declined", lifecycle_stage: "Lead" });
    });
    await t.test("stale CAS and direct legacy closure of managed draft fail", async () => {
      const f = await makeFixture(); await f.create(); const initial = (await f.view()).offer!; await f.approve();
      await assert.rejects(f.command("revise", { content: content() }, { expectedVersion: initial.version }), /VERSION_CONFLICT/);
      await assert.rejects(db.admin.query(`update deals set stage='Gewonnen' where id=$1`, [f.dealId]), /CRM_OFFER_ACCEPTANCE_REQUIRED/);
    });
    await t.test("revocation preserves receipt and requires fresh revision/approval", async () => {
      const f = await makeFixture(); await f.create(); await f.approve(); await f.command("queue_send"); await f.command("revoke", { reason: "SYNTHETIC withdrawn before send" });
      assert.equal((await f.view()).offer!.revision, 2); await assert.rejects(f.command("queue_send"), /INVALID_OFFER_TRANSITION/);
      await f.approve(); await f.command("queue_send");
      const rows = await db.admin.query(`select status from crm_offer_deliveries where workspace_id=$1 order by revision`, [f.workspaceId]); assert.deepEqual(rows.rows.map((row: { status: string }) => row.status), ["CANCELLED", "QUEUED"]);
    });
    await t.test("RLS hides unscoped rows and cross-tenant revision FK rejects forged insert", async () => {
      const a = await makeFixture(), b = await makeFixture(); await a.create();
      assert.equal((await db.pool.query(`select id from crm_offers`)).rowCount, 0);
      const offer = (await a.view()).offer!;
      await assert.rejects(db.admin.query(`insert into crm_offer_revisions(workspace_id,project_id,offer_id,revision,content,content_digest,total_net_cents,created_by) values($1,$2,$3,2,$4,$5,1,$6)`, [b.workspaceId, b.projectId, offer.id, JSON.stringify(content()), "a".repeat(64), b.userId]));
    });
    await t.test("migration includes enforced scope and append-only evidence", async () => {
      const constraints = await db.admin.query(`select conname from pg_constraint where conrelid='crm_offer_revisions'::regclass and contype='f'`); assert.ok(constraints.rowCount! >= 3);
      const tables = await db.admin.query(`select relrowsecurity,relforcerowsecurity from pg_class where relname in ('crm_offers','crm_offer_revisions','crm_offer_approvals','crm_offer_deliveries')`); assert.equal(tables.rowCount, 4); assert.ok(tables.rows.every((row: { relrowsecurity: boolean; relforcerowsecurity: boolean }) => row.relrowsecurity && row.relforcerowsecurity));
      const source = await readFile(new URL("../src/lib/db/offer-repositories.ts", import.meta.url), "utf8"); assert.doesNotMatch(source, /fetch\(|sendNewsletterEmail|api\.resend/);
    });
  } finally { await db.stop(); }
});

test("print isolation: real browser document contains only the approved offer, never CRM or another customer", async () => {
  const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
  try {
    const context = await browser.newContext();
    await context.route("**/*", route => route.abort());
    const page = await context.newPage();
    await page.addScriptTag({ content: `window.syntheticCreateOfferPrintFrame = ${createOfferPrintFrame.toString()};` });
    const result = await page.evaluate(() => {
      const printFrame = (window as unknown as { syntheticCreateOfferPrintFrame: (article: HTMLElement, status: string) => HTMLIFrameElement }).syntheticCreateOfferPrintFrame;
      const crm = document.createElement("aside");
      crm.textContent = "INTERNAL_CRM_NOTE OTHER_CUSTOMER_PRIVATE_DATA";
      document.body.appendChild(crm);
      const article = document.createElement("article");
      const heading = document.createElement("h4");
      heading.textContent = "SYNTHETIC approved offer revision 3";
      const text = document.createElement("p");
      text.textContent = "Buyer Example · 9900 EUR netto · <img src=x onerror=alert(1)>";
      article.append(heading, text);
      document.body.appendChild(article);
      let draftBlocked = false;
      try { printFrame(article, "DRAFT"); } catch { draftBlocked = true; }
      const framesAfterDraft = document.querySelectorAll("iframe").length;
      const frame = printFrame(article, "APPROVED");
      const doc = frame.contentDocument!;
      const printed = { text: doc.body.textContent, bodyChildren: doc.body.childElementCount, articleCount: doc.querySelectorAll("article").length, unsafeNodes: doc.querySelectorAll("script,img,iframe,aside,form,input,button").length, title: doc.title, sandbox: frame.getAttribute("sandbox"), draftBlocked, framesAfterDraft };
      frame.remove();
      return printed;
    });
    assert.equal(result.draftBlocked, true);
    assert.equal(result.framesAfterDraft, 0);
    assert.equal(result.bodyChildren, 1);
    assert.equal(result.articleCount, 1);
    assert.equal(result.unsafeNodes, 0);
    assert.equal(result.title, "Angebotsfassung");
    assert.equal(result.sandbox, "allow-same-origin allow-modals");
    assert.match(result.text!, /approved offer revision 3/);
    assert.match(result.text!, /<img src=x onerror=alert\(1\)>/);
    assert.doesNotMatch(result.text!, /INTERNAL_CRM_NOTE|OTHER_CUSTOMER_PRIVATE_DATA/);
    const component = await readFile(new URL("../src/components/offer-workflow.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(component, /window\.print\(|\.innerHTML|document\.write\(/);
    assert.match(component, /frame\.contentWindow!\.print\(\)/);
  } finally { await browser.close(); }
});
