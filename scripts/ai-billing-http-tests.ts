import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { AI_CATALOG_VERSION } from "../src/lib/ai-billing/catalog";

test("AI booking HTTP uses durable tenant authority and records pending requests without activating credits", { timeout: 240_000 }, async (t) => {
  const db = await startLocalSalesDb();
  const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "NOVALURE_DEMO_AUTH_ENABLED", "NOVALURE_TRUST_AUTH_HEADERS", "VERCEL", "VERCEL_ENV", "VERCEL_URL"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    await applySalesSchema(db, { maxMigrationNumber: 146 });
    const owner = await seedSalesBrowser(db), foreign = await seedSalesBrowser(db);
    await db.admin.query("update workspaces set operating_model='self_service_customer' where id=$1", [owner.workspaceId]);
    await db.admin.query("update workspace_users set product_role='customer_owner' where id=$1", [owner.userId]);
    const origin = "http://127.0.0.1:3000", pathname = "/api/crm/ai-billing";
    const secret = randomBytes(48).toString("base64url");
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret, NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    async function sessionCookie(userId: string, identityId: string) {
      const cookie = "v2." + randomBytes(32).toString("base64url");
      await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [randomUUID(), createHash("sha256").update(cookie).digest("hex"), identityId, userId, owner.workspaceId]);
      return cookie;
    }
    const ownerCookie = await sessionCookie(owner.userId, owner.authIdentityId);
    const memberId = randomUUID();
    const member = (await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$2,'SYNTHETIC AI team member',$3,'agent','team_member','active',now()) returning auth_identity_id", [memberId, owner.workspaceId, `ai-member-${memberId}@example.invalid`])).rows[0];
    await db.admin.query("update auth_identities set credential_state='active',password_hash=(select password_hash from auth_identities where id=$2) where id=$1", [member.auth_identity_id, owner.authIdentityId]);
    const memberCookie = await sessionCookie(memberId, member.auth_identity_id);
    const route = await import("../src/app/api/crm/ai-billing/route");
    function request(method = "GET", body?: unknown, options: { cookie?: string; path?: string; headers?: Record<string, string> } = {}) {
      const cookie = options.cookie ?? ownerCookie, path = options.path ?? pathname;
      return new Request(origin + path, { method, headers: {
        cookie: "novalure_session=" + cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { origin, "sec-fetch-site": "same-origin", "idempotency-key": randomUUID(), "x-novalure-csrf-token": createCsrfToken({ method, pathname, secret, sessionCookie: cookie })!.token }),
        ...options.headers,
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }
    async function execute(method: "GET" | "POST", body?: unknown, expected = 200, options: Parameters<typeof request>[2] = {}) {
      const response = await route[method](request(method, body, options));
      assert.equal(response.status, expected, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("vary"), "Cookie");
      return response.json();
    }
    const topup = { kind: "topup", itemId: "credits_5000", catalogVersion: AI_CATALOG_VERSION };
    const website = { kind: "website", itemId: "real_estate_website", catalogVersion: AI_CATALOG_VERSION, requestedServices: ["website_creation", "hosting"], notes: "SYNTHETIC quote request" };
    await t.test("anonymous, header identities, duplicate cookies and missing CSRF fail closed", async () => {
      const anonymous = await route.GET(new Request(origin + pathname));
      assert.equal(anonymous.status, 401); assert.equal(anonymous.headers.get("cache-control"), "private, no-store");
      process.env.NOVALURE_TRUST_AUTH_HEADERS = "1";
      try {
        const headerIdentity = await route.GET(new Request(origin + pathname, { headers: { "x-novalure-workspace-id": owner.workspaceId, "x-novalure-user-id": owner.userId, "x-novalure-role": "owner", "x-novalure-product-role": "novalureAdmin" } }));
        assert.equal(headerIdentity.status, 401);
      } finally { delete process.env.NOVALURE_TRUST_AUTH_HEADERS; }
      await execute("GET", undefined, 401, { headers: { cookie: `novalure_session=${ownerCookie}; novalure_session=${ownerCookie}` } });
      await execute("POST", topup, 403, { headers: { "x-novalure-csrf-token": "" } });
      await execute("POST", topup, 403, { headers: { origin: "https://foreign.example.invalid" } });
    });
    await t.test("tenant and price authority cannot be supplied by the caller", async () => {
      await execute("GET", undefined, 403, { path: pathname + "?workspaceId=" + foreign.workspaceId });
      await execute("GET", undefined, 400, { path: pathname + "?workspaceId=" + owner.workspaceId + "&workspaceId=" + foreign.workspaceId });
      await execute("GET", undefined, 400, { path: pathname + "?customerId=foreign" });
      for (const forged of [{ workspaceId: foreign.workspaceId }, { priceCents: 1 }, { credits: 999_999 }, { requestId: randomUUID() }]) {
        await execute("POST", { ...topup, ...forged }, 400);
      }
      await execute("POST", topup, 400, { headers: { "idempotency-key": "not-a-uuid" } });
      await execute("POST", { ...topup, catalogVersion: "obsolete" }, 409);
      await execute("POST", { ...topup, itemId: "not_a_real_package" }, 400);
      await execute("POST", { ...topup, notes: "AI packages do not accept website data" }, 400);
    });
    await t.test("pending idempotent booking stores the trusted offer without activating or charging", async () => {
      const before = (await execute("GET")).data;
      const requestId = randomUUID(), options = { headers: { "idempotency-key": requestId } };
      const first = (await execute("POST", topup, 201, options)).data;
      const replay = (await execute("POST", topup, 201, options)).data;
      assert.equal(first.id, replay.id); assert.equal(first.requestId, requestId); assert.equal(first.status, "pending");
      assert.equal(first.catalogVersion, AI_CATALOG_VERSION);
      await execute("POST", { ...topup, itemId: "credits_20000" }, 409, options);
      const after = (await execute("GET")).data;
      assert.equal(after.planId, before.planId);
      assert.equal(after.monthlyRemaining, before.monthlyRemaining);
      assert.equal(after.topupRemaining, before.topupRemaining);
      assert.equal(after.availableCredits, before.availableCredits);
      assert.equal(after.bookings.filter((booking: { requestId: string }) => booking.requestId === requestId).length, 1);
    });
    await t.test("team members read company usage and request websites but cannot book AI", async () => {
      const snapshot = (await execute("GET", undefined, 200, { cookie: memberCookie })).data;
      assert.equal(snapshot.canBook, false); assert.equal(snapshot.canRequestWebsite, true);
      assert.deepEqual(snapshot.bookings, []);
      for (const forbidden of ["providerCost", "providerRates", "inputUsdPerMillion", "outputUsdPerMillion", "costMargin"]) assert.equal(forbidden in snapshot, false);
      await execute("POST", topup, 403, { cookie: memberCookie });
      const booking = (await execute("POST", website, 201, { cookie: memberCookie })).data;
      assert.equal(booking.kind, "website"); assert.equal(booking.amountCents, null); assert.equal(booking.status, "pending");
      const after = (await execute("GET", undefined, 200, { cookie: memberCookie })).data;
      assert.equal(after.availableCredits, snapshot.availableCredits);
      assert.equal(after.bookings.length, 1); assert.equal(after.bookings[0].id, booking.id);
      await execute("POST", { ...website, requestedServices: ["website_creation", "unknown"] }, 400, { cookie: memberCookie });
      await execute("POST", { ...website, notes: "x".repeat(2_001) }, 400, { cookie: memberCookie });
    });
    await t.test("role revocation and malformed streamed bodies cannot create requests", async () => {
      await db.admin.query("update workspace_users set role='agent',product_role='team_member' where id=$1", [owner.userId]);
      try { await execute("POST", topup, 403); }
      finally { await db.admin.query("update workspace_users set role='owner',product_role='customer_owner' where id=$1", [owner.userId]); }
      const invalid = request("POST", topup);
      const malformed = await route.POST(new Request(invalid.url, { method: "POST", headers: invalid.headers, body: "{" }));
      assert.equal(malformed.status, 400);
      const oversized = request("POST", topup); oversized.headers.set("content-length", "1");
      const streamed = await route.POST(new Request(oversized.url, { method: "POST", headers: oversized.headers, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(9_000))); controller.close(); } }), duplex: "half" } as RequestInit));
      assert.equal(streamed.status, 413);
      await execute("POST", topup, 415, { headers: { "content-type": "text/plain" } });
      await db.admin.query("update workspace_users set status='invited' where id=$1", [memberId]);
      const revoked = await route.GET(request("GET", undefined, { cookie: memberCookie }));
      assert.ok([401, 403].includes(revoked.status));
    });
  } finally {
    await closeLocalTestPool();
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    await db.stop();
  }
});
