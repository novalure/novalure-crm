import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { GET, POST } from "../src/app/api/crm/properties/route";
import { createPropertyGeography } from "../src/lib/property-country";
import { createPropertyCoreDraft, propertyCoreUpdatePayload } from "../src/lib/property-core-editing";
import { propertyCoreNumberIsKnown, propertyOptionalPriceIsKnown } from "../src/lib/property-core-numbers";

test("property direct creation validates, commits once and rechecks cookie authority", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    await applySalesSchema(db);
    const fixture = await seedSalesBrowser(db);
    const secret = randomBytes(48).toString("base64url"), origin = "http://127.0.0.1:3000";
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret,
      NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    const cookie = "v2." + randomBytes(32).toString("base64url");
    await db.admin.query("update auth_identities set mfa_enabled_at=now(),mfa_secret_ciphertext='SYNTHETIC-NOT-A-REAL-SECRET' where id=$1", [fixture.authIdentityId]);
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [randomUUID(), createHash("sha256").update(cookie).digest("hex"), fixture.authIdentityId, fixture.userId, fixture.workspaceId]);
    const path = `/api/crm/properties?workspaceId=${fixture.workspaceId}`;
    const base = { operation: "create_property", projectId: fixture.projectId, title: "SYNTHETIC direct create", address: "SYNTHETIC Musterstraße 1", geography: createPropertyGeography("AT", "Wien"), energyCertificate: { version: 1, countryCode: "AT" },
      areaSqm: "82,25", rooms: "3,5", yearBuilt: "2000", price: "250000,12", objectType: "Wohnung", usageType: "residential", marketingType: "sale", priceVisibility: "price_on_request" };
    const request = (body: unknown, key = randomUUID(), correlation = randomUUID(), csrf = true, signedIn = true) => new Request(origin + path, { method: "POST", headers: {
      "content-type": "application/json", origin, "sec-fetch-site": "same-origin", "Idempotency-Key": key, "X-Correlation-Id": correlation,
      ...(signedIn ? { cookie: "novalure_session=" + cookie } : {}), ...(csrf ? { "x-novalure-csrf-token": createCsrfToken({ method: "POST", pathname: "/api/crm/properties", secret, sessionCookie: cookie })!.token } : {}),
    }, body: JSON.stringify(body) });
    const counts = () => db.admin.query("select (select count(*) from seller_listings where workspace_id=$1)::integer as properties,(select count(*) from property_units where workspace_id=$1)::integer as units,(select count(*) from crm_command_receipts where workspace_id=$1 and operation='property.create')::integer as receipts", [fixture.workspaceId]).then(result => result.rows[0]);

    await t.test("unsigned requests and missing one-use CSRF cannot create records", async () => {
      assert.equal((await POST(request(base, randomUUID(), randomUUID(), false, false))).status, 401);
      assert.equal((await POST(request(base, randomUUID(), randomUUID(), false))).status, 403);
      const missing = request(base); missing.headers.delete("Idempotency-Key");
      assert.equal((await POST(missing)).status, 400);
      assert.deepEqual(await counts(), { properties: 0, units: 0, receipts: 0 });
    });
    await t.test("server rejects malformed supplied numbers, classifications, dates and links", async () => {
      for (const patch of [{ areaSqm: -1 }, { areaSqm: "12abc" }, { areaSqm: 1.234 }, { price: "broken" }, { price: -1 }, { rooms: "2.25" }, { yearBuilt: "2000.5" }, { yearBuilt: 10000 },
        { availableFrom: "2026-02-31" }, { availableFrom: "not a date" }, { objectType: "unsupported" }, { marketingType: "auction" }, { usageType: "whatever" }, { priceVisibility: "all" }, { projectId: "broken" }, { title: "" }, { address: "" }, { title: "x".repeat(301) }, { contactEmail: "broken" }]) {
        const response = await POST(request({ ...base, ...patch }));
        assert.equal(response.status, 400, JSON.stringify(patch) + ": " + await response.text());
      }
      assert.deepEqual(await counts(), { properties: 0, units: 0, receipts: 0 });
    });
    let createdId: string;
    const idempotencyKey = randomUUID(), correlation = randomUUID();
    await t.test("parallel retries create one property, one default unit and one receipt", async () => {
      const responses = await Promise.all([POST(request(base, idempotencyKey, correlation)), POST(request(base, idempotencyKey, correlation))]);
      for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
      const bodies = await Promise.all(responses.map(response => response.json()));
      assert.equal(bodies[0].persisted, true); assert.equal(bodies[0].data.id, bodies[1].data.id);
      assert.equal(bodies.filter(body => body.replayed).length, 1); createdId = bodies[0].data.id;
      assert.equal(bodies[0].data.areaSqm, 82.25); assert.equal(bodies[0].data.rooms, 3.5); assert.equal(bodies[0].data.targetPrice, 250000.12);
      assert.deepEqual(await counts(), { properties: 1, units: 1, receipts: 1 });
    });
    await t.test("same operation replays after response loss but changed content/key reuse conflicts", async () => {
      const replay = await POST(request(base, idempotencyKey, correlation));
      assert.equal(replay.status, 200); assert.equal((await replay.json()).data.id, createdId);
      assert.equal((await POST(request({ ...base, title: "SYNTHETIC changed" }, idempotencyKey, correlation))).status, 409);
      assert.equal((await POST(request(base, idempotencyKey, randomUUID()))).status, 409);
      assert.deepEqual(await counts(), { properties: 1, units: 1, receipts: 1 });
    });
    await t.test("complete editor explicitly clears optional stored numbers and keeps zero distinct", async () => {
      const load = async () => {
        const response = await GET(new Request(origin + path + `&operation=full&propertyId=${createdId}`, { headers: { cookie: "novalure_session=" + cookie } }));
        assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data;
      };
      const loaded = await load(), draft = createPropertyCoreDraft(loaded.listing);
      draft.propertyDetails = loaded.details; draft.coreEdit!.expectedFullSnapshot = loaded.snapshot;
      draft.rooms = ""; draft.yearBuilt = ""; draft.publicPrice = "";
      const cleared = await POST(request(propertyCoreUpdatePayload(draft, fixture.workspaceId, createdId)));
      assert.equal(cleared.status, 200, await cleared.clone().text());
      assert.deepEqual((await db.admin.query("select rooms,year_built,public_price_cents,target_price_cents from seller_listings where id=$1", [createdId])).rows[0],
        { rooms: null, year_built: null, public_price_cents: null, target_price_cents: "25000012" });
      const unknown = await load(), reopen = createPropertyCoreDraft(unknown.listing);
      assert.equal(reopen.rooms, ""); assert.equal(reopen.yearBuilt, ""); assert.equal(reopen.publicPrice, "");
      reopen.propertyDetails = unknown.details; reopen.coreEdit!.expectedFullSnapshot = unknown.snapshot;
      reopen.rooms = "0"; reopen.publicPrice = "0";
      const zero = await POST(request(propertyCoreUpdatePayload(reopen, fixture.workspaceId, createdId)));
      assert.equal(zero.status, 200, await zero.clone().text());
      const zeros = createPropertyCoreDraft((await load()).listing); assert.equal(zeros.rooms, "0"); assert.equal(zeros.publicPrice, "0");
      const stale = await POST(request(propertyCoreUpdatePayload(draft, fixture.workspaceId, createdId)));
      assert.equal(stale.status, 409);
    });
    await t.test("known area/price clear to unknown and explicit zero survives a complete reload", async () => {
      const load = async () => {
        const response = await GET(new Request(origin + path + `&operation=full&propertyId=${createdId}`, { headers: { cookie: "novalure_session=" + cookie } }));
        assert.equal(response.status, 200); return (await response.json()).data;
      };
      let loaded = await load();
      const edit = () => { const draft = createPropertyCoreDraft(loaded.listing); draft.propertyDetails = loaded.details; draft.coreEdit!.expectedFullSnapshot = loaded.snapshot; return draft; };
      const clear = edit(); clear.areaSqm = ""; clear.price = "";
      clear.propertyDetails!.values["areas.nutzfl_che"] = 30;
      const response = await POST(request(propertyCoreUpdatePayload(clear, fixture.workspaceId, createdId)));
      assert.equal(response.status, 200, await response.clone().text());
      loaded = await load(); const unknown = createPropertyCoreDraft(loaded.listing);
      assert.equal(unknown.areaSqm, ""); assert.equal(unknown.price, "");
      assert.equal((await db.admin.query("select market_value_cents from seller_listings where id=$1", [createdId])).rows[0].market_value_cents, "25000012", "Clearing asking price preserves the separate internal valuation");
      assert.equal(propertyCoreNumberIsKnown(loaded.listing.canonicalPayload, "areaSqm", loaded.listing.areaSqm), false);
      assert.equal(propertyCoreNumberIsKnown(loaded.listing.canonicalPayload, "price", loaded.listing.targetPrice), false);
      const zero = edit(); zero.areaSqm = "0"; zero.price = "0";
      const saved = await POST(request(propertyCoreUpdatePayload(zero, fixture.workspaceId, createdId)));
      assert.equal(saved.status, 200, await saved.clone().text());
      loaded = await load(); const reopened = createPropertyCoreDraft(loaded.listing);
      assert.equal(reopened.areaSqm, "0"); assert.equal(reopened.price, "0");
      assert.equal(propertyCoreNumberIsKnown(loaded.listing.canonicalPayload, "areaSqm", 0), true);
      assert.equal(propertyCoreNumberIsKnown(loaded.listing.canonicalPayload, "price", 0), true);
      assert.deepEqual(await counts(), { properties: 1, units: 1, receipts: 1 });
    });
    await t.test("unrelated edits preserve legacy unknown public/rent zeros and explicit optional zero survives reload", async () => {
      const load = async () => {
        const response = await GET(new Request(origin + path + `&operation=full&propertyId=${createdId}`, { headers: { cookie: "novalure_session=" + cookie } }));
        assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data;
      };
      await db.admin.query("update seller_listings set public_price_cents=0,rent_price_cents=0,canonical_payload=canonical_payload-'coreNumericState' where id=$1", [createdId]);
      let loaded = await load(), draft = createPropertyCoreDraft(loaded.listing);
      assert.equal(draft.publicPrice, ""); assert.equal(draft.rentPrice, "");
      const partial = await POST(request({ operation: "update_property_core", propertyId: createdId, property: { areaSqm: 21 } }));
      assert.equal(partial.status, 200, await partial.clone().text());
      const legacy = (await db.admin.query("select public_price_cents,rent_price_cents,canonical_payload->'coreNumericState' as state from seller_listings where id=$1", [createdId])).rows[0];
      assert.equal(legacy.public_price_cents, "0"); assert.equal(legacy.rent_price_cents, "0");
      assert.equal(legacy.state.version, 1); assert.equal(legacy.state.publicPrice, "unknown"); assert.equal(legacy.state.rentPrice, "unknown");
      loaded = await load(); draft = createPropertyCoreDraft(loaded.listing);
      assert.equal(draft.publicPrice, ""); assert.equal(draft.rentPrice, "");
      assert.equal(propertyOptionalPriceIsKnown(loaded.listing.canonicalPayload, "publicPrice", 0), false);
      assert.equal(propertyOptionalPriceIsKnown(loaded.listing.canonicalPayload, "rentPrice", 0), false);
      draft.propertyDetails = loaded.details; draft.coreEdit!.expectedFullSnapshot = loaded.snapshot;
      draft.publicPrice = "0"; draft.rentPrice = "0";
      const explicit = await POST(request(propertyCoreUpdatePayload(draft, fixture.workspaceId, createdId)));
      assert.equal(explicit.status, 200, await explicit.clone().text());
      loaded = await load(); draft = createPropertyCoreDraft(loaded.listing);
      assert.equal(draft.publicPrice, "0"); assert.equal(draft.rentPrice, "0");
      assert.equal(propertyOptionalPriceIsKnown(loaded.listing.canonicalPayload, "publicPrice", 0), true);
      assert.equal(propertyOptionalPriceIsKnown(loaded.listing.canonicalPayload, "rentPrice", 0), true);
      draft.propertyDetails = loaded.details; draft.coreEdit!.expectedFullSnapshot = loaded.snapshot;
      draft.publicPrice = ""; draft.rentPrice = "";
      const clear = await POST(request(propertyCoreUpdatePayload(draft, fixture.workspaceId, createdId)));
      assert.equal(clear.status, 200, await clear.clone().text());
      loaded = await load(); draft = createPropertyCoreDraft(loaded.listing);
      assert.equal(draft.publicPrice, ""); assert.equal(draft.rentPrice, "");
      assert.deepEqual((await db.admin.query("select public_price_cents,rent_price_cents from seller_listings where id=$1", [createdId])).rows[0], { public_price_cents: null, rent_price_cents: null });
      for (const supplied of ["2500", "0", ""]) {
        const legacyUpdate = await POST(request({ operation: "update_property_core", propertyId: createdId, property: { fieldValues: { "costs.mietpreis_brutto": supplied } } }));
        assert.equal(legacyUpdate.status, 400, await legacyUpdate.clone().text());
        const rent = (await db.admin.query("select rent_price_cents,canonical_payload from seller_listings where id=$1", [createdId])).rows[0];
        assert.equal(rent.rent_price_cents, null);
        assert.equal(propertyOptionalPriceIsKnown(rent.canonical_payload, "rentPrice", rent.rent_price_cents), false);
      }
      loaded = await load(); draft = createPropertyCoreDraft(loaded.listing);
      assert.equal(draft.rentPrice, "");
      loaded.details.values["costs.mietpreis_brutto"] = "2500";
      draft.propertyDetails = loaded.details; draft.coreEdit!.expectedFullSnapshot = loaded.snapshot; draft.rentPrice = "";
      const clearLegacyRent = await POST(request(propertyCoreUpdatePayload(draft, fixture.workspaceId, createdId)));
      assert.equal(clearLegacyRent.status, 200, await clearLegacyRent.clone().text());
      const rentCleared = (await db.admin.query("select rent_price_cents,canonical_payload from seller_listings where id=$1", [createdId])).rows[0];
      assert.equal(rentCleared.rent_price_cents, null); assert.equal(propertyOptionalPriceIsKnown(rentCleared.canonical_payload, "rentPrice", 0), false);
      assert.deepEqual(await counts(), { properties: 1, units: 1, receipts: 1 });
    });
    await t.test("existing cookie and receipt cannot bypass a newly restricted membership/project", async () => {
      await db.admin.query("update workspace_users set role='assistant',product_role='viewer' where id=$1", [fixture.userId]);
      assert.equal((await POST(request(base, idempotencyKey, correlation))).status, 403);
      await db.admin.query("update workspace_users set role='agent',product_role='broker_agent' where id=$1", [fixture.userId]);
      assert.equal((await POST(request(base))).status, 403);
      assert.deepEqual(await counts(), { properties: 1, units: 1, receipts: 1 });
      await db.admin.query("update workspace_users set role='owner',product_role='novalureAdmin' where id=$1", [fixture.userId]);
    });
    await t.test("audit failure rolls back property, default unit, receipt and domain events", async () => {
      const before = await counts();
      await db.admin.query("create function synthetic_reject_property_audit() returns trigger language plpgsql as $$begin if new.action='property.created' then raise exception 'SYNTHETIC audit unavailable'; end if; return new; end$$; create trigger synthetic_property_audit_failure before insert on audit_logs for each row execute function synthetic_reject_property_audit()");
      try {
        const response = await POST(request({ ...base, title: "SYNTHETIC rollback" }));
        assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /SYNTHETIC audit unavailable|audit_logs/);
        assert.deepEqual(await counts(), before);
      } finally { await db.admin.query("drop trigger synthetic_property_audit_failure on audit_logs; drop function synthetic_reject_property_audit()"); }
    });
  } finally {
    await closeLocalTestPool(); await db.stop();
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  }
});
