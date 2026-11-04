import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { withCrmRead, type TenantTransaction } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { createPropertyGeography } from "../src/lib/property-country";
import { emptyPropertyCreationDraft, parsePropertyCreationDraft, propertyCreationIssues, propertyCreationPayload, type PropertyCreationDraft } from "../src/lib/property-create-draft";
import { completePropertyCreationDraft, loadPropertyCreationDrafts, savePropertyCreationDraft } from "../src/lib/db/property-create-draft-repository";
import { propertyCoreNumberIsKnown, propertyOptionalPriceIsKnown } from "../src/lib/property-core-numbers";

test("guided draft shares strict property values while retaining incomplete numbers for correction", () => {
  const draft = emptyPropertyCreationDraft(); assert.equal(draft.geography, null); assert.equal(draft.priceVisibility, "price_on_request");
  assert.equal(propertyCreationIssues(draft).length, 4);
  assert.throws(() => parsePropertyCreationDraft({ ...draft, sendEmail: true }));
  assert.throws(() => parsePropertyCreationDraft({ ...draft, geography: createPropertyGeography("DE", "Bayern"), region: "Wien", energyCertificate: { version: 1, countryCode: "DE" } }));
  const corrected = { ...draft, projectId: randomUUID(), geography: createPropertyGeography("ES", "Catalunya"), region: "Catalunya", title: "Synthetic", address: "Synthetic", energyCertificate: { version: 1 as const, countryCode: "ES" as const }, areaSqm: "bad", publicPrice: "10.001" };
  assert.equal(parsePropertyCreationDraft(corrected).areaSqm, "bad"); assert.deepEqual(propertyCreationIssues(corrected).map(issue => issue.field), ["areaSqm", "publicPrice"]);
  assert.throws(() => propertyCreationPayload(corrected));
  const payload = propertyCreationPayload({ ...corrected, areaSqm: "52,75", publicPrice: "210000,99" }); assert.equal(payload.areaSqm, 52.75); assert.equal(payload.publicPrice, 210000.99); assert.equal(payload.price, null);
});
test("guided creation stores private resumable drafts and commits the existing property model atomically", { timeout: 180000 }, async t => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 }); await db.admin.query(await readFile("migrations/173_property_creation_drafts.sql", "utf8"));
    const workspaceId = randomUUID(), foreignWorkspace = randomUUID(), userId = randomUUID(), otherId = randomUUID(), foreignId = randomUUID(), projectId = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC guided','self_service_customer','real_estate_broker'),($2,'SYNTHETIC foreign','self_service_customer','real_estate_broker')", [workspaceId, foreignWorkspace]);
    for (const [id, ws] of [[userId, workspaceId], [otherId, workspaceId], [foreignId, foreignWorkspace]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic',$3,'owner','customer_owner','active')", [id, ws, `${id}@example.invalid`]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC guided project','Service')", [projectId, workspaceId]);
    const session = { authenticated: true, userId, workspaceId, workspaceName: "Synthetic", name: "Synthetic", email: `${userId}@example.invalid`, role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" } as AppSession;
    const other = { ...session, userId: otherId }, foreign = { ...session, userId: foreignId, workspaceId: foreignWorkspace };
    const options = { pool: db.pool as unknown as TenantPool }, run = <T>(work: (tx: TenantTransaction, fresh: AppSession) => Promise<T>, actor = session) => withCrmRead(actor, work, options);
    const id = randomUUID(), requestId = randomUUID(); let draft = emptyPropertyCreationDraft(projectId), revision = 0;
    await t.test("partial state resumes in a fresh transaction, retries once and rejects stale or foreign modifications", async () => {
      draft = { ...draft, title: "SYNTHETIC unfinished", areaSqm: "12," };
      const input = { id, draft, step: 1, expectedRevision: 0, requestId };
      const first = await run((tx, fresh) => savePropertyCreationDraft(tx, fresh, input)); revision = first.revision;
      const replay = await run((tx, fresh) => savePropertyCreationDraft(tx, fresh, input)); assert.equal(replay.replayed, true); assert.equal(replay.revision, revision);
      const loaded = await run(loadPropertyCreationDrafts); assert.equal(loaded.drafts[0].draft.areaSqm, "12,"); assert.equal(loaded.drafts[0].step, 1); assert.ok(loaded.drafts[0].issues.length > 0);
      assert.equal((await run(loadPropertyCreationDrafts, other)).drafts.length, 0); assert.equal((await run(loadPropertyCreationDrafts, foreign)).drafts.length, 0);
      assert.equal((await run(tx => tx.query(`select id from crm_property_creation_drafts where id=$1::uuid`, [id]), other)).length, 0, "RLS denies another owner even without an application user filter");
      await assert.rejects(run((tx, fresh) => savePropertyCreationDraft(tx, fresh, { ...input, expectedRevision: revision, requestId: randomUUID() }), other));
      await assert.rejects(run((tx, fresh) => savePropertyCreationDraft(tx, fresh, { ...input, expectedRevision: 0, requestId: randomUUID() })));
      await assert.rejects(run((tx, fresh) => savePropertyCreationDraft(tx, fresh, { ...input, draft: { ...draft, title: "same key different data" } })));
      const receipts = (await db.admin.query("select count(*) from crm_command_receipts where workspace_id=$1", [workspaceId])).rows[0]; assert.equal(Number(receipts.count), 0, "unfinished personal inputs must not enter general receipts");
    });
    await t.test("missing required data never creates a listing or advances the draft", async () => {
      await assert.rejects(completePropertyCreationDraft(session, { id, expectedRevision: revision }, { idempotencyKey: randomUUID(), correlationId: randomUUID() }, options), /Land|Adresse|Fläche/);
      assert.equal(Number((await db.admin.query("select count(*) from seller_listings where workspace_id=$1", [workspaceId])).rows[0].count), 0);
      assert.equal((await run(loadPropertyCreationDrafts)).drafts[0].revision, revision);
    });
    await t.test("all four countries create real persisted properties and replay without duplicate entities", async () => {
      for (const [country, region] of [["AT", "Tirol"], ["DE", "Bayern"], ["ES", "Catalunya"], ["IE", "Dublin"]] as const) {
        const draftId = country === "AT" ? id : randomUUID(), priorRevision = country === "AT" ? revision : 0;
        const value: PropertyCreationDraft = { ...emptyPropertyCreationDraft(projectId), title: `SYNTHETIC ${country}`, address: `SYNTHETIC ${country}`, region, geography: createPropertyGeography(country, region), energyCertificate: { version: 1, countryCode: country }, areaSqm: "55,25", rooms: "2,5", price: "123456,78", publicPrice: "124000,99" };
        const saved = await run((tx, fresh) => savePropertyCreationDraft(tx, fresh, { id: draftId, draft: value, step: 3, expectedRevision: priorRevision, requestId: randomUUID() }));
        const metadata = { idempotencyKey: randomUUID(), correlationId: randomUUID() }, input = { id: draftId, expectedRevision: saved.revision };
        const result = await completePropertyCreationDraft(session, input, metadata, options), replay = await completePropertyCreationDraft(session, input, metadata, options);
        assert.equal(result.data.countryCode, country); assert.equal(result.data.areaSqm, 55.25); assert.equal(result.data.targetPrice, 123456.78); assert.equal(replay.data.id, result.data.id); assert.equal(replay.replayed, true);
        assert.equal((result.data.canonicalPayload?.base as Record<string, unknown>).priceVisibility, "price_on_request");
        const stored = (await db.admin.query("select status,created_property_id from crm_property_creation_drafts where id=$1", [draftId])).rows[0]; assert.equal(stored.status, "created"); assert.equal(stored.created_property_id, result.data.id);
        await assert.rejects(completePropertyCreationDraft(other, input, metadata, options), /Entwurf/);
        await assert.rejects(completePropertyCreationDraft(session, input, { idempotencyKey: randomUUID(), correlationId: randomUUID() }, options), /bereits/);
      }
      assert.equal(Number((await db.admin.query("select count(*) from seller_listings where workspace_id=$1", [workspaceId])).rows[0].count), 4);
      assert.equal((await run(loadPropertyCreationDrafts)).drafts.length, 0);
    });
    await t.test("guided blank and explicit zero create distinct persisted numeric states", async () => {
      for (const supplied of ["", "0"]) {
        const draftId = randomUUID(), value: PropertyCreationDraft = { ...emptyPropertyCreationDraft(projectId), title: `SYNTHETIC ${supplied === "" ? "unknown" : "zero"}`, address: "SYNTHETIC numeric state",
          geography: createPropertyGeography("AT", "Wien"), region: "Wien", energyCertificate: { version: 1, countryCode: "AT" }, areaSqm: supplied, price: supplied, publicPrice: supplied, rentPrice: supplied };
        const saved = await run((tx, fresh) => savePropertyCreationDraft(tx, fresh, { id: draftId, draft: value, step: 3, expectedRevision: 0, requestId: randomUUID() }));
        const result = await completePropertyCreationDraft(session, { id: draftId, expectedRevision: saved.revision }, { idempotencyKey: randomUUID(), correlationId: randomUUID() }, options);
        const persisted = (await db.admin.query("select area_sqm,target_price_cents,public_price_cents,rent_price_cents,canonical_payload from seller_listings where id=$1", [result.data.id])).rows[0];
        assert.equal(Number(persisted.area_sqm), 0); assert.equal(Number(persisted.target_price_cents), 0);
        assert.equal(propertyCoreNumberIsKnown(persisted.canonical_payload, "areaSqm", persisted.area_sqm), supplied === "0");
        assert.equal(propertyCoreNumberIsKnown(persisted.canonical_payload, "price", persisted.target_price_cents), supplied === "0");
        assert.equal(propertyOptionalPriceIsKnown(persisted.canonical_payload, "publicPrice", persisted.public_price_cents), supplied === "0");
        assert.equal(propertyOptionalPriceIsKnown(persisted.canonical_payload, "rentPrice", persisted.rent_price_cents), supplied === "0");
        assert.equal(persisted.canonical_payload.propertyDetails.values["areas.wohnfl_che"], supplied === "0" ? 0 : null);
      }
    });
    await t.test("failure in the final audit rolls back the listing, helper unit and draft together", async () => {
      const draftId = randomUUID(), value = { ...emptyPropertyCreationDraft(projectId), title: "SYNTHETIC rollback", address: "SYNTHETIC", geography: createPropertyGeography("IE", "Dublin"), region: "Dublin", energyCertificate: { version: 1 as const, countryCode: "IE" as const } };
      const saved = await run((tx, fresh) => savePropertyCreationDraft(tx, fresh, { id: draftId, draft: value, step: 3, expectedRevision: 0, requestId: randomUUID() }));
      const count = async (table: string) => Number((await db.admin.query(`select count(*) from ${table} where workspace_id=$1`, [workspaceId])).rows[0].count);
      const beforeListings = await count("seller_listings"), beforeUnits = await count("property_units");
      await db.admin.query(`create function qa_draft_audit_fail() returns trigger language plpgsql as $$ begin if new.action='property.complete_draft' then raise exception 'synthetic final audit unavailable'; end if; return new; end $$; create trigger qa_draft_audit_fail before insert on audit_logs for each row execute function qa_draft_audit_fail()`);
      try { await assert.rejects(completePropertyCreationDraft(session, { id: draftId, expectedRevision: saved.revision }, { idempotencyKey: randomUUID(), correlationId: randomUUID() }, options), /synthetic final audit/); }
      finally { await db.admin.query("drop trigger qa_draft_audit_fail on audit_logs; drop function qa_draft_audit_fail()"); }
      assert.equal(await count("seller_listings"), beforeListings); assert.equal(await count("property_units"), beforeUnits);
      const persisted = (await db.admin.query("select status,revision,created_property_id from crm_property_creation_drafts where id=$1", [draftId])).rows[0]; assert.deepEqual(persisted, { status: "active", revision: saved.revision, created_property_id: null });
      const discarded = await run((tx, fresh) => savePropertyCreationDraft(tx, fresh, { id: draftId, draft: value, step: 3, expectedRevision: saved.revision, requestId: randomUUID(), discard: true })); assert.equal(discarded.status, "discarded"); assert.equal((await run(loadPropertyCreationDrafts)).drafts.length, 0);
    });
    await t.test("project rights are rechecked for resumed drafts and revocation blocks writes", async () => {
      const draftId = randomUUID(), partial = emptyPropertyCreationDraft(projectId);
      const saved = await run((tx, fresh) => savePropertyCreationDraft(tx, fresh, { id: draftId, draft: partial, step: 0, expectedRevision: 0, requestId: randomUUID() }), other);
      await db.admin.query("update workspace_users set role='agent',product_role='external_partner' where id=$1", [otherId]);
      await assert.rejects(run(loadPropertyCreationDrafts, other), /nicht freigegeben/);
      await assert.rejects(run((tx, fresh) => savePropertyCreationDraft(tx, fresh, { id: draftId, draft: { ...partial, title: "denied" }, step: 0, expectedRevision: saved.revision, requestId: randomUUID() }), other));
      assert.equal((await db.admin.query("select draft->>'title' as title from crm_property_creation_drafts where id=$1", [draftId])).rows[0].title, "");
    });
  } finally { await db.stop(); }
});
