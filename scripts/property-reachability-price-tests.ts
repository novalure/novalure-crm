import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { startReachabilityDb } from "./lib/property-reachability-local-db.mjs";
import { applySalesSchema } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { POST } from "../src/app/api/crm/properties/route";
import { resolveWorkspaceScopedSession } from "../src/lib/auth/session";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { withCrmRead } from "../src/lib/crm-command";
import { loadPropertyExposeSnapshot } from "../src/lib/db/property-expose-repositories";
import { buildWebExposeSnapshot } from "../src/lib/db/web-expose-repository";
import { buildPropertyExposeDocument } from "../src/lib/property-expose-service";
import { renderPropertyExposePdf } from "../src/lib/property-expose-pdf";
import { renderWebExposePdf } from "../src/lib/web-expose-pdf";
import { createPropertyGeography } from "../src/lib/property-country";

const phase = process.env.PROPERTY_REACHABILITY_PHASE ?? "fixed";
if (!["baseline", "fixed"].includes(phase)) throw new Error("Invalid local evidence phase");
const output = path.resolve(".npm-cache/qa/property-reachability-price", phase);
const compact = (value: string) => value.replace(/\s+/gu, " ").trim();
function assertSameDisplayAmount(separate: string | undefined, web: string | null | undefined) {
  const amount = (value: string | null | undefined) => value?.match(/(?:^|:\s*)(\d[\d.,]*)\s*€/u)?.[1] ?? null;
  const expected = amount(web);
  assert.notEqual(expected, null, "website has an explicit display amount");
  assert.equal(amount(separate), expected, "separate PDF selects the same complete amount as website/web PDF");
}
async function pdfText(bytes: Uint8Array) {
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false, disableFontFace: true,
    standardFontDataUrl: path.resolve("node_modules/pdfjs-dist/standard_fonts").replaceAll("\\", "/") + "/" });
  try {
    const pdf = await task.promise; let text = "";
    for (let n = 1; n <= pdf.numPages; n++) text += (await (await pdf.getPage(n)).getTextContent()).items
      .map(item => "str" in item ? item.str : "").join(" ") + "\n";
    return compact(text);
  } finally { await task.destroy(); }
}

// Monetary/location values are copied from the immutable fictional ES-RENT-01
// fixture (7b4d9ca7). Runtime IDs are generated only by this disposable DB fixture.
const esRentInput = {
  operation: "create_property", title: "FIKTIV ES-RENT-01 - Miete Testobjekt",
  address: "Teststreet-ES-RENT-01 999, 28999 Testcity-ES-FICTIONAL [FIKTIV]",
  city: "Testcity-ES-FICTIONAL", postalCode: "28999", street: "Teststreet-ES-RENT-01",
  region: "Andalucía", geography: createPropertyGeography("ES", "Andalucía"),
  energyCertificate: { version: 1, countryCode: "ES" }, objectType: "Wohnung", usageType: "residential",
  areaSqm: 85.75, rooms: 3, yearBuilt: 1998, marketingType: "rent", price: 315000,
  rentPrice: 1743.21, rentNet: 1394.57, priceVisibility: "publish_price",
};

test("actual property POST, PostgreSQL storage and both public projections agree on gross rental price", { timeout: 240_000 }, async t => {
  const db = await startReachabilityDb();
  const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    await applySalesSchema(db);
    const fixture = await seedSalesBrowser(db);
    // This is a broker fixture; developer price-confirmation authority is not
    // fabricated to make a different, unrelated price selection test pass.
    await db.admin.query("update projects set type='Service',customer_type='real_estate_broker' where id=$1", [fixture.projectId]);
    await db.admin.query("update workspaces set customer_type='real_estate_broker' where id=$1", [fixture.workspaceId]);
    const secret = randomBytes(48).toString("base64url"), origin = "http://127.0.0.1:3000";
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret,
      NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    const cookie = "v2." + randomBytes(32).toString("base64url");
    await db.admin.query("update auth_identities set mfa_enabled_at=now(),mfa_secret_ciphertext='SYNTHETIC-NOT-A-REAL-SECRET' where id=$1", [fixture.authIdentityId]);
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [randomUUID(), createHash("sha256").update(cookie).digest("hex"), fixture.authIdentityId, fixture.userId, fixture.workspaceId]);
    const route = `/api/crm/properties?workspaceId=${fixture.workspaceId}`;
    const request = (body: unknown, key = randomUUID(), correlation = randomUUID(), authenticated = true, csrf = true) => new Request(origin + route, { method: "POST", headers: {
      "content-type": "application/json", origin, "sec-fetch-site": "same-origin", "Idempotency-Key": key, "X-Correlation-Id": correlation,
      ...(authenticated ? { cookie: "novalure_session=" + cookie } : {}),
      ...(csrf ? { "x-novalure-csrf-token": createCsrfToken({ method: "POST", pathname: "/api/crm/properties", secret, sessionCookie: cookie })!.token } : {}),
    }, body: JSON.stringify(body) });
    const auth = await resolveWorkspaceScopedSession(new Request(origin + route, { headers: { cookie: "novalure_session=" + cookie } }), { permission: "crm:read", capability: "workspace:read" });
    assert.equal(auth.ok, true);
    if (!auth.ok) throw new Error("Synthetic current session unavailable");
    const session = auth.session;
    let caseInput: Record<string, unknown> = esRentInput;
    let fixtureSource: Record<string, unknown> = { kind: "INLINE_MONETARY_REPRODUCTION_OF_FICTIONAL_ES_RENT" };
    if (process.env.PROPERTY_REACHABILITY_FIXTURE_FILE) {
      const bytes = await readFile(process.env.PROPERTY_REACHABILITY_FIXTURE_FILE);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(sha256, "bfca527ea2e23c70be6cd59a009e80c6e2cfdab1ad3199d8bbdae494dd8fd08a", "the frozen ES-RENT-01 fixture must remain unchanged");
      const source = JSON.parse(bytes.toString("utf8"));
      assert.equal(source.fixtureId, "ES-RENT-01"); assert.equal(source.fictional, true);
      caseInput = source.api.propertyCreate.payload;
      fixtureSource = { kind: "EXACT_FROZEN_FICTIONAL_ES_RENT_PAYLOAD", fixtureId: source.fixtureId, sourceRevision: source.sourceRevision, sha256 };
    }
    const body = { ...caseInput, projectId: fixture.projectId };
    await mkdir(output, { recursive: true });

    await t.test("real authentication and CSRF guards reject before storage", async () => {
      assert.equal((await POST(request(body, randomUUID(), randomUUID(), false, false))).status, 401);
      assert.equal((await POST(request(body, randomUUID(), randomUUID(), true, false))).status, 403);
      assert.equal((await db.admin.query("select count(*)::integer as count from seller_listings where workspace_id=$1", [fixture.workspaceId])).rows[0].count, 0);
    });

    async function createAndProject(caseId: string, patch: Record<string, unknown> = {}) {
      const payload = { ...body, ...patch, objectNumber: "TEST-" + caseId }, key = randomUUID(), correlation = randomUUID();
      const response = await POST(request(payload, key, correlation));
      assert.equal(response.status, 200, await response.clone().text());
      const created = await response.json();
      assert.equal(created.persisted, true);
      const replay = await POST(request(payload, key, correlation));
      assert.equal(replay.status, 200, await replay.clone().text());
      const replayed = await replay.json(); assert.equal(replayed.replayed, true); assert.equal(replayed.data.id, created.data.id);
      const saved = (await db.admin.query(`select id,unit_id as "unitId",target_price_cents::text as "targetPriceCents",public_price_cents::text as "publicPriceCents",rent_price_cents::text as "rentPriceCents",rent_net_cents::text as "rentNetCents",canonical_payload->'coreNumericState' as "coreNumericState" from seller_listings where id=$1 and workspace_id=$2`, [created.data.id, fixture.workspaceId])).rows[0];
      const receiptCount = (await db.admin.query("select count(*)::integer as count from crm_command_receipts where workspace_id=$1 and operation='property.create' and idempotency_key=$2", [fixture.workspaceId, key])).rows[0].count;
      assert.equal(receiptCount, 1, "the real POST retry has one command receipt");
      const projected = await withCrmRead(session, async (tx, fresh) => ({
        source: await loadPropertyExposeSnapshot(fresh.workspaceId, created.data.id),
        web: await buildWebExposeSnapshot(tx, fresh, { propertyId: created.data.id, language: "es", showAddress: false, showContact: false, reviewed: false,
          controller: "FIKTIV LOCAL ONLY", privacyUrl: "https://property-fixtures.invalid/privacy", legalUrl: "https://property-fixtures.invalid/legal" }),
      }));
      let separate: ReturnType<typeof buildPropertyExposeDocument> | undefined, separateError: string | undefined;
      try { separate = buildPropertyExposeDocument(projected.source, { template: "full", language: "es", address: "hidden", showPrice: true, showContact: false, imageIds: [], floorPlanIds: [] }, []); }
      catch (error) { separateError = error && typeof error === "object" && "code" in error ? String(error.code) : "UNEXPECTED"; }
      const record = { evidence: "ACTUAL_LOCAL_LOOPBACK_POSTGRES_ONLY_NOT_PRODUCTION", caseId, fixtureSource, requestTransport: "Native Request passed to the actual POST route handler with loopback SQL transport; no HTTP socket server", postStatus: response.status, nativeSessionRead: true, csrfValidated: true,
        replayedSameProperty: replayed.data.id === created.data.id, receiptCount, saved, responseAmounts: { targetPrice: created.data.targetPrice, publicPrice: created.data.publicPrice, rentPrice: created.data.rentPrice },
        webPrice: projected.web.snapshot.price, separatePrice: separate?.price, separateError };
      await writeFile(path.join(output, caseId + ".json"), JSON.stringify(record, null, 2) + "\n");
      t.diagnostic(JSON.stringify(record));
      return { ...projected, separate, separateError, saved, created, record };
    }

    await t.test("ES-RENT create fallback is stored but neither public PDF displays the asking price as rent", async () => {
      const p = await createAndProject("ES-RENT-01");
      assert.equal(p.saved.targetPriceCents, "31500000"); assert.equal(p.saved.publicPriceCents, "31500000"); assert.equal(p.saved.rentPriceCents, "174321");
      assert.equal(p.saved.coreNumericState.publicPrice, "known"); assert.equal(p.saved.coreNumericState.rentPrice, "known");
      const webBytes = await renderWebExposePdf({ snapshot: p.web.snapshot, images: [], plans: [], links: [], pageUrl: "https://property-fixtures.invalid/expose/synthetic" });
      assert.ok(p.separate); const separateBytes = await renderPropertyExposePdf(p.separate);
      await writeFile(path.join(output, "ES-RENT-01.web.pdf"), webBytes); await writeFile(path.join(output, "ES-RENT-01.separate.pdf"), separateBytes);
      const webText = await pdfText(webBytes), separateText = await pdfText(separateBytes);
      await writeFile(path.join(output, "ES-RENT-01.pdf-text.json"), JSON.stringify({ webText, separateText }, null, 2) + "\n");
      assert.ok(compact(webText).includes("1743,21") || compact(webText).includes("1.743,21"), "web PDF contains gross monthly rent");
      assertSameDisplayAmount(p.separate.price, p.web.snapshot.price);
      assert.ok(separateText.includes("1743,21") || separateText.includes("1.743,21"), "actual separate PDF bytes contain gross monthly rent");
      assert.ok(!separateText.includes("315.000,00"), "asking price is not published as monthly rent");
    });
    await t.test("rental gross price stays authoritative even when a separate public asking price is supplied", async () => {
      const p = await createAndProject("ES-RENT-EXPLICIT-PUBLIC", { publicPrice: 7777.77 });
      assert.equal(p.saved.publicPriceCents, "777777"); assertSameDisplayAmount(p.separate?.price, p.web.snapshot.price);
    });
    await t.test("explicit known zero gross rent is preserved instead of falling back to asking price", async () => {
      const p = await createAndProject("ES-RENT-ZERO", { rentPrice: 0 });
      assert.equal(p.saved.rentPriceCents, "0"); assert.equal(p.saved.coreNumericState.rentPrice, "known");
      assert.ok(p.web.snapshot.price?.includes("0,00")); assertSameDisplayAmount(p.separate?.price, p.web.snapshot.price);
    });
    await t.test("missing gross rent cannot publish asking price or private net rent", async () => {
      const p = await createAndProject("ES-RENT-UNKNOWN", { rentPrice: null });
      assert.equal(p.saved.rentPriceCents, null); assert.equal(p.saved.rentNetCents, "139457");
      assert.equal(p.web.snapshot.price, null); assert.equal(p.separateError, "EXPOSE_PRICE_MISSING"); assert.equal(p.separate, undefined);
      // Separate, explicitly synthetic DTO guard for legacy optional markers.
      // This clone is not represented as another SQL read or POST-produced row.
      const legacyNetOnly = structuredClone(p.source);
      legacyNetOnly.source.listing.coreNumericState = {};
      legacyNetOnly.source.listing.publicPriceCents = null;
      assert.throws(() => buildPropertyExposeDocument(legacyNetOnly, { template: "full", language: "es", address: "hidden", showPrice: true, showContact: false, imageIds: [], floorPlanIds: [] }, []), { code: "EXPOSE_PRICE_MISSING" }, "private net rent cannot establish an unknown public gross rent in a legacy DTO");
    });
    await t.test("purchase retains the separate public asking price", async () => {
      const p = await createAndProject("ES-SALE-CONTROL", { marketingType: "sale", publicPrice: 399123.45 });
      assert.equal(p.saved.publicPriceCents, "39912345"); assertSameDisplayAmount(p.separate?.price, p.web.snapshot.price);
    });
    await t.test("source SQL compares a developer confirmation with the selected gross rent", async () => {
      const p = await createAndProject("ES-RENT-ZERO-CONFIRMATION", { rentPrice: 0 });
      // Synthetic DB setup isolates the selector predicate, not the authority
      // command. Existing sales authority tests cover who may create evidence.
      await db.admin.query("update projects set type='Bautraeger',customer_type='property_developer' where id=$1", [fixture.projectId]);
      try {
        await db.admin.query("update property_units set price_cents=0,metadata=jsonb_set(metadata,'{priceConfirmation}',jsonb_build_object('sourceReference','SYNTHETIC selector fixture only','priceCents','0')) where id=$1", [p.saved.unitId]);
        const saved = await withCrmRead(session, () => loadPropertyExposeSnapshot(fixture.workspaceId, p.saved.id));
        assert.equal(saved.source.listing.developer, true);
        assert.equal(saved.source.listing.confirmedCurrentPrice, true, "asking/public fallback must not displace the actual confirmed rental amount");
        const doc = buildPropertyExposeDocument(saved, { template: "full", language: "es", address: "hidden", showPrice: true, showContact: false, imageIds: [], floorPlanIds: [] }, []);
        assertSameDisplayAmount(doc.price, "0,00 €");
        await db.admin.query("update property_units set metadata=jsonb_set(metadata,'{priceConfirmation,priceCents}','\"1\"') where id=$1", [p.saved.unitId]);
        const changed = await withCrmRead(session, () => loadPropertyExposeSnapshot(fixture.workspaceId, p.saved.id));
        assert.equal(changed.source.listing.confirmedCurrentPrice, false);
        assert.throws(() => buildPropertyExposeDocument(changed, { template: "full", language: "es", address: "hidden", showPrice: true, showContact: false, imageIds: [], floorPlanIds: [] }, []), { code: "EXPOSE_PRICE_UNCONFIRMED" });
      } finally {
        await db.admin.query("update projects set type='Service',customer_type='real_estate_broker' where id=$1", [fixture.projectId]);
      }
    });
  } finally {
    await closeLocalTestPool();
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    await db.stop();
  }
});
