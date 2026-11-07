import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { AI_CATALOG_VERSION } from "../src/lib/ai-billing/catalog";

test("internal billing administration activates only confirmed requests under durable admin authority", { timeout: 240_000 }, async (t) => {
  const db = await startLocalSalesDb();
  const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "NOVALURE_DEMO_AUTH_ENABLED", "NOVALURE_TRUST_AUTH_HEADERS", "VERCEL", "VERCEL_ENV", "VERCEL_URL"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    await db.admin.query(await readFile("migrations/146_ai_credit_billing.sql", "utf8"));
    await db.admin.query(await readFile("migrations/152_ai_billing_admin.sql", "utf8"));
    const admin = await seedSalesBrowser(db), customer = await seedSalesBrowser(db), foreign = await seedSalesBrowser(db);
    await db.admin.query("update workspace_users set role='admin' where id=$1", [admin.userId]);
    for (const [person, name] of [[customer, "SYNTHETIC Billing customer A"], [foreign, "SYNTHETIC Billing customer B"]] as const) {
      await db.admin.query("update workspaces set name=$2,operating_model='self_service_customer' where id=$1", [person.workspaceId, name]);
      await db.admin.query("update workspace_users set product_role='customer_owner' where id=$1", [person.userId]);
    }
    const secret = randomBytes(48).toString("base64url"), origin = "http://127.0.0.1:3000", pathname = "/api/admin/ai-billing", customerPath = "/api/crm/ai-billing";
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret, NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    async function cookieFor(person: typeof admin) {
      const cookie = "v2." + randomBytes(32).toString("base64url");
      await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [randomUUID(), createHash("sha256").update(cookie).digest("hex"), person.authIdentityId, person.userId, person.workspaceId]);
      return cookie;
    }
    const adminCookie = await cookieFor(admin), customerCookie = await cookieFor(customer), foreignCookie = await cookieFor(foreign);
    const route = await import("../src/app/api/admin/ai-billing/route"), customerRoute = await import("../src/app/api/crm/ai-billing/route");
    function request(method = "GET", body?: unknown, options: { cookie?: string; path?: string; headers?: Record<string, string> } = {}) {
      const cookie = options.cookie ?? adminCookie, path = options.path ?? pathname;
      return new Request(origin + path, { method, headers: {
        cookie: "novalure_session=" + cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { origin, "sec-fetch-site": "same-origin", "idempotency-key": randomUUID(), "x-novalure-csrf-token": createCsrfToken({ method, pathname: path.split("?", 1)[0], secret, sessionCookie: cookie })!.token }),
        ...options.headers,
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }
    async function execute(method: "GET" | "POST", body?: unknown, expected = 200, options: Parameters<typeof request>[2] = {}) {
      const response = await route[method](request(method, body, options));
      assert.equal(response.status, expected, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      return response.json();
    }
    async function customerSnapshot(cookie = customerCookie) {
      const response = await customerRoute.GET(request("GET", undefined, { cookie, path: customerPath }));
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).data;
    }
    async function booking(kind: "plan" | "topup" | "website", itemId: string, cookie = customerCookie) {
      const response = await customerRoute.POST(request("POST", { kind, itemId, catalogVersion: AI_CATALOG_VERSION }, { cookie, path: customerPath }));
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json()).data;
    }
    const topup = await booking("topup", "credits_5000"), plan = await booking("plan", "ai_plus"), website = await booking("website", "real_estate_website");
    const foreignTopup = await booking("topup", "credits_20000", foreignCookie);
    const fulfillTopup = { action: "fulfill", requestId: topup.id, reference: "SYNTHETIC-PAID-TOPUP-001" };

    await t.test("anonymous, preview identities, duplicate cookies and missing CSRF cannot administer", async () => {
      assert.equal((await route.GET(new Request(origin + pathname))).status, 401);
      process.env.NOVALURE_TRUST_AUTH_HEADERS = "1";
      try {
        assert.equal((await route.GET(new Request(origin + pathname, { headers: { "x-novalure-workspace-id": admin.workspaceId, "x-novalure-user-id": admin.userId, "x-novalure-role": "owner", "x-novalure-product-role": "novalureAdmin" } }))).status, 401);
      } finally { delete process.env.NOVALURE_TRUST_AUTH_HEADERS; }
      await execute("GET", undefined, 401, { headers: { cookie: `novalure_session=${adminCookie}; novalure_session=${adminCookie}` } });
      await execute("POST", fulfillTopup, 403, { headers: { "x-novalure-csrf-token": "" } });
      await execute("POST", fulfillTopup, 403, { headers: { origin: "https://foreign.example.invalid" } });
    });
    await t.test("customer owners and forged scope or role selectors cannot self-grant credits", async () => {
      await execute("GET", undefined, 403, { cookie: customerCookie });
      await execute("POST", fulfillTopup, 403, { cookie: customerCookie });
      await execute("POST", { ...fulfillTopup, requestId: foreignTopup.id }, 403, { cookie: customerCookie });
      await execute("GET", undefined, 403, { cookie: customerCookie, path: pathname + "?workspaceId=" + admin.workspaceId });
      await execute("GET", undefined, 403, { cookie: customerCookie, headers: { "x-novalure-role": "owner", "x-novalure-product-role": "novalureAdmin" } });
      await db.admin.query("update workspace_users set product_role='novalureAdmin' where id=$1", [customer.userId]);
      try { await execute("GET", undefined, 403, { cookie: customerCookie }); }
      finally { await db.admin.query("update workspace_users set product_role='customer_owner' where id=$1", [customer.userId]); }
      assert.equal((await customerSnapshot()).availableCredits, 1000);
      assert.equal((await customerSnapshot(foreignCookie)).availableCredits, 1000);
    });
    await t.test("the standard workspace switch preserves explicit internal admin membership", async () => {
      const targetMemberId = randomUUID();
      await db.admin.query("insert into workspace_users(id,workspace_id,auth_identity_id,name,email,role,product_role,status) values($1,$2,$3,'SYNTHETIC switched billing admin',$4,'admin','novalureAdmin','active')", [targetMemberId, admin.workspaceId, customer.authIdentityId, customer.email]);
      await db.admin.query("update workspace_users set product_role='novalureAdmin' where id=$1", [customer.userId]);
      const selectedPath = pathname + "?workspaceId=" + admin.workspaceId;
      try {
        const selected = await execute("GET", undefined, 200, { cookie: customerCookie, path: selectedPath });
        assert.equal(selected.persisted, true);
        await execute("GET", undefined, 400, { cookie: customerCookie, path: selectedPath + "&workspaceId=" + customer.workspaceId });
        await db.admin.query("update workspace_users set status='invited' where id=$1", [targetMemberId]);
        await execute("GET", undefined, 403, { cookie: customerCookie, path: selectedPath });
      } finally { await db.admin.query("update workspace_users set product_role='customer_owner' where id=$1", [customer.userId]); }
    });
    await t.test("internal admins see pending companies and apply one idempotent topup", async () => {
      const overview = (await execute("GET")).data;
      const serialized = JSON.stringify(overview);
      assert.match(serialized, /SYNTHETIC Billing customer A/); assert.match(serialized, /SYNTHETIC Billing customer B/);
      assert.ok(serialized.includes(topup.id)); assert.ok(serialized.includes(foreignTopup.id));
      const idempotencyKey = randomUUID(), options = { headers: { "idempotency-key": idempotencyKey } };
      assert.equal((await execute("POST", fulfillTopup, 200, options)).persisted, true);
      await execute("POST", fulfillTopup, 200, options);
      await execute("POST", { ...fulfillTopup, reference: "SYNTHETIC-DIFFERENT-REFERENCE" }, 409, options);
      const snapshot = await customerSnapshot(); assert.equal(snapshot.topupRemaining, 5000); assert.equal(snapshot.availableCredits, 6000);
      assert.equal((await customerSnapshot(foreignCookie)).availableCredits, 1000);
    });
    await t.test("confirmed plans use UTC periods and website closure creates no AI grant", async () => {
      const now = new Date(), paidThrough = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
      await execute("POST", { action: "fulfill", requestId: plan.id, reference: "SYNTHETIC-PLAN-001", paidThrough }, 200);
      const activated = await customerSnapshot(); assert.equal(activated.planId, "ai_plus"); assert.equal(activated.monthlyCredits, 21000);
      await execute("POST", { action: "close", requestId: website.id, reference: "SYNTHETIC-WEBSITE-QUOTE-001", status: "fulfilled" }, 200);
      const closed = await customerSnapshot(); assert.equal(closed.availableCredits, activated.availableCredits);
      assert.equal(closed.bookings.find((row: { id: string }) => row.id === website.id).status, "fulfilled");
    });
    await t.test("operator reconciliation settles a real reservation without requiring the original actor", async () => {
      const { reserveAiCredits } = await import("../src/lib/ai-billing/repository"), { getRequestSession } = await import("../src/lib/auth/session");
      const session = await getRequestSession(request("GET", undefined, { cookie: customerCookie, path: customerPath })); assert.ok(session);
      const held = await reserveAiCredits(session, { requestId: randomUUID(), operation: "chat", credits: 30 });
      const before = await customerSnapshot(); assert.equal(before.reservedCredits, 30);
      await execute("POST", { action: "reconcile", requestId: held.reservationId, reference: "SYNTHETIC-PROVIDER-RECEIPT-001", status: "succeeded", credits: 5 }, 200);
      const after = await customerSnapshot(); assert.equal(after.reservedCredits, 0); assert.equal(after.availableCredits, before.availableCredits + 25);
    });
    await t.test("strict payload validation and fresh role revocation reject administration", async () => {
      await execute("POST", { ...fulfillTopup, workspaceId: foreign.workspaceId }, 400);
      await execute("POST", { ...fulfillTopup, credits: 999_999 }, 400);
      await execute("POST", { ...fulfillTopup, paidThrough: "2027-01-01" }, 400);
      await execute("POST", { action: "reconcile", requestId: randomUUID(), reference: "SYNTHETIC-INVALID", status: "failed", credits: 1 }, 400);
      await execute("POST", fulfillTopup, 400, { headers: { "idempotency-key": "forged" } });
      await execute("POST", fulfillTopup, 415, { headers: { "content-type": "text/plain" } });
      const oversized = request("POST", fulfillTopup); oversized.headers.set("content-length", "1");
      const response = await route.POST(new Request(oversized.url, { method: "POST", headers: oversized.headers, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(9000))); controller.close(); } }), duplex: "half" } as RequestInit));
      assert.equal(response.status, 413);
      await db.admin.query("update workspace_users set role='agent',product_role='novalureAdmin' where id=$1", [admin.userId]);
      try { await execute("GET", undefined, 403); await execute("POST", fulfillTopup, 403); }
      finally { await db.admin.query("update workspace_users set role='admin',product_role='novalureAdmin' where id=$1", [admin.userId]); }
      await db.admin.query("update workspaces set operating_model='self_service_customer' where id=$1", [admin.workspaceId]);
      try { await execute("GET", undefined, 403); }
      finally { await db.admin.query("update workspaces set operating_model='novalure_internal' where id=$1", [admin.workspaceId]); }
    });
  } finally {
    await closeLocalTestPool();
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    await db.stop();
  }
});
