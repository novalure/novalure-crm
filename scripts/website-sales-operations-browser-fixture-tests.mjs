import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { seedWebsiteSalesWorkbenchBrowser } from "./lib/website-sales-workbench-browser-fixture.mjs";
import { seedWebsiteSalesStudioBrowser } from "./lib/website-sales-studio-browser-fixture.mjs";

test("operations browser fixture applies exact202–207 on the preserved disposable application baseline without live grants", { timeout: 180_000 }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(input instanceof Request ? input.url : String(input)).hostname, "127.0.0.1", "Non-loopback fetch forbidden in synthetic fixture test");
    return originalFetch(input, init);
  };
  let db;
  try {
    db = await startDesignCIntegrationDatabase({ accountLanguagePreference: true, bookingSetup: true, currentApplicationSchema: true });
    const originalLedger = (await db.admin.query("select version,name,checksum from novalure_schema_migrations order by version")).rows;
    assert.equal(originalLedger.length, 124, "The historical Design C application baseline stays intact");
    const account = await seedSalesBrowser(db);
    Object.assign(account, await seedWebsiteSalesWorkbenchBrowser(db, account));
    const { websiteStudio } = await seedWebsiteSalesStudioBrowser(db, account, { operations: true });
    assert.equal(websiteStudio.lifecycle, true, "Operations implies lifecycle prerequisites");
    assert.equal(websiteStudio.operations, true);
    assert.equal(websiteStudio.syntheticOnly, true);
    assert.equal(websiteStudio.applied.length, 5);
    const extension = JSON.parse(await readFile("config/crm-candidate-fresh-website-sales-extension.json", "utf8"));
    const ledger = (await db.admin.query("select version,name,checksum from novalure_schema_migrations order by version")).rows;
    const expected = extension.forward.map(row => ({ version: row.path.split("/").at(-1).slice(0, -4), checksum: row.sha256 }));
    assert.equal(ledger.length, originalLedger.length + 6);
    assert.deepEqual(ledger.filter(row => Number(row.version.slice(0, 3)) < 202), originalLedger);
    assert.deepEqual(ledger.filter(row => Number(row.version.slice(0, 3)) >= 202).map(({ version, checksum }) => ({ version, checksum })), expected);
    for (const relation of ["crm_website_sales_ops_allocations", "crm_website_sales_ops_quotes", "crm_website_sales_ops_financial_sources", "crm_website_sales_ops_outcomes", "crm_website_sales_ops_improvements", "crm_website_sales_topic_permissions", "crm_website_sales_conversations", "crm_website_sales_conversation_turns"]) {
      const posture = (await db.admin.query("select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass", [`public.${relation}`])).rows[0];
      assert.deepEqual(posture, { relrowsecurity: true, relforcerowsecurity: true }, relation);
      assert.equal((await db.pool.query(`select count(*)::int n from ${relation}`)).rows[0].n, 0, "Unscoped restricted runtime sees no business rows");
    }
    for (const relation of ["crm_website_sales_machine_workloads", "crm_website_sales_machine_grants", "crm_website_sales_topic_permissions", "crm_website_sales_ops_policies", "crm_website_sales_ops_allocations"]) {
      assert.equal((await db.admin.query(`select count(*)::int n from ${relation}`)).rows[0].n, 0, "Fixture creates no active business authority");
    }
    const version = "206_website_sales_operations", checksum = expected.find(row => row.version === version).checksum;
    await db.admin.query("update novalure_schema_migrations set checksum=$2 where version=$1", [version, "a".repeat(64)]);
    try {
      await assert.rejects(seedWebsiteSalesStudioBrowser(db, account, { operations: true }), /Existing 206_website_sales_operations must match its original source/);
    } finally {
      await db.admin.query("update novalure_schema_migrations set checksum=$2 where version=$1", [version, checksum]);
    }
    assert.equal((await db.admin.query("select count(*)::int n from novalure_schema_migrations")).rows[0].n, ledger.length);
  } finally {
    await db?.stop();
    globalThis.fetch = originalFetch;
  }
});
