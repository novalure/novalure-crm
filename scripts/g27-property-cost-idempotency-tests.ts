import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { POST } from "../src/app/api/crm/properties/route";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";

type CommandMetadata = Readonly<{ correlationId: string; idempotencyKey: string }>;

const operation = "property.cost_items.save";
const routePath = "/api/crm/properties";

function metadata(): CommandMetadata {
  return { correlationId: randomUUID(), idempotencyKey: randomUUID() };
}

function costItems(gross = "1200") {
  return [{
    costKey: "operating",
    groupKey: "monthly",
    label: "SYNTHETIC operating costs",
    monthlyGrossCents: gross,
    monthlyNetCents: "1000",
    monthlyVatCents: (BigInt(gross) - BigInt(1000)).toString(),
    oneTimeGrossCents: "0",
    oneTimeNetCents: "0",
    oneTimeVatCents: "0",
    vatPercent: "20",
  }];
}

test("G27 PROPERTY_COST_MATRIX uses one atomic HTTP command receipt", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  const environmentNames = [
    "CRM_LOCAL_TEST_DATABASE",
    "DATABASE_URL",
    "NODE_ENV",
    "NOVALURE_APP_ORIGIN",
    "NOVALURE_AUTH_ENCRYPTION_KEY",
    "NOVALURE_AUTH_RATE_LIMIT_SECRET",
    "NOVALURE_AUTH_STRICT",
    "NOVALURE_SESSION_SECRET",
  ];
  const previousEnvironment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
  try {
    await applySalesSchema(db);
    const deleteBoundary = (await db.admin.query(`
      select
        has_table_privilege('novalure_tenant_app','property_cost_items','DELETE') delete_granted,
        relation.relrowsecurity rls_enabled,
        relation.relforcerowsecurity rls_forced,
        exists(
          select 1 from pg_policies
          where schemaname='public' and tablename='property_cost_items'
            and policyname='crm_sales_write' and cmd='ALL'
            and 'novalure_tenant_app'=any(roles)
        ) scoped_policy
      from pg_class relation
      where relation.oid='public.property_cost_items'::regclass
    `)).rows[0];
    assert.deepEqual(deleteBoundary, {
      delete_granted: true,
      rls_enabled: true,
      rls_forced: true,
      scoped_policy: true,
    });
    const fixture = await seedSalesBrowser(db);
    const secret = randomBytes(48).toString("base64url");
    const origin = "http://127.0.0.1:3000";
    Object.assign(process.env, {
      CRM_LOCAL_TEST_DATABASE: "1",
      DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`,
      NODE_ENV: "test",
      NOVALURE_APP_ORIGIN: origin,
      NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"),
      NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex"),
      NOVALURE_AUTH_STRICT: "1",
      NOVALURE_SESSION_SECRET: secret,
    });

    const cookie = `v2.${randomBytes(32).toString("base64url")}`;
    const sessionId = randomUUID();
    await db.admin.query(`
      insert into auth_sessions(
        id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at
      ) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')
    `, [sessionId, createHash("sha256").update(cookie).digest("hex"), fixture.authIdentityId,
      fixture.userId, fixture.workspaceId]);

    const firstPropertyId = randomUUID();
    const rollbackPropertyId = randomUUID();
    for (const [propertyId, title] of [
      [firstPropertyId, "SYNTHETIC idempotent cost property"],
      [rollbackPropertyId, "SYNTHETIC rollback cost property"],
    ]) {
      await db.admin.query(`
        insert into seller_listings(
          id,workspace_id,project_id,title,address,region,object_type,area_sqm,
          market_value_cents,target_price_cents
        ) values($1,$2,$3,$4,'SYNTHETIC address','Wien','apartment',50,0,0)
      `, [propertyId, fixture.workspaceId, fixture.projectId, title]);
    }

    const body = (propertyId: string, items: unknown = costItems()) => ({
      costItems: items,
      operation: "save_cost_items",
      projectId: fixture.projectId,
      propertyId,
    });
    const request = (payload: unknown, command?: Partial<CommandMetadata>, contentType = "application/json") => {
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        cookie: `novalure_session=${cookie}`,
        origin,
        "sec-fetch-site": "same-origin",
        "x-novalure-csrf-token": createCsrfToken({
          method: "POST",
          pathname: routePath,
          secret,
          sessionCookie: cookie,
        })!.token,
      };
      if (command?.idempotencyKey) headers["Idempotency-Key"] = command.idempotencyKey;
      if (command?.correlationId) headers["X-Correlation-Id"] = command.correlationId;
      return new Request(`${origin}${routePath}`, { method: "POST", headers, body: JSON.stringify(payload) });
    };

    await t.test("strict HTTP boundary rejects wrong media, oversized, unknown, excessive and overlong cost input", async () => {
      const command = metadata();
      const wrongMedia = await POST(request(body(firstPropertyId), command, "text/plain"));
      assert.equal(wrongMedia.status, 415);
      assert.equal((await wrongMedia.json()).code, "JSON_REQUIRED");

      const oversized = await POST(request({ ...body(firstPropertyId), padding: "x".repeat(17_000) }, command));
      assert.equal(oversized.status, 413);
      assert.equal((await oversized.json()).code, "BODY_TOO_LARGE");

      const unknownTopLevel = await POST(request({ ...body(firstPropertyId), net: "1000" }, command));
      assert.equal(unknownTopLevel.status, 400);
      assert.equal((await unknownTopLevel.json()).code, "UNKNOWN_FIELD");

      const unknownItem = await POST(request(body(firstPropertyId, [{
        ...costItems()[0],
        gross: "1200",
      }]), command));
      assert.equal(unknownItem.status, 400);
      assert.equal((await unknownItem.json()).code, "UNKNOWN_FIELD");

      const excessive = await POST(request(body(firstPropertyId, Array.from({ length: 101 }, (_, index) => ({
        costKey: `cost-${index}`,
        label: "SYNTHETIC cost",
      }))), command));
      assert.equal(excessive.status, 400);
      assert.equal((await excessive.json()).code, "COST_ITEMS_LIMIT");

      const overlong = await POST(request(body(firstPropertyId, [{
        ...costItems()[0],
        label: "x".repeat(201),
      }]), command));
      assert.equal(overlong.status, 400);
      assert.equal((await overlong.json()).code, "INVALID_COST_ITEM");

      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and resource_id=$2",
        [fixture.workspaceId, firstPropertyId],
      )).rows[0].count, 0);
    });

    await t.test("route requires the shared CRM idempotency and correlation metadata", async () => {
      const missingBoth = await POST(request(body(firstPropertyId)));
      assert.equal(missingBoth.status, 400);
      assert.equal((await missingBoth.json()).code, "IDEMPOTENCY_REQUIRED");

      const missingCorrelation = await POST(request(body(firstPropertyId), { idempotencyKey: randomUUID() }));
      assert.equal(missingCorrelation.status, 400);
      assert.equal((await missingCorrelation.json()).code, "VALIDATION_ERROR");
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and resource_id=$2",
        [fixture.workspaceId, firstPropertyId],
      )).rows[0].count, 0);
    });

    await t.test("parallel exact duplicates create one snapshot and changed payload reuse conflicts", async () => {
      const command = metadata();
      const payload = body(firstPropertyId);
      const responses = await Promise.all([
        POST(request(payload, command)),
        POST(request(payload, command)),
      ]);
      for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
      const results = await Promise.all(responses.map(response => response.json()));
      assert.equal(results[0].commandId, results[1].commandId);
      assert.equal(results[0].auditReference, results[1].auditReference);
      assert.equal(results[0].data.snapshotId, results[1].data.snapshotId);
      assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
      assert.equal(results[0].correlationId, command.correlationId);

      const counts = (await db.admin.query(`
        select
          (select count(*)::int from property_cost_items where workspace_id=$1 and property_id=$2) cost_items,
          (select count(*)::int from crm_financial_snapshots where workspace_id=$1 and resource_type='PROPERTY_COST_MATRIX' and resource_id=$2) snapshots,
          (select count(*)::int from crm_financial_events e join crm_financial_snapshots s on s.workspace_id=e.workspace_id and s.id=e.snapshot_id where s.workspace_id=$1 and s.resource_id=$2) financial_events,
          (select count(*)::int from crm_command_receipts where workspace_id=$1 and idempotency_key=$3) receipts,
          (select count(*)::int from crm_domain_events where workspace_id=$1 and command_id=$4) domain_events,
          (select count(*)::int from audit_logs where workspace_id=$1 and action=$5 and entity_id=$2) audit_logs
      `, [fixture.workspaceId, firstPropertyId, command.idempotencyKey, results[0].commandId, operation])).rows[0];
      assert.deepEqual(counts, {
        audit_logs: 1,
        cost_items: 1,
        domain_events: 1,
        financial_events: 1,
        receipts: 1,
        snapshots: 1,
      });
      const snapshot = (await db.admin.query(`
        select business_version,correlation_id from crm_financial_snapshots
        where workspace_id=$1 and resource_type='PROPERTY_COST_MATRIX' and resource_id=$2
      `, [fixture.workspaceId, firstPropertyId])).rows[0];
      assert.equal(Number(snapshot.business_version), 1);
      assert.equal(snapshot.correlation_id, command.correlationId);

      const changed = await POST(request(body(firstPropertyId, costItems("1300")), command));
      assert.equal(changed.status, 409, await changed.clone().text());
      assert.equal((await changed.json()).code, "IDEMPOTENCY_CONFLICT");
      assert.equal((await db.admin.query(
        "select monthly_gross_cents::text amount from property_cost_items where workspace_id=$1 and property_id=$2",
        [fixture.workspaceId, firstPropertyId],
      )).rows[0].amount, "1200");
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and resource_id=$2",
        [fixture.workspaceId, firstPropertyId],
      )).rows[0].count, 1);
    });

    await t.test("late receipt failure rolls costs, snapshot, events and audit back; same-key retry then commits", async () => {
      await db.admin.query(`
        insert into property_cost_items(
          workspace_id,project_id,property_id,cost_key,group_key,label,
          monthly_net_cents,monthly_vat_cents,monthly_gross_cents
        ) values($1,$2,$3,'original','monthly','SYNTHETIC original',400,80,480)
      `, [fixture.workspaceId, fixture.projectId, rollbackPropertyId]);
      await db.admin.query(`
        create function qa_g27_fail_property_cost_receipt() returns trigger language plpgsql as $$
        begin
          if new.operation='property.cost_items.save' then
            raise exception 'INJECTED_G27_PROPERTY_COST_RECEIPT_FAILURE';
          end if;
          return new;
        end $$
      `);
      await db.admin.query(`
        create trigger qa_g27_fail_property_cost_receipt before insert on crm_command_receipts
        for each row execute function qa_g27_fail_property_cost_receipt()
      `);
      const command = metadata();
      const payload = body(rollbackPropertyId);
      try {
        const failed = await POST(request(payload, command));
        assert.equal(failed.status, 503, await failed.clone().text());
        assert.equal((await failed.json()).code, "CRM_UNAVAILABLE");
        const state = (await db.admin.query(`
          select
            (select count(*)::int from property_cost_items where workspace_id=$1 and property_id=$2 and cost_key='original') original_costs,
            (select count(*)::int from property_cost_items where workspace_id=$1 and property_id=$2 and cost_key='operating') replacement_costs,
            (select count(*)::int from crm_financial_snapshots where workspace_id=$1 and resource_type='PROPERTY_COST_MATRIX' and resource_id=$2) snapshots,
            (select count(*)::int from crm_financial_events e join crm_financial_snapshots s on s.workspace_id=e.workspace_id and s.id=e.snapshot_id where s.workspace_id=$1 and s.resource_id=$2) financial_events,
            (select count(*)::int from audit_logs where workspace_id=$1 and action=$3 and entity_id=$2) audit_logs,
            (select count(*)::int from crm_domain_events where workspace_id=$1 and resource_id=$2 and event_type=$3) domain_events,
            (select count(*)::int from crm_command_receipts where workspace_id=$1 and idempotency_key=$4) receipts
        `, [fixture.workspaceId, rollbackPropertyId, operation, command.idempotencyKey])).rows[0];
        assert.deepEqual(state, {
          audit_logs: 0,
          domain_events: 0,
          financial_events: 0,
          original_costs: 1,
          receipts: 0,
          replacement_costs: 0,
          snapshots: 0,
        });
      } finally {
        await db.admin.query("drop trigger if exists qa_g27_fail_property_cost_receipt on crm_command_receipts");
        await db.admin.query("drop function if exists qa_g27_fail_property_cost_receipt()");
      }

      const retried = await POST(request(payload, command));
      assert.equal(retried.status, 200, await retried.clone().text());
      const result = await retried.json();
      assert.equal(result.replayed, false);
      assert.equal(result.data.businessVersion, 1);
      const committed = (await db.admin.query(`
        select
          (select count(*)::int from property_cost_items where workspace_id=$1 and property_id=$2 and cost_key='original') original_costs,
          (select count(*)::int from property_cost_items where workspace_id=$1 and property_id=$2 and cost_key='operating') replacement_costs,
          (select count(*)::int from crm_financial_snapshots where workspace_id=$1 and resource_type='PROPERTY_COST_MATRIX' and resource_id=$2) snapshots,
          (select count(*)::int from crm_command_receipts where workspace_id=$1 and idempotency_key=$3) receipts
      `, [fixture.workspaceId, rollbackPropertyId, command.idempotencyKey])).rows[0];
      assert.deepEqual(committed, { original_costs: 0, receipts: 1, replacement_costs: 1, snapshots: 1 });
    });
  } finally {
    await closeLocalTestPool();
    for (const name of environmentNames) {
      if (previousEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnvironment[name];
    }
    await db.stop();
  }
});
