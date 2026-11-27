import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withCrmRead } from "../src/lib/crm-command";
import { generateModelReply } from "../src/lib/integrations/model-provider";
import { readAiCreditSnapshot, reserveAiCredits, settleAiCredits } from "../src/lib/ai-billing/repository";
import { AI_DEFAULT_MODEL, AI_MAX_OUTPUT_TOKENS, aiCreditsForTokens, readProviderTokenUsage, reserveForMessages, resolveMeteredModel } from "../src/lib/ai-billing/metering";

test("metering bounds Unicode input, model prices and billed reasoning tokens", () => {
  assert.equal(resolveMeteredModel(), AI_DEFAULT_MODEL);
  assert.throws(() => resolveMeteredModel("provider/unpriced"), /NOT_ALLOWED/);
  assert.equal(aiCreditsForTokens("openai/gpt-5.4", 4_000, 1_000), 28);
  assert.equal(aiCreditsForTokens(AI_DEFAULT_MODEL, 4_000, 1_000), 9);
  assert.throws(() => aiCreditsForTokens(AI_DEFAULT_MODEL, NaN, 10));
  assert.throws(() => reserveForMessages(AI_DEFAULT_MODEL, [{ role: "user", content: "🙂".repeat(17_000) }]), /TOO_LARGE/);
  const bound = reserveForMessages(AI_DEFAULT_MODEL, [{ role: "user", content: "🙂" }]);
  assert.ok(bound.inputTokenBound > 4);
  assert.deepEqual(readProviderTokenUsage({ prompt_tokens: 20, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } }, 100, 100), { inputTokens: 20, outputTokens: 40 });
  assert.equal(readProviderTokenUsage({ prompt_tokens: 101, completion_tokens: 1 }, 100, 100), null);
});

test("provider calls commit credit reservations before network access and settle only confirmed usage", { timeout: 180_000 }, async (t) => {
  const db = await startLocalSalesDb();
  const names = ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY", "NOVALURE_LLM_BASE_URL", "NOVALURE_LLM_API_KEY", "NOVALURE_LLM_MODEL"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    await db.admin.query(await readFile("migrations/146_ai_credit_billing.sql", "utf8"));
    const workspaceId = randomUUID(), userId = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC metered AI','self_service_customer')", [workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC owner',$3,'owner','customer_owner','active')", [userId, workspaceId, `ai-${userId}@example.invalid`]);
    const session = { authenticated: true, workspaceId, userId, workspaceName: "Synthetic AI", email: "ai@example.invalid", name: "Synthetic", role: "owner", productRole: "customer_owner", source: "database", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner") } as AppSession;
    const options = { pool: db.pool as unknown as TenantPool };
    const input = () => ({ session, requestId: randomUUID(), system: "Approved synthetic assistant", prompt: "Synthetic request", language: "de" });
    for (const name of names) delete process.env[name];
    Object.assign(process.env, { NOVALURE_LLM_BASE_URL: "https://synthetic-ai.invalid/v1", NOVALURE_LLM_API_KEY: "SYNTHETIC_NON_SECRET" });
    let networkCalls = 0;
    globalThis.fetch = async (_url, init) => {
      networkCalls++;
      const id = new Headers(init?.headers).get("x-client-request-id");
      const saved = (await db.admin.query("select status,reserved_credits from ai_credit_reservations where workspace_id=$1 and request_id=$2", [workspaceId, id])).rows[0];
      assert.equal(saved.status, "reserved", "reservation must be visible from a separate connection before fetch");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_completion_tokens, AI_MAX_OUTPUT_TOKENS);
      assert.equal(body.model, AI_DEFAULT_MODEL);
      return Response.json({ choices: [{ message: { content: "Approved synthetic answer" } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    };
    await t.test("successful call spends actual credits, refunds its bound and survives outer rollback", async () => {
      const request = input();
      const before = await readAiCreditSnapshot(session, options);
      await assert.rejects(withCrmRead(session, async () => {
        const result = await generateModelReply(request, options);
        assert.equal(result.external, true); assert.equal(result.metering?.status, "settled");
        throw new Error("SYNTHETIC outer rollback");
      }, options), /outer rollback/);
      const after = await readAiCreditSnapshot(session, options);
      assert.equal(after.availableCredits, before.availableCredits - 1);
      assert.equal(after.reservedCredits, 0);
      const calls = networkCalls;
      const replay = await generateModelReply(request, options);
      assert.equal(networkCalls, calls); assert.equal(replay.external, false);
    });
    await t.test("preview identities and unknown models cannot call a provider", async () => {
      const before = networkCalls;
      assert.equal((await generateModelReply({ ...input(), session: { ...session, source: "headers" } }, options)).reason, "AI_BILLING_AUTH_REQUIRED");
      assert.equal((await generateModelReply({ ...input(), model: "provider/unpriced" }, options)).reason, "AI_MODEL_NOT_ALLOWED");
      assert.equal(networkCalls, before);
    });
    await t.test("unknown usage and network outcomes retain a hold without spending or free retry", async () => {
      globalThis.fetch = async () => { networkCalls++; throw new Error("SYNTHETIC timeout"); };
      const request = input(), before = await readAiCreditSnapshot(session, options);
      const reply = await generateModelReply(request, options);
      assert.equal(reply.metering?.status, "reserved");
      const after = await readAiCreditSnapshot(session, options);
      assert.ok(after.reservedCredits > before.reservedCredits);
      assert.equal(after.usedCredits, before.usedCredits);
      const calls = networkCalls; await generateModelReply(request, options); assert.equal(networkCalls, calls);
      await settleAiCredits(session, { requestId: request.requestId, actualCredits: 0, status: "failed" }, options);
      globalThis.fetch = async () => Response.json({ choices: [{ message: { content: "No verified usage" } }] });
      const missing = input(), pending = await generateModelReply(missing, options);
      assert.equal(pending.reason, "AI_USAGE_PENDING_REVIEW"); assert.equal(pending.metering?.status, "reserved");
      await settleAiCredits(session, { requestId: missing.requestId, actualCredits: 0, status: "failed" }, options);
    });
    await t.test("confirmed provider rejection refunds and exhausted quotas prevent network calls", async () => {
      globalThis.fetch = async () => new Response("SYNTHETIC rejected", { status: 429 });
      const before = await readAiCreditSnapshot(session, options), rejected = await generateModelReply(input(), options);
      assert.equal(rejected.metering?.status, "settled"); assert.equal(rejected.metering.chargedCredits, 0);
      assert.equal((await readAiCreditSnapshot(session, options)).availableCredits, before.availableCredits);
      const id = randomUUID();
      await reserveAiCredits(session, { requestId: id, operation: "synthetic.exhaust", credits: before.availableCredits }, options);
      globalThis.fetch = async () => { throw new Error("network must not be called"); };
      assert.equal((await generateModelReply(input(), options)).reason, "AI_CREDITS_EXHAUSTED");
      await settleAiCredits(session, { requestId: id, actualCredits: 0, status: "failed" }, options);
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    await db.stop();
  }
});
