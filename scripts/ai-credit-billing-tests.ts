import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import type { AppSession } from "../src/lib/auth/session";
import { CrmCommandError, withCrmRead, type TenantTransactionOptions } from "../src/lib/crm-command";
import { readAiCreditSnapshot, requestAiBooking, reserveAiCredits, settleAiCredits } from "../src/lib/ai-billing/repository";
import { AI_CATALOG_VERSION, AI_PLAN_CATALOG, AI_TOPUP_CATALOG } from "../src/lib/ai-billing/catalog";

let db: Awaited<ReturnType<typeof startLocalSalesDb>>, options: TenantTransactionOptions;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const monthBoundary = (months = 1) => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1)).toISOString(); };
const code = (expected: string) => (error: unknown) => error instanceof CrmCommandError && error.code === expected;
async function company() {
  const workspaceId = randomUUID(), userId = randomUUID();
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC AI billing','self_service_customer')", [workspaceId]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC Owner',$3,'owner','customer_owner','active')", [userId, workspaceId, `${userId}@example.invalid`]);
  const session: AppSession = { authenticated: true, source: "headers", workspaceId, userId, workspaceName: "SYNTHETIC", name: "Owner", email: `${userId}@example.invalid`, role: "owner", productRole: "customer_owner", permissions: ["crm:read"], productPermissions: [] };
  return session;
}
async function booking(session: AppSession, kind: "plan" | "topup", itemId: string) {
  return requestAiBooking(session, { requestId: randomUUID(), kind, itemId, expectedCatalogVersion: AI_CATALOG_VERSION }, options);
}
async function fulfill(id: string, order = randomUUID(), paidThrough: string | null = null) {
  return (await db.admin.query("select crm_ai_fulfill_booking($1::uuid,$2,$3,$4::timestamptz) as result", [id, order, digest(order), paidThrough])).rows[0].result;
}
before(async () => {
  db = await startLocalSalesDb(); await applySalesSchema(db, { maxMigrationNumber: 106 });
  await db.admin.query(await readFile("migrations/146_ai_credit_billing.sql", "utf8"));
  options = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
});
after(async () => { if (db) await db.stop(); });

test("new tenants receive one workspace quota, never one quota per user", async () => {
  const session = await company(), snapshot = await readAiCreditSnapshot(session, options);
  assert.equal(snapshot.planId, "included"); assert.equal(snapshot.availableCredits, 1000); assert.equal(snapshot.canBook, true);
  assert.equal(new Date(snapshot.periodStart).getUTCDate(), 1); assert.equal(new Date(snapshot.periodEnd).getUTCDate(), 1);
  const otherUser = randomUUID();
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC Team',$3,'agent','team_member','active')", [otherUser, session.workspaceId, `${otherUser}@example.invalid`]);
  const team = await readAiCreditSnapshot({ ...session, userId: otherUser }, options);
  assert.equal(team.monthlyCredits, 1000); assert.equal(team.canBook, false); assert.equal(team.canRequestWebsite, true);
  assert.equal((await db.admin.query("select count(*) from ai_credit_buckets where workspace_id=$1", [session.workspaceId])).rows[0].count, "1");
});
test("parallel reservations cannot overspend the pooled quota", async () => {
  const session = await company();
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => reserveAiCredits(session, { requestId: randomUUID(), operation: "chat.reply", credits: 200 }, options)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 5);
  for (const result of results) if (result.status === "rejected") assert.ok(code("AI_CREDITS_EXHAUSTED")(result.reason));
  const snapshot = await readAiCreditSnapshot(session, options);
  assert.equal(snapshot.availableCredits, 0); assert.equal(snapshot.reservedCredits, 1000);
});
test("reservation replay is stable; changed purpose or actor cannot reuse its ID", async () => {
  const session = await company(), input = { requestId: randomUUID(), operation: "chat.reply", credits: 300, metadata: { model: "allowed", requestHash: digest("first") } };
  const first = await reserveAiCredits(session, input, options), second = await reserveAiCredits(session, input, options);
  assert.equal(second.reservationId, first.reservationId); assert.equal(second.replayed, true);
  await assert.rejects(reserveAiCredits(session, { ...input, metadata: { model: "changed" } }, options), code("IDEMPOTENCY_CONFLICT"));
  assert.equal((await readAiCreditSnapshot(session, options)).availableCredits, 700);
});
test("settlement charges actual use once, returns unused reservation, and rejects contradictory retries", async () => {
  const session = await company(), requestId = randomUUID();
  await reserveAiCredits(session, { requestId, operation: "chat.reply", credits: 600 }, options);
  await assert.rejects(settleAiCredits(session, { requestId, actualCredits: 601, status: "succeeded" }, options), code("AI_BILLING_INVALID"));
  await settleAiCredits(session, { requestId, actualCredits: 250, status: "succeeded" }, options);
  assert.equal((await settleAiCredits(session, { requestId, actualCredits: 250, status: "succeeded" }, options)).replayed, true);
  await assert.rejects(settleAiCredits(session, { requestId, actualCredits: 0, status: "failed" }, options), code("IDEMPOTENCY_CONFLICT"));
  const snapshot = await readAiCreditSnapshot(session, options); assert.equal(snapshot.availableCredits, 750); assert.equal(snapshot.usedCredits, 250); assert.equal(snapshot.reservedCredits, 0);
});
test("unknown provider results remain reserved, confirmed unbilled failures release credits", async () => {
  const session = await company(), requestId = randomUUID();
  await reserveAiCredits(session, { requestId, operation: "chat.reply", credits: 400 }, options);
  assert.equal((await readAiCreditSnapshot(session, options)).reservedCredits, 400);
  await settleAiCredits(session, { requestId, actualCredits: 0, status: "failed" }, options);
  assert.equal((await readAiCreditSnapshot(session, options)).availableCredits, 1000);
});
test("booking alone grants nothing; trusted top-up fulfillment is globally idempotent", async () => {
  const session = await company(), request = await booking(session, "topup", "credits_5000"), order = randomUUID();
  assert.equal(request.amountCents, 2900); assert.equal(request.status, "pending"); assert.equal((await readAiCreditSnapshot(session, options)).topupRemaining, 0);
  assert.equal((await fulfill(request.id, order)).replayed, false); assert.equal((await fulfill(request.id, order)).replayed, true);
  assert.equal((await readAiCreditSnapshot(session, options)).topupRemaining, 5000);
  const other = await company(), otherRequest = await booking(other, "topup", "credits_5000");
  await assert.rejects(fulfill(otherRequest.id, order), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(db.admin.query("select crm_ai_fulfill_booking($1,$2,$3,null)", [request.id, order, digest("changed")]), /IDEMPOTENCY_CONFLICT/);
  assert.equal((await readAiCreditSnapshot(other, options)).topupRemaining, 0);
});
test("monthly credits are spent before nonexpiring top-ups", async () => {
  const session = await company(); await fulfill((await booking(session, "topup", "credits_5000")).id);
  const requestId = randomUUID(); await reserveAiCredits(session, { requestId, operation: "chat.reply", credits: 1200 }, options);
  await settleAiCredits(session, { requestId, actualCredits: 1100, status: "succeeded" }, options);
  const snapshot = await readAiCreditSnapshot(session, options); assert.equal(snapshot.monthlyRemaining, 0); assert.equal(snapshot.topupRemaining, 4900); assert.equal(snapshot.usedCredits, 1100);
  // Prior-month top-up usage must not inflate the current month's usage counter.
  await db.admin.query("update ai_credit_reservations set created_at=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'-interval '1 second' where workspace_id=$1 and request_id=$2", [session.workspaceId, requestId]);
  assert.equal((await readAiCreditSnapshot(session, options)).usedCredits, 0);
});
test("new calendar month cannot inherit unused monthly credits or refunds from an expired month", async () => {
  const session = await company(), requestId = randomUUID();
  await fulfill((await booking(session, "topup", "credits_5000")).id);
  await reserveAiCredits(session, { requestId, operation: "chat.reply", credits: 800 }, options);
  await db.admin.query("update ai_credit_buckets set grant_key='month:SYNTHETIC-previous',expires_at=now()-interval '1 second' where workspace_id=$1 and kind='monthly'", [session.workspaceId]);
  let snapshot = await readAiCreditSnapshot(session, options); assert.equal(snapshot.monthlyRemaining, 1000); assert.equal(snapshot.topupRemaining, 5000);
  await settleAiCredits(session, { requestId, actualCredits: 0, status: "failed" }, options);
  snapshot = await readAiCreditSnapshot(session, options); assert.equal(snapshot.monthlyRemaining, 1000); assert.equal(snapshot.availableCredits, 6000);
});
test("paid plan uses total quota, expiry falls back to base, cancellation honors paid-through", async () => {
  const session = await company(), requestId = randomUUID(); await reserveAiCredits(session, { requestId, operation: "chat.reply", credits: 100 }, options); await settleAiCredits(session, { requestId, actualCredits: 100, status: "succeeded" }, options);
  await fulfill((await booking(session, "plan", "ai_plus")).id, randomUUID(), monthBoundary());
  let snapshot = await readAiCreditSnapshot(session, options); assert.equal(snapshot.monthlyCredits, 21000); assert.equal(snapshot.monthlyRemaining, 20900);
  await fulfill((await booking(session, "plan", "included")).id);
  snapshot = await readAiCreditSnapshot(session, options); assert.equal(snapshot.cancelAtPeriodEnd, true); assert.equal(snapshot.planId, "ai_plus");
  await db.admin.query("update ai_credit_accounts set paid_through=now()-interval '1 second' where workspace_id=$1", [session.workspaceId]);
  snapshot = await readAiCreditSnapshot(session, options); assert.equal(snapshot.planId, "included"); assert.equal(snapshot.monthlyCredits, 1000); assert.equal(snapshot.monthlyRemaining, 900);
});
test("tenant SQL cannot mint credits, grant a paid plan, or inspect a different tenant", async () => {
  const session = await company(), other = await company(); await readAiCreditSnapshot(other, options);
  const request = await booking(session, "topup", "credits_5000");
  await assert.rejects(withCrmRead(session, tx => tx.execute("update ai_credit_buckets set granted=100000 where workspace_id=$1", [session.workspaceId]), options), /permission denied/);
  await assert.rejects(withCrmRead(session, tx => tx.query("select crm_ai_fulfill_booking($1,$2,$3,null)", [request.id, randomUUID(), digest("forged")]), options), /permission denied/);
  await assert.rejects(withCrmRead(session, tx => tx.query("select crm_ai_refresh($1)", [session.workspaceId]), options), /permission denied/);
  assert.equal((await withCrmRead(session, tx => tx.query("select * from ai_credit_accounts where workspace_id=$1", [other.workspaceId]), options)).length, 0);
  await assert.rejects(readAiCreditSnapshot({ ...session, workspaceId: other.workspaceId }, options), code("FORBIDDEN"));
});
test("reservation commits independently of an outer CRM transaction rollback", async () => {
  const session = await company(), requestId = randomUUID();
  await assert.rejects(withCrmRead(session, async () => { await reserveAiCredits(session, { requestId, operation: "chat.reply", credits: 200 }, options); throw new Error("SYNTHETIC outer failure"); }, options), /SYNTHETIC outer failure/);
  assert.equal((await readAiCreditSnapshot(session, options)).reservedCredits, 200);
});
test("SQL commercial mirror matches the provisional server catalogue", async () => {
  const session = await company();
  for (const plan of AI_PLAN_CATALOG) {
    const request = await booking(session, "plan", plan.id); assert.equal(request.amountCents, plan.priceCents);
    if (plan.id !== "included") { await fulfill(request.id, randomUUID(), monthBoundary()); assert.equal((await readAiCreditSnapshot(session, options)).monthlyCredits, plan.monthlyCredits); }
  }
  for (const topup of AI_TOPUP_CATALOG) {
    const before = (await readAiCreditSnapshot(session, options)).topupRemaining, request = await booking(session, "topup", topup.id);
    assert.equal(request.amountCents, topup.priceCents); await fulfill(request.id); assert.equal((await readAiCreditSnapshot(session, options)).topupRemaining - before, topup.credits);
  }
  assert.equal(AI_PLAN_CATALOG[0].monthlyCredits, 1000);
});
test("operators can reconcile unknown outcomes after actor revocation with immutable idempotent evidence", async () => {
  const session = await company(), requestId = randomUUID();
  const held = await reserveAiCredits(session, { requestId, operation: "chat.reply", credits: 300, metadata: { model: "openai/allowed", meterVersion: "synthetic-v1", requestHash: digest("synthetic"), inputTokenBound: 100, maxOutputTokens: 200 } }, options);
  await assert.rejects(withCrmRead(session, tx => tx.query("select crm_ai_reconcile_reservation($1,0,'failed',$2,$3)", [held.reservationId, randomUUID(), digest("forged")]), options), /permission denied/);
  await assert.rejects(withCrmRead(session, tx => tx.query("select crm_ai_operator_requests(null,'pending')"), options), /permission denied/);
  const pending = (await db.admin.query("select crm_ai_operator_reservations($1) as result", [session.workspaceId])).rows[0].result;
  assert.equal(pending.length, 1); assert.equal(pending[0].metadata.meterVersion, "synthetic-v1"); assert.equal("prompt" in pending[0].metadata, false);
  await db.admin.query("update workspace_users set status='suspended' where id=$1", [session.userId]);
  const reference = randomUUID(), params = [held.reservationId, 120, "succeeded", reference, digest(reference)];
  assert.equal((await db.admin.query("select crm_ai_reconcile_reservation($1,$2,$3,$4,$5) as result", params)).rows[0].result.replayed, false);
  assert.equal((await db.admin.query("select crm_ai_reconcile_reservation($1,$2,$3,$4,$5) as result", params)).rows[0].result.replayed, true);
  await assert.rejects(db.admin.query("select crm_ai_reconcile_reservation($1,0,'failed',$2,$3)", [held.reservationId, reference, digest(reference)]), /IDEMPOTENCY_CONFLICT/);
  const bucket = (await db.admin.query("select spent,reserved from ai_credit_buckets where workspace_id=$1 and kind='monthly'", [session.workspaceId])).rows[0]; assert.equal(bucket.spent, 120); assert.equal(bucket.reserved, 0);
  assert.equal((await db.admin.query("select count(*) from ai_credit_reconciliations where reservation_id=$1", [held.reservationId])).rows[0].count, "1");
});
test("website follow-up closes a quote request without activating AI and remains operator-only", async () => {
  const session = await company(), request = await requestAiBooking(session, { requestId: randomUUID(), kind: "website", itemId: "real_estate_website", expectedCatalogVersion: AI_CATALOG_VERSION, notes: "SYNTHETIC quotation", requestedServices: ["hosting"] }, options);
  await assert.rejects(fulfill(request.id), /AI_FULFILLMENT_INVALID/);
  await assert.rejects(withCrmRead(session, tx => tx.query("select crm_ai_close_booking($1,'fulfilled')", [request.id]), options), /permission denied/);
  await db.admin.query("select crm_ai_close_booking($1,'fulfilled')", [request.id]); await db.admin.query("select crm_ai_close_booking($1,'fulfilled')", [request.id]);
  const snapshot = await readAiCreditSnapshot(session, options); assert.equal(snapshot.bookings[0].status, "fulfilled"); assert.equal(snapshot.availableCredits, 1000);
  assert.equal((await db.admin.query("select count(*) from ai_booking_status_events where request_id=$1", [request.id])).rows[0].count, "1");
});
test("paid periods require exact UTC month boundaries and reject shortening or active-plan downgrade", async () => {
  const session = await company(), plus = await booking(session, "plan", "ai_plus");
  const arbitraryFuture = new Date(new Date(monthBoundary()).getTime() + 14 * 86400000 + 12 * 3600000).toISOString();
  await assert.rejects(fulfill(plus.id, randomUUID(), arbitraryFuture), /AI_PAID_PERIOD_INVALID/);
  await assert.rejects(fulfill(plus.id, randomUUID(), new Date(new Date(monthBoundary()).getTime() + 3600000).toISOString()), /AI_PAID_PERIOD_INVALID/);
  assert.equal((await readAiCreditSnapshot(session, options)).planId, "included");
  await fulfill(plus.id, randomUUID(), monthBoundary(2));
  const shorter = await booking(session, "plan", "ai_plus");
  await assert.rejects(fulfill(shorter.id, randomUUID(), monthBoundary()), /AI_PAID_PERIOD_REGRESSION/);
  assert.equal((await db.admin.query("select status from ai_billing_requests where id=$1", [shorter.id])).rows[0].status, "pending");
  const renewal = await booking(session, "plan", "ai_plus"); await fulfill(renewal.id, randomUUID(), monthBoundary(3));
  const upgrade = await booking(session, "plan", "ai_pro"); await fulfill(upgrade.id, randomUUID(), monthBoundary(3));
  const downgrade = await booking(session, "plan", "ai_plus");
  await assert.rejects(fulfill(downgrade.id, randomUUID(), monthBoundary(4)), /AI_DOWNGRADE_REQUIRES_PERIOD_END/);
  const snapshot = await readAiCreditSnapshot(session, options); assert.equal(snapshot.planId, "ai_pro"); assert.equal(new Date(snapshot.paidThrough!).toISOString(), monthBoundary(3));
  await fulfill((await booking(session, "plan", "included")).id);
  assert.equal((await readAiCreditSnapshot(session, options)).planId, "ai_pro");
  // An expired stronger plan can be replaced by a newly confirmed lower plan.
  await db.admin.query("update ai_credit_accounts set paid_through=now()-interval '1 second' where workspace_id=$1", [session.workspaceId]);
  await fulfill(downgrade.id, randomUUID(), monthBoundary());
  assert.equal((await readAiCreditSnapshot(session, options)).planId, "ai_plus");
});
