import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { applySalesSchema } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { startReachabilityDb } from "./lib/property-reachability-local-db.mjs";
import { POST as propertyPost, GET as propertyGet } from "../src/app/api/crm/properties/route";
import { POST as webPost } from "../src/app/api/crm/web-exposes/route";
import { GET as publicPdfGet } from "../src/app/api/public/exposes/[token]/pdf/route";
import { lookupWebExpose } from "../src/lib/db/web-expose-repository";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { createPropertyGeography } from "../src/lib/property-country";
import { resolveWebsitePriceVisibility, websitePriceVisibilityReadValues } from "../src/lib/property-website-price-visibility";
import { applyPropertyChannelPriceEdits, propertyChannelPriceValue } from "../src/lib/property-channel-price-draft";
import { getRequestSession } from "../src/lib/auth/session";
import { withCrmRead } from "../src/lib/crm-command";
import { loadPropertyExposeSnapshot } from "../src/lib/db/property-expose-repositories";
import { buildPropertyExposeDocument } from "../src/lib/property-expose-service";
import { createPropertyCoreDraft, propertyCoreUpdatePayload } from "../src/lib/property-core-editing";
import { mapProductRoleToTechnicalRole, type ProductRole } from "../src/lib/product-model";

const policies = ["publish_price", "price_on_request", "hide_price"] as const;
type Policy = typeof policies[number];
const gross = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(1743.21);
const normalized = (value: string) => value.replace(/\s+/gu, " ").trim();

async function pdfText(bytes: Uint8Array) {
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false, disableFontFace: true,
    standardFontDataUrl: path.resolve("node_modules/pdfjs-dist/standard_fonts").replaceAll("\\", "/") + "/" });
  try {
    const pdf = await task.promise; let text = "";
    for (let i = 1; i <= pdf.numPages; i++) text += (await (await pdf.getPage(i)).getTextContent()).items.map(v => "str" in v ? v.str : "").join(" ") + "\n";
    return normalized(text);
  } finally { await task.destroy(); }
}

test("website aliases resolve only website policies without mutating unrelated channels", () => {
  const ranks: Record<Policy, number> = { publish_price: 0, price_on_request: 1, hide_price: 2 };
  for (const native of policies) for (const legacy of policies) {
    const input = { "Eigene Website": native, Website: legacy, Newsletter: "hide_price", "Exposé": "publish_price" };
    const before = structuredClone(input), expected = ranks[native] >= ranks[legacy] ? native : legacy;
    assert.equal(resolveWebsitePriceVisibility(input, "hide_price"), expected);
    assert.deepEqual(input, before);
  }
  assert.equal(resolveWebsitePriceVisibility({ "Eigene Website": "publish_price" }, "hide_price"), "publish_price", "explicit channel override retains precedence over global policy");
  for (const value of [null, "", "unknown", 1, false, {}, []]) {
    assert.equal(resolveWebsitePriceVisibility({ "Eigene Website": value, Website: "publish_price" }, "publish_price"), "hide_price");
    assert.equal(resolveWebsitePriceVisibility({ Website: value, "Eigene Website": "publish_price" }, "publish_price"), "hide_price");
  }
  for (const value of [null, undefined, [], ["Website"], "Website", 7]) assert.equal(resolveWebsitePriceVisibility(value, "price_on_request"), "price_on_request");
  assert.equal(resolveWebsitePriceVisibility({ Newsletter: "hide_price", "Exposé": "hide_price" }, "publish_price"), "publish_price");
  assert.equal(resolveWebsitePriceVisibility({}, "unknown"), "hide_price");
  assert.deepEqual(websitePriceVisibilityReadValues({ Website: null, "Eigene Website": "publish_price", Newsletter: "unknown" }), { Website: "hide_price", "Eigene Website": "publish_price" });
});

test("selected-property channel drafts display saved policies and preserve untouched channels on website-only saves", () => {
  const saved = { "Eigene Website": "hide_price", Website: "hide_price", Newsletter: "price_on_request", "Exposé": "hide_price", "Off-market": "price_on_request" } as const;
  const before = structuredClone(saved), reloaded = applyPropertyChannelPriceEdits(saved);
  assert.deepEqual(reloaded, saved);
  assert.equal(propertyChannelPriceValue(reloaded, "Eigene Website", "publish_price"), "hide_price");
  assert.equal(propertyChannelPriceValue(reloaded, "Newsletter", "publish_price"), "price_on_request");
  const edited = applyPropertyChannelPriceEdits(saved, { "Eigene Website": "publish_price" });
  assert.equal(edited["Eigene Website"], "publish_price"); assert.ok(!Object.hasOwn(edited, "Website"));
  assert.equal(edited.Newsletter, "price_on_request"); assert.equal(edited["Exposé"], "hide_price"); assert.equal(edited["Off-market"], "price_on_request");
  const otherChannel = applyPropertyChannelPriceEdits(saved, { Newsletter: "hide_price" });
  assert.equal(otherChannel.Website, "hide_price"); assert.equal(otherChannel["Eigene Website"], "hide_price");
  const freshSource = { ...saved, Newsletter: "hide_price" as const, "Custom private channel": "price_on_request" as const };
  const merged = applyPropertyChannelPriceEdits(freshSource, { "Eigene Website": "price_on_request" });
  assert.equal(merged.Newsletter, "hide_price"); assert.equal(merged["Custom private channel"], "price_on_request");
  assert.deepEqual(saved, before);
});

test("native website UI-shaped writes govern existing and new public capabilities in real local PostgreSQL", { timeout: 240_000 }, async t => {
  const db = await startReachabilityDb();
  const oldFetch = globalThis.fetch;
  const envKeys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET"];
  const priorEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const observations: unknown[] = [];
  globalThis.fetch = async () => { throw new Error("WEBSITE_POLICY_TEST_EXTERNAL_FETCH_FORBIDDEN"); };
  try {
    await applySalesSchema(db);
    const fixture = await seedSalesBrowser(db);
    await db.admin.query("update projects set type='Service',customer_type='real_estate_broker' where id=$1", [fixture.projectId]);
    const secret = randomBytes(48).toString("base64url"), cookie = "v2." + randomBytes(32).toString("base64url"), origin = "http://127.0.0.1:3000";
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret,
      NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    // A synthetic persisted MFA/session fixture, not another interactive login.
    // The root browser acceptance separately exercises the original login UI.
    await db.admin.query("update auth_identities set mfa_enabled_at=now(),mfa_secret_ciphertext='SYNTHETIC-NOT-A-REAL-SECRET' where id=$1", [fixture.authIdentityId]);
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [randomUUID(), createHash("sha256").update(cookie).digest("hex"), fixture.authIdentityId, fixture.userId, fixture.workspaceId]);
    const request = (pathname: string, body: unknown) => new Request(origin + pathname + `?workspaceId=${fixture.workspaceId}`, { method: "POST", headers: {
      "content-type": "application/json", origin, "sec-fetch-site": "same-origin", cookie: "novalure_session=" + cookie,
      "Idempotency-Key": randomUUID(), "X-Correlation-Id": randomUUID(), "x-novalure-csrf-token": createCsrfToken({ method: "POST", pathname, secret, sessionCookie: cookie })!.token,
    }, body: JSON.stringify(body) });
    const create = async (rentPrice = 1743.21) => {
      const response = await propertyPost(request("/api/crm/properties", { operation: "create_property", projectId: fixture.projectId,
        title: "SYNTHETIC ES website price policy", address: "SYNTHETIC PRIVATE ADDRESS 999", areaSqm: 85.75, rooms: 3, yearBuilt: 1998,
        objectType: "Wohnung", usageType: "residential", marketingType: "rent", price: 315000, rentPrice, rentNet: 1394.57, priceVisibility: "publish_price",
        geography: { ...createPropertyGeography("ES", "Andalucía"), displayLocale: "en-IE" },
        energyCertificate: { version: 1, countryCode: "ES", certificateType: "existing", energyClass: "B", finalEnergyDemandKwhM2: 51.25, registration: "SYNTHETIC-UNVERIFIED" } }));
      assert.equal(response.status, 200, await response.clone().text()); const result = await response.json(); assert.equal(result.persisted, true); return result.data.id as string;
    };
    const propertyId = await create();
    // Explicit synthetic approved-cost fixture, not a claim about cost-entry UI.
    await db.admin.query("insert into property_cost_items(workspace_id,project_id,property_id,cost_key,label,monthly_gross_cents,expose_visible) values($1,$2,$3,'operating_costs','SYNTHETIC approved cost',9900,true)", [fixture.workspaceId, fixture.projectId, propertyId]);
    const input = (id: string) => ({ propertyId: id, language: "es", title: "SYNTHETIC ES website price policy", description: "SYNTHETIC saved description without monetary prose", showAddress: false,
      showContact: false, reviewed: true, controller: "SYNTHETIC LOCAL ONLY", privacyUrl: "https://example.invalid/privacy", legalUrl: "https://example.invalid/legal" });
    const preview = async (id = propertyId) => {
      const response = await webPost(request("/api/crm/web-exposes", { ...input(id), action: "preview" }));
      assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data;
    };
    const publish = async (id = propertyId) => {
      const built = await preview(id);
      const response = await webPost(request("/api/crm/web-exposes", { ...input(id), action: "publish", expectedSourceFingerprint: built.sourceFingerprint }));
      assert.equal(response.status, 200, await response.clone().text()); const result = (await response.json()).data;
      return { ...result, token: String(result.path).split("/").at(-1)! };
    };
    const nativeMap = (policy: Policy) => ({ "Eigene Website": policy, Immobilienportal: "hide_price", "OpenImmo Export": "price_on_request", Newsletter: "price_on_request", "Off-market": "hide_price" });
    const writePolicy = async (map: Record<string, unknown>, id = propertyId) => {
      const stateResponse = await propertyGet(new Request(`${origin}/api/crm/properties?workspaceId=${fixture.workspaceId}&operation=channel_price_visibility&propertyId=${id}`, { headers: { cookie: "novalure_session=" + cookie } }));
      assert.equal(stateResponse.status, 200, await stateResponse.clone().text());
      const state = (await stateResponse.json()).data;
      const response = await propertyPost(request("/api/crm/properties", { operation: "update_price_visibility", propertyId: id, projectId: fixture.projectId, priceVisibility: "publish_price", publicPrice: 315000, channelPriceVisibility: map, expectedPolicyRevision: state.revision }));
      assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).persisted, true);
      const stored = (await db.admin.query("select channel_price_visibility as channels from seller_listings where id=$1", [id])).rows[0].channels;
      assert.deepEqual(stored, map, "the existing full-map replacement preserves every supplied non-Web policy; omitted keys are not claimed retained");
    };
    await writePolicy(nativeMap("publish_price"));
    const original = await publish();
    assert.equal((await lookupWebExpose(original.token))?.snapshot.price, gross);

    await t.test("read DTO keeps malformed website policy restrictive across an unrelated Newsletter edit", async () => {
      await db.admin.query("update seller_listings set channel_price_visibility=$2::jsonb where id=$1", [propertyId, JSON.stringify({ "Eigene Website": "publish_price", Website: null, Newsletter: "price_on_request", "Exposé": "hide_price" })]);
      const response = await propertyGet(new Request(`${origin}/api/crm/properties?workspaceId=${fixture.workspaceId}&operation=full&propertyId=${propertyId}`, { headers: { cookie: "novalure_session=" + cookie } }));
      assert.equal(response.status, 200, await response.clone().text());
      const saved = (await response.json()).data.listing.channelPriceVisibility;
      assert.equal(saved.Website, "hide_price"); assert.equal(saved["Eigene Website"], "publish_price");
      const payload = applyPropertyChannelPriceEdits(saved, { Newsletter: "hide_price" });
      await writePolicy(payload);
      assert.equal((await lookupWebExpose(original.token))?.snapshot.price, null);
      assert.equal(payload["Exposé"], "hide_price");
    });

    await t.test("JS preview and current SQL inventory agree for native/legacy aliases, conflicts and malformed stored data", async () => {
      const cases: { map: unknown; fallback: Policy; expected: Policy }[] = [];
      for (const policy of policies) { cases.push({ map: { "Eigene Website": policy }, fallback: "hide_price", expected: policy }); cases.push({ map: { Website: policy }, fallback: "hide_price", expected: policy }); }
      for (const native of policies) for (const legacy of policies) cases.push({ map: { "Eigene Website": native, Website: legacy }, fallback: "publish_price", expected: native === "hide_price" || legacy === "hide_price" ? "hide_price" : native === "price_on_request" || legacy === "price_on_request" ? "price_on_request" : "publish_price" });
      for (const value of [null, "", "unknown", 1, {}, []]) cases.push({ map: { "Eigene Website": value, Website: "publish_price" }, fallback: "publish_price", expected: "hide_price" });
      for (const map of [null, [], ["Website"], "Website", { Newsletter: "hide_price", "Exposé": "hide_price" }]) cases.push({ map, fallback: "publish_price", expected: "publish_price" });
      cases.push({ map: {}, fallback: "price_on_request", expected: "price_on_request" });
      for (const item of cases) {
        // Invalid shapes are isolated stored-data fixtures, not accepted UI/API input.
        await db.admin.query("update seller_listings set channel_price_visibility=$2::jsonb,price_visibility=$3 where id=$1", [propertyId, JSON.stringify(item.map), item.fallback]);
        const built = await preview(), current = await lookupWebExpose(original.token);
        assert.equal(resolveWebsitePriceVisibility(item.map, item.fallback), item.expected);
        assert.equal(built.snapshot.priceVisibility, item.expected); assert.equal(current?.snapshot.priceVisibility, item.expected);
        assert.equal(built.snapshot.price, item.expected === "publish_price" ? gross : null); assert.equal(current?.snapshot.price, item.expected === "publish_price" ? gross : null);
        assert.equal(built.snapshot.costs.length > 0, item.expected === "publish_price"); assert.equal((current?.snapshot.costs?.length ?? 0) > 0, item.expected === "publish_price");
        const after = (await db.admin.query("select channel_price_visibility as channels from seller_listings where id=$1", [propertyId])).rows[0].channels;
        assert.deepEqual(after, item.map, "readers never normalize or mutate other channel state");
      }
      observations.push({ kind: "REAL_PG_ALIAS_MATRIX", cases: cases.length, malformedRowsAreSyntheticFixtures: true, noQueryResultsMocked: true });
    });

    await t.test("native-key full-map API saves hide/request/publish existing links and retain supplied non-Web values", async () => {
      for (const policy of ["hide_price", "price_on_request", "publish_price"] as const) {
        const map = nativeMap(policy); await writePolicy(map);
        const built = await preview(), current = await lookupWebExpose(original.token);
        assert.equal(built.snapshot.priceVisibility, policy); assert.equal(current?.snapshot.priceVisibility, policy);
        assert.equal(current?.snapshot.price, policy === "publish_price" ? gross : null);
        const pdf = await publicPdfGet(new Request(origin + "/api/public/exposes/LOCAL/pdf"), { params: Promise.resolve({ token: original.token }) });
        assert.equal(pdf.status, 200); const bytes = new Uint8Array(await pdf.arrayBuffer()), text = await pdfText(bytes);
        assert.equal(text.includes(normalized(gross)), policy === "publish_price", "actual anonymous PDF follows current stored website policy");
        assert.ok(!text.includes("315,000.00") && !text.includes("315.000,00"));
        observations.push({ kind: "ORIGINAL_PUBLIC_PDF_ROUTE", policy, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, currentGrossVisible: text.includes(normalized(gross)) });
      }
    });

    await t.test("Website-only selected-property payload preserves Newsletter and the separate classic Exposé policy", async () => {
      const before = { "Eigene Website": "hide_price", Website: "hide_price", Newsletter: "price_on_request", "Exposé": "hide_price", "Off-market": "price_on_request" } as const;
      await db.admin.query("update seller_listings set channel_price_visibility=$2::jsonb where id=$1", [propertyId, JSON.stringify(before)]);
      const response = await propertyGet(new Request(`${origin}/api/crm/properties?workspaceId=${fixture.workspaceId}&operation=full&propertyId=${propertyId}`, { headers: { cookie: "novalure_session=" + cookie } }));
      assert.equal(response.status, 200); const saved = (await response.json()).data.listing.channelPriceVisibility;
      const payload = applyPropertyChannelPriceEdits(saved, { "Eigene Website": "publish_price" });
      await writePolicy(payload);
      assert.equal(payload.Newsletter, "price_on_request"); assert.equal(payload["Exposé"], "hide_price"); assert.equal(payload["Off-market"], "price_on_request");
      assert.ok(!Object.hasOwn(payload, "Website")); assert.equal((await lookupWebExpose(original.token))?.snapshot.price, gross);
      const session = await getRequestSession(new Request(origin, { headers: { cookie: "novalure_session=" + cookie } })); assert.ok(session?.authenticated);
      const snapshot = await withCrmRead(session, () => loadPropertyExposeSnapshot(fixture.workspaceId, propertyId));
      const classic = buildPropertyExposeDocument(snapshot, { template: "compact", language: "es", address: "hidden", showPrice: true, showContact: false, imageIds: [], floorPlanIds: [] }, []);
      assert.equal(classic.price, undefined, "classic PDF still obeys its separate unchanged Exposé channel, not Website policy");
      assert.equal(classic.costs.length, 0);
    });

    await t.test("legacy conflicts tighten existing versions while a later native-only publish can authorize a new version", async () => {
      const conflict = { Website: "publish_price", "Eigene Website": "hide_price", Newsletter: "price_on_request", "Exposé": "hide_price" } as const;
      await db.admin.query("update seller_listings set channel_price_visibility=$2::jsonb where id=$1", [propertyId, JSON.stringify(conflict)]);
      assert.equal((await lookupWebExpose(original.token))?.snapshot.price, null);
      const frozenHidden = await publish();
      await writePolicy(applyPropertyChannelPriceEdits(conflict, { "Eigene Website": "publish_price" }));
      assert.equal((await lookupWebExpose(original.token))?.snapshot.price, gross);
      assert.equal((await lookupWebExpose(frozenHidden.token))?.snapshot.price, null, "frozen hide remains restrictive even after current policy relaxes");
      const newVisible = await publish(); assert.equal((await lookupWebExpose(newVisible.token))?.snapshot.price, gross);
      const saved = (await db.admin.query("select channel_price_visibility as channels from seller_listings where id=$1", [propertyId])).rows[0].channels;
      assert.ok(!Object.hasOwn(saved, "Website"), "native full-map replacement removes the stale legacy key without a new alias writer");
      assert.equal(saved.Newsletter, "price_on_request"); assert.equal(saved["Exposé"], "hide_price");
    });

    await t.test("known zero, unknown gross rent and developer confirmation guards survive website key reconciliation", async () => {
      const zeroId = await create(0); await writePolicy(nativeMap("publish_price"), zeroId); const zero = await publish(zeroId);
      const amountZero = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(0);
      assert.equal((await lookupWebExpose(zero.token))?.snapshot.price, amountZero);
      await db.admin.query("update seller_listings set rent_price_cents=null,canonical_payload=jsonb_set(canonical_payload,'{coreNumericState,rentPrice}','\"unknown\"') where id=$1", [zeroId]);
      assert.equal((await lookupWebExpose(zero.token))?.snapshot.price, null, "unknown gross rent never falls back to asking/private net price");
      await db.admin.query("update seller_listings set rent_price_cents=0,canonical_payload=jsonb_set(canonical_payload,'{coreNumericState,rentPrice}','\"known\"') where id=$1", [zeroId]);
      await db.admin.query("update projects set customer_type='property_developer' where id=$1", [fixture.projectId]);
      try {
        assert.equal((await lookupWebExpose(zero.token))?.snapshot.price, null);
        const built = await preview(zeroId); assert.ok(built.checks.some((v: { id: string; status: string }) => v.id === "DEVELOPER-PRICE" && v.status === "missing"));
        // Explicit synthetic unit-confirmation read fixture, not a claim that a
        // developer authority assignment/confirmation was performed through UI.
        const unit = (await db.admin.query("select unit_id as id from seller_listings where id=$1", [zeroId])).rows[0];
        await db.admin.query("update property_units set metadata=jsonb_set(metadata,'{priceConfirmation}',jsonb_build_object('sourceReference','SYNTHETIC approved zero fixture','priceCents','0')) where id=$1", [unit.id]);
        assert.equal((await lookupWebExpose(zero.token))?.snapshot.price, amountZero);
        await db.admin.query("update property_units set metadata=jsonb_set(metadata,'{priceConfirmation,priceCents}','\"1\"') where id=$1", [unit.id]);
        assert.equal((await lookupWebExpose(zero.token))?.snapshot.price, null);
      } finally { await db.admin.query("update projects set customer_type='real_estate_broker' where id=$1", [fixture.projectId]); }
    });

    await t.test("capability revocation still prevents lookup and actual PDF bytes", async () => {
      const response = await webPost(request("/api/crm/web-exposes", { action: "revoke", propertyId, linkId: original.linkId }));
      assert.equal(response.status, 200, await response.clone().text()); assert.equal(await lookupWebExpose(original.token), null);
      const pdf = await publicPdfGet(new Request(origin + "/api/public/exposes/LOCAL/pdf"), { params: Promise.resolve({ token: original.token }) });
      assert.equal(pdf.status, 404); assert.ok(!(pdf.headers.get("content-type") ?? "").includes("application/pdf"));
    });

    await t.test("two actual sessions reject stale patch/full/core writes and recheck project access before replay", async () => {
      const workspace = randomUUID(), ownProject = randomUUID(), otherProject = randomUUID();
      await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,team_structure,active_calendar_provider) values($1,'SYNTHETIC atomic rules','self_service_customer','real_estate_broker','small_team','none')", [workspace]);
      for (const id of [ownProject, otherProject]) await db.admin.query("insert into projects(id,workspace_id,name,type,customer_type,default_operating_model) values($1,$2,'SYNTHETIC project','Service','real_estate_broker','self_service_customer')", [id, workspace]);
      const actor = async (productRole: ProductRole) => {
        const id = randomUUID(), value = "v2." + randomBytes(32).toString("base64url");
        const inserted = (await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC channel editor',$3,$4,$5,'active') returning auth_identity_id", [id, workspace, `synthetic-${id}@example.invalid`, mapProductRoleToTechnicalRole(productRole), productRole])).rows[0];
        await db.admin.query("update auth_identities set credential_state='active',mfa_enabled_at=now(),mfa_secret_ciphertext='SYNTHETIC-NOT-A-REAL-SECRET' where id=$1", [inserted.auth_identity_id]);
        await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [randomUUID(), createHash("sha256").update(value).digest("hex"), inserted.auth_identity_id, id, workspace]);
        return { id, value };
      };
      const owner = await actor("customer_owner"), admin = await actor("workspace_admin"), limited = await actor("broker_agent");
      await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true),($1,$4,$3,true,false)", [workspace, ownProject, limited.id, otherProject]);
      const metadata = () => ({ key: randomUUID(), correlation: randomUUID() });
      const post = (editor: typeof owner, body: unknown, stamp = metadata(), csrf = true) => propertyPost(new Request(`${origin}/api/crm/properties?workspaceId=${workspace}`, {
        method: "POST", headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", cookie: "novalure_session=" + editor.value,
          "Idempotency-Key": stamp.key, "X-Correlation-Id": stamp.correlation, ...(csrf ? { "x-novalure-csrf-token": createCsrfToken({ method: "POST", pathname: "/api/crm/properties", secret, sessionCookie: editor.value })!.token } : {}) }, body: JSON.stringify(body),
      }));
      const get = async (editor: typeof owner, id: string, operation = "channel_price_visibility") => {
        const response = await propertyGet(new Request(`${origin}/api/crm/properties?workspaceId=${workspace}&operation=${operation}&propertyId=${id}`, { headers: { cookie: "novalure_session=" + editor.value } }));
        assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data;
      };
      const initialMap = { Website: "publish_price", Newsletter: "price_on_request", "Exposé": "hide_price", Immobilienportal: "publish_price" };
      const createPolicyProperty = async (projectId: string) => {
        const response = await post(owner, { operation: "create_property", projectId, title: "SYNTHETIC atomic price rules", address: "SYNTHETIC local address",
          geography: createPropertyGeography("AT", "Wien"), energyCertificate: { version: 1, countryCode: "AT" }, objectType: "Wohnung", usageType: "residential", marketingType: "sale", areaSqm: 85.75, price: 100, priceVisibility: "publish_price", channelPriceVisibility: initialMap });
        assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data.id as string;
      };
      const id = await createPolicyProperty(ownProject), other = await createPolicyProperty(otherProject);
      const stored = async (property: string) => (await db.admin.query("select price_visibility as global,channel_price_visibility as channels,public_price_cents::text as amount,updated_at as updated from seller_listings where id=$1", [property])).rows[0];
      const mirrorRows = async () => (await db.admin.query("select id,project_id as project,channel_type as channel,channel_name as name,price_visibility_override as visibility,status,metadata,updated_at as updated from property_channels where workspace_id=$1 and property_id=$2 order by id", [workspace, id])).rows;
      // A historical mirror from a previous project remains inaccessible to the current tenant write.
      await db.admin.query("insert into property_channels(workspace_id,property_id,project_id,channel_type,channel_name,price_visibility_override,metadata) values($1,$2,$3,'Eigene Website','SYNTHETIC historical mirror','publish_price','{\"historical\":true}')", [workspace, id, otherProject]);
      const initialMirrors = await mirrorRows();
      const count = async () => (await db.admin.query("select count(*)::integer as n from crm_command_receipts where workspace_id=$1 and operation='property.channel_price_visibility.patch'", [workspace])).rows[0].n;
      const patch = (state: { propertyId: string; projectId: string; revision: string }, changes: Record<string, string>) => ({ operation: "patch_channel_price_visibility", propertyId: state.propertyId, expectedProjectId: state.projectId, expectedPolicyRevision: state.revision, changes });
      const beforeA = await get(owner, id), beforeB = await get(admin, id);
      assert.equal(beforeA.revision, beforeB.revision);
      assert.deepEqual(Object.keys(beforeA).sort(), ["channelPriceVisibility", "priceVisibility", "projectId", "propertyId", "revision", "workspaceId"].sort());
      const hide = patch(beforeA, { "Eigene Website": "hide_price" }), hideStamp = metadata();
      assert.equal((await post(owner, { ...hide, publicPrice: 7 })).status, 400);
      assert.equal((await post(owner, { ...hide, priceVisibility: "publish_price" })).status, 400);
      assert.equal((await post(owner, patch(beforeA, { Website: "publish_price" }))).status, 400);
      assert.equal((await post(owner, hide, metadata(), false)).status, 403);
      assert.equal((await post(owner, hide, hideStamp)).status, 200);
      const hidden = await stored(id);
      assert.deepEqual(hidden.channels, { "Eigene Website": "hide_price", Newsletter: "price_on_request", "Exposé": "hide_price", Immobilienportal: "publish_price" });
      assert.equal(hidden.global, "publish_price"); assert.equal(hidden.amount, "10000");
      const hiddenMirrors = await mirrorRows();
      const websiteMirror = hiddenMirrors.find(row => row.project === ownProject && row.channel === "Eigene Website");
      assert.ok(websiteMirror); assert.equal(websiteMirror.visibility, "hide_price");
      assert.deepEqual(hiddenMirrors.filter(row => row.id !== websiteMirror.id), initialMirrors);
      assert.equal(await count(), 1);

      assert.equal((await post(admin, patch(beforeB, { Immobilienportal: "hide_price" }))).status, 409);
      const staleFull = { operation: "update_price_visibility", propertyId: id, projectId: ownProject, priceVisibility: "publish_price", publicPrice: 100, channelPriceVisibility: { ...initialMap, Immobilienportal: "hide_price" } };
      assert.equal((await post(admin, staleFull)).status, 409);
      assert.equal((await post(admin, { ...staleFull, expectedPolicyRevision: beforeB.revision })).status, 409);
      const staleCore = { operation: "update_property_core", propertyId: id, property: { channelPriceVisibility: staleFull.channelPriceVisibility } };
      assert.equal((await post(admin, staleCore)).status, 409);
      assert.equal((await post(admin, { ...staleCore, property: { ...staleCore.property, expectedPolicyRevision: beforeB.revision } })).status, 409);
      assert.deepEqual(await stored(id), hidden); assert.deepEqual(await mirrorRows(), hiddenMirrors); assert.equal(await count(), 1);

      const duplicate = randomUUID();
      await db.admin.query("insert into property_channels(id,workspace_id,property_id,project_id,channel_type,channel_name,price_visibility_override) values($1,$2,$3,$4,'Newsletter','SYNTHETIC duplicate','publish_price')", [duplicate, workspace, id, ownProject]);
      const duplicatedMirrors = await mirrorRows();
      assert.equal((await post(owner, patch(await get(owner, id), { Newsletter: "hide_price" }))).status, 409);
      assert.deepEqual(await stored(id), hidden); assert.deepEqual(await mirrorRows(), duplicatedMirrors); assert.equal(await count(), 1);
      await db.admin.query("delete from property_channels where id=$1", [duplicate]);

      const full = await get(owner, id, "full");
      const edit = createPropertyCoreDraft(full.listing);
      edit.title = "SYNTHETIC core edit after another channel save";
      edit.propertyDetails = full.details;
      edit.coreEdit = { ...edit.coreEdit!, expectedFullSnapshot: full.snapshot };
      const newer = await get(admin, id);
      assert.equal((await post(admin, patch(newer, { "Eigene Website": "price_on_request" }))).status, 200);
      const coreBody = propertyCoreUpdatePayload(edit, workspace, id);
      assert.ok(!Object.hasOwn(coreBody.property, "channelPriceVisibility") && !Object.hasOwn(coreBody.property, "priceVisibility"));
      const coreResult = await post(owner, coreBody);
      assert.equal(coreResult.status, 200, await coreResult.clone().text());
      assert.equal((await stored(id)).channels["Eigene Website"], "price_on_request");
      const replay = await post(owner, hide, hideStamp);
      assert.equal(replay.status, 200); assert.equal((await replay.json()).replayed, true);
      assert.equal((await stored(id)).channels["Eigene Website"], "price_on_request"); assert.equal(await count(), 2);
      assert.equal((await mirrorRows()).find(row => row.id === websiteMirror.id)?.visibility, "price_on_request");

      const foreign = await get(owner, other);
      // The actual write-scoped row lock applies RLS before project grant lookup.
      assert.equal((await post(limited, { ...patch(foreign, { "Eigene Website": "hide_price" }), expectedProjectId: ownProject })).status, 404);
      assert.deepEqual((await stored(other)).channels, initialMap);
      const limitedBefore = await get(limited, id), limitedStamp = metadata(), limitedBody = patch(limitedBefore, { Immobilienportal: "hide_price" });
      assert.equal((await post(limited, limitedBody, limitedStamp)).status, 200);
      const limitedSaved = await stored(id);
      const limitedMirrors = await mirrorRows();
      const portalMirror = limitedMirrors.find(row => row.project === ownProject && row.channel === "Immobilienportal");
      assert.ok(portalMirror); assert.equal(portalMirror.visibility, "hide_price");
      await db.admin.query("update project_pipeline_permissions set can_edit_deals=false where workspace_id=$1 and project_id=$2 and user_id=$3", [workspace, ownProject, limited.id]);
      assert.equal((await post(limited, limitedBody, limitedStamp)).status, 404);
      assert.deepEqual(await stored(id), limitedSaved); assert.deepEqual(await mirrorRows(), limitedMirrors); assert.equal(await count(), 3);

      const current = await get(owner, id);
      const freshFull = { ...staleFull, expectedPolicyRevision: current.revision, priceVisibility: "hide_price", publicPrice: 120, channelPriceVisibility: limitedSaved.channels };
      assert.equal((await post(owner, freshFull)).status, 200);
      const afterFull = await stored(id);
      assert.equal(afterFull.global, "hide_price"); assert.equal(afterFull.amount, "12000"); assert.deepEqual(afterFull.channels, limitedSaved.channels);
      await db.admin.query("update property_channels set price_visibility_override='publish_price' where id=$1", [portalMirror.id]);
      assert.equal((await post(owner, { ...freshFull, expectedPolicyRevision: undefined })).status, 200);
      assert.deepEqual(await stored(id), afterFull, "unchanged legacy full save leaves the row untouched");
      assert.equal((await mirrorRows()).find(row => row.id === portalMirror.id)?.visibility, "hide_price", "equal seller map reconciles its existing channel row");
      const amountCore = { operation: "update_property_core", propertyId: id, property: { publicPrice: 130 } };
      assert.equal((await post(owner, amountCore)).status, 409);
      assert.equal((await post(owner, { ...amountCore, property: { ...amountCore.property, expectedPolicyRevision: current.revision } })).status, 409);
      assert.deepEqual(await stored(id), afterFull);
      assert.equal((await post(owner, { operation: "update_property_core", propertyId: id, property: { title: "SYNTHETIC unrelated edit" } })).status, 200);
      const afterNonPrice = await stored(id);
      assert.equal(afterNonPrice.global, afterFull.global); assert.equal(afterNonPrice.amount, afterFull.amount); assert.deepEqual(afterNonPrice.channels, afterFull.channels);
      const freshCore = await get(owner, id);
      assert.equal((await post(owner, { ...amountCore, property: { ...amountCore.property, expectedPolicyRevision: freshCore.revision } })).status, 200);
      const afterAmount = await stored(id);
      assert.equal(afterAmount.global, afterFull.global); assert.equal(afterAmount.amount, "13000"); assert.deepEqual(afterAmount.channels, afterFull.channels);
      observations.push({ kind: "TWO_SESSION_ATOMIC_POLICY", stalePatchRejected: true, staleLegacyAndCoreRejected: true, unrelatedFullEditorPreservedNewPolicy: true, replayDidNotRestoreOldPolicy: true, actualProjectDenialAndRevocationRechecked: true, ordinaryFreshFullSavePreserved: true, editedChannelMirrorsSynchronized: true, staleOrUneditedMirrorsPreserved: true, duplicateMirrorRollbackVerified: true });
    });
    const historical = await readFile(path.resolve("migrations/190_property_inventory_knownness.sql"));
    observations.push({ kind: "SOURCE_BINDING", historical190Sha256: createHash("sha256").update(historical).digest("hex"), migration198Sha256: createHash("sha256").update(await readFile(path.resolve("migrations/198_property_website_price_visibility.sql"))).digest("hex") });
  } finally {
    await writeFile(path.join(db.directory, "website-price-policy-observations.json"), JSON.stringify({ scope: "REAL_LOCAL_PG_AND_ORIGINAL_HANDLERS_SYNTHETIC_ONLY_NOT_BROWSER", observations }, null, 2) + "\n");
    globalThis.fetch = oldFetch; await closeLocalTestPool();
    for (const key of envKeys) { if (priorEnv[key] === undefined) delete process.env[key]; else process.env[key] = priorEnv[key]; }
    await db.stop();
  }
});
