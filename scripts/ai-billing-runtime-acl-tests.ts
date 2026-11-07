import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import type { AppSession } from "../src/lib/auth/session";
import { withCrmRead, type TenantTransactionOptions } from "../src/lib/crm-command";
import { applyAdminAiBillingAction, readAdminAiBilling } from "../src/lib/ai-billing/admin-repository";
import { readAiCreditSnapshot, requestAiBooking, reserveAiCredits, settleAiCredits } from "../src/lib/ai-billing/repository";
import { AI_CATALOG_VERSION } from "../src/lib/ai-billing/catalog";

const tables = ["ai_credit_accounts", "ai_credit_buckets", "ai_credit_reservations", "ai_billing_requests", "ai_billing_fulfillments", "ai_credit_reconciliations", "ai_booking_status_events", "ai_billing_admin_receipts"];
const rawFunctions = ["crm_ai_fulfill_booking(uuid,text,text,timestamptz)", "crm_ai_close_booking(uuid,text)", "crm_ai_reconcile_reservation(uuid,integer,text,text,text)", "crm_ai_operator_requests(uuid,text)", "crm_ai_operator_reservations(uuid)", "crm_ai_assert_actor(uuid)", "crm_ai_refresh(uuid)", "crm_ai_admin_assert(uuid)", "crm_ai_admin_receipt_immutable()"];
const guardedFunctions = ["crm_ai_can_book(uuid)", "crm_ai_snapshot(uuid)", "crm_ai_reserve(uuid,uuid,text,integer,text,jsonb)", "crm_ai_settle(uuid,uuid,integer,text)", "crm_ai_request_booking(uuid,uuid,text,text,text,text,text,jsonb)", "crm_ai_admin_read(uuid,uuid,text)", "crm_ai_admin_action(uuid,uuid,text,jsonb)"];

test("production default grants cannot bypass AI billing guards after migration 153", { timeout: 240_000 }, async (t) => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    await db.admin.query("grant novalure_tenant_app to novalure_app");
    // Reproduce the production owner's defaults before creating the feature.
    await db.admin.query("alter default privileges in schema public grant select,insert,update,delete on tables to novalure_app");
    await db.admin.query("alter default privileges in schema public grant execute on functions to novalure_app");
    const defaults = () => db.admin.query("select defaclobjtype,defaclacl::text from pg_default_acl where defaclrole=current_user::regrole and defaclnamespace='public'::regnamespace order by defaclobjtype");
    const originalDefaults = (await defaults()).rows;
    await db.admin.query(await readFile("migrations/146_ai_credit_billing.sql", "utf8"));
    await db.admin.query(await readFile("migrations/152_ai_billing_admin.sql", "utf8"));
    const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
    const privilege = async (kind: "function" | "table", role: string, object: string, permission: string) => {
      const result = await db.admin.query(`select has_${kind}_privilege($1,$2,$3) as allowed`, [role, `public.${object}`, permission]);
      return result.rows[0].allowed as boolean;
    };
    await t.test("the fixture exposes the real direct-runtime privilege leak", async () => {
      assert.equal(await privilege("function", db.role, rawFunctions[0], "EXECUTE"), true);
      assert.equal(await privilege("function", db.role, "crm_ai_operator_requests(uuid,text)", "EXECUTE"), true);
      assert.equal(await privilege("table", db.role, "ai_billing_admin_receipts", "INSERT"), true);
      assert.equal(await privilege("table", db.role, "ai_credit_buckets", "UPDATE"), true);
    });
    await db.admin.query(await readFile("migrations/153_ai_billing_runtime_acl.sql", "utf8"));
    await t.test("only inherited guarded privileges remain and global defaults are untouched", async () => {
      for (const signature of rawFunctions) assert.equal(await privilege("function", db.role, signature, "EXECUTE"), false, signature);
      for (const signature of guardedFunctions) assert.equal(await privilege("function", db.role, signature, "EXECUTE"), true, signature);
      for (const table of tables) {
        for (const action of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) assert.equal(await privilege("table", db.role, table, action), false, `${table}:${action}`);
      }
      const directTable = await db.admin.query("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(c.relacl) a where n.nspname='public' and c.relname=any($1::text[]) and a.grantee='novalure_app'::regrole", [tables]);
      const directFunctions = await db.admin.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(p.proacl) a where n.nspname='public' and p.oid=any($1::regprocedure[]) and a.grantee='novalure_app'::regrole", [[...rawFunctions, ...guardedFunctions].map(signature => `public.${signature}`)]);
      assert.deepEqual(directTable.rows, []); assert.deepEqual(directFunctions.rows, []);
      assert.deepEqual((await defaults()).rows, originalDefaults);
      for (const signature of ["crm_ai_fulfill_booking(uuid,text,text,timestamptz)", "crm_ai_close_booking(uuid,text)", "crm_ai_reconcile_reservation(uuid,integer,text,text,text)", "crm_ai_operator_requests(uuid,text)", "crm_ai_operator_reservations(uuid)"]) {
        assert.equal(await privilege("function", "novalure_ai_billing_writer", signature, "EXECUTE"), true, signature);
      }
    });
    async function company(internal: boolean): Promise<AppSession> {
      const workspaceId = randomUUID(), userId = randomUUID(), productRole = internal ? "novalureAdmin" : "customer_owner", role = internal ? "admin" : "owner";
      await db.admin.query("insert into workspaces(id,name,operating_model) values($1,$2,$3)", [workspaceId, internal ? "SYNTHETIC internal billing ACL" : "SYNTHETIC customer billing ACL", internal ? "novalure_internal" : "self_service_customer"]);
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC ACL member',$3,$4,$5,'active')", [userId, workspaceId, `${userId}@example.invalid`, role, productRole]);
      return { authenticated: true, source: "headers", workspaceId, userId, workspaceName: "SYNTHETIC", name: "SYNTHETIC", email: `${userId}@example.invalid`, role, productRole, permissions: [], productPermissions: [] };
    }
    const customer = await company(false), admin = await company(true);
    const booking = await requestAiBooking(customer, { requestId: randomUUID(), kind: "topup", itemId: "credits_5000", expectedCatalogVersion: AI_CATALOG_VERSION }, options);
    await t.test("runtime calls cannot activate, read operator data or write an audit receipt directly", async () => {
      await assert.rejects(withCrmRead(customer, tx => tx.query("select crm_ai_fulfill_booking($1::uuid,$2,$3,null::timestamptz)", [booking.id, "SYNTHETIC-BYPASS", "a".repeat(64)]), options), /permission denied/);
      await assert.rejects(withCrmRead(customer, tx => tx.query("select crm_ai_operator_requests(null::uuid,'pending')"), options), /permission denied/);
      await assert.rejects(withCrmRead(customer, tx => tx.execute("insert into ai_billing_admin_receipts(operator_workspace_id,actor_user_id,idempotency_key,request_hash,target_workspace_id,action,payload,response) values($1::uuid,$2::uuid,$3::uuid,$4,$1::uuid,'fulfill','{}'::jsonb,'{}'::jsonb)", [customer.workspaceId, customer.userId, randomUUID(), "a".repeat(64)]), options), /permission denied/);
      await assert.rejects(withCrmRead(customer, tx => tx.query("select crm_ai_admin_read($1::uuid,null::uuid,'pending')", [customer.workspaceId]), options), /AI_ADMIN_FORBIDDEN/);
      assert.equal((await readAiCreditSnapshot(customer, options)).availableCredits, 1000);
    });
    await t.test("the authorized admin bridge and customer read/reserve/settle still work", async () => {
      const pending = await readAdminAiBilling(admin, {}, options); assert.ok(pending.requests.some(row => row.id === booking.id));
      const action = { action: "fulfill" as const, requestId: booking.id, reference: "SYNTHETIC-ACL-CONFIRMATION", idempotencyKey: randomUUID() };
      assert.equal((await applyAdminAiBillingAction(admin, action, options)).status, "fulfilled");
      assert.equal((await applyAdminAiBillingAction(admin, action, options)).replayed, true);
      assert.equal((await readAiCreditSnapshot(customer, options)).availableCredits, 6000);
      const requestId = randomUUID(); await reserveAiCredits(customer, { requestId, operation: "chat", credits: 17 }, options);
      assert.equal((await readAiCreditSnapshot(customer, options)).reservedCredits, 17);
      await settleAiCredits(customer, { requestId, actualCredits: 4, status: "succeeded" }, options);
      const settled = await readAiCreditSnapshot(customer, options); assert.equal(settled.reservedCredits, 0); assert.equal(settled.availableCredits, 5996);
    });
  } finally { await db.stop(); }
});
