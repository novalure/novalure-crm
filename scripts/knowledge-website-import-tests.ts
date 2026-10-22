import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withCrmRead, type TenantTransactionOptions } from "../src/lib/crm-command";
import { createKnowledgeArea, createKnowledgeSource, knowledgeInternals, updateKnowledgeSource } from "../src/lib/knowledge-center/repository";
import { executeKnowledgeWorkflow } from "../src/lib/knowledge-center/workflow";
import { createKnowledgeWebsiteImport, importInitialKnowledgeWebsite } from "../src/lib/knowledge-center/website-import";
import type { WebsiteScanPorts } from "../src/lib/knowledge-center/website-scanner";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const ids = { workspace: randomUUID(), foreignWorkspace: randomUUID(), owner: randomUUID(), foreignOwner: randomUUID(), reader: randomUUID() };
function actor(kind: "owner" | "foreignOwner" | "reader" = "owner"): AppSession {
  const role = kind === "reader" ? "assistant" : "owner";
  const productRole = kind === "reader" ? "assistant_backoffice" : "customer_owner";
  return { authenticated: true, userId: ids[kind], workspaceId: kind === "foreignOwner" ? ids.foreignWorkspace : ids.workspace,
    workspaceName: "SYNTHETIC website import", name: "SYNTHETIC", email: `${kind}@example.invalid`,
    role, permissions: getRolePermissions(role), productRole, productPermissions: getProductRoleCapabilities(productRole), source: "database" };
}
const code = (...values: string[]) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && values.includes(String(error.code)));
const html = "<!doctype html><html><head><title>Synthetic company</title></head><body><main><h1>SYNTHETIC company information</h1><p>Our synthetic consultation is arranged by email. This fixture contains no customer data.</p></main></body></html>";
function ports(body = html, onRequest?: () => Promise<void>, observed = { requests: 0 }): WebsiteScanPorts {
  return {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async ({ url, address, signal }) => {
      assert.equal(url.hostname, "synthetic-company.com");
      assert.equal(address.address, "93.184.216.34");
      assert.equal(signal.aborted, false);
      observed.requests += 1;
      await onRequest?.();
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(body) };
    },
  };
}

test("initial website import uses the real scoped engine without publishing or overwriting existing knowledge", { timeout: 180_000 }, async t => {
  const db = await startLocalSalesDb();
  const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]>, statementTimeoutMs: 5_000 };
  const owner = actor(), foreign = actor("foreignOwner"), reader = actor("reader");
  try {
    // Existing real CRM/RLS fixture, then only the Knowledge migrations needed
    // by source versions, review proposals and the unchanged scan engine.
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    const migrationOwner = `website_import_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await db.admin.query(`create role ${migrationOwner} nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication`);
    await db.admin.query(`grant usage,create on schema public to ${migrationOwner}`);
    await db.admin.query(`grant all on all tables in schema public to ${migrationOwner}`);
    for (const table of ["knowledge_sources", "knowledge_chunks", "projects", "bots", "media_assets", "media_asset_shares", "workspace_module_settings", "bot_conversations", "bot_messages", "bot_tool_calls", "crm_service_principals"]) {
      await db.admin.query(`alter table ${table} owner to ${migrationOwner}`);
    }
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      await client.query(`set local role ${migrationOwner}`);
      for (const name of ["101_knowledge_center.sql", "102_knowledge_document_processing.sql", "103_knowledge_assistant_service.sql", "104_knowledge_publication_workflow.sql", "105_knowledge_website_monitoring.sql", "108_knowledge_connected_assistant_quota.sql"]) {
        await client.query(await readFile(`migrations/${name}`, "utf8"));
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
    await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC import','managed_by_novalure'),($2,'SYNTHETIC foreign import','managed_by_novalure')", [ids.workspace, ids.foreignWorkspace]);
    for (const member of [owner, foreign, reader]) {
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC',$3,$4,$5,'active')", [member.userId, member.workspaceId, member.email, member.role, member.productRole]);
    }
    for (const workspace of [ids.workspace, ids.foreignWorkspace]) {
      await db.admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits)
        values($1,true,100,20000000,1000,'SYNTHETIC-LOCAL-IMPORT',
        '{"websiteImport":true,"monitoring":true,"advancedMaintenance":true}',
        '{"maxAreas":100,"maxWebsites":30,"maxScansPerMonth":100,"maxUsers":20,"maxAssistants":20}')`, [workspace]);
    }
    const area = await createKnowledgeArea(owner, { name: "SYNTHETIC import area", kind: "company" }, options);
    const foreignArea = await createKnowledgeArea(foreign, { name: "SYNTHETIC foreign area", kind: "company" }, options);
    const current = (sourceId: string) => withCrmRead(owner, (tx, fresh) => knowledgeInternals.source(tx, fresh, sourceId, true), options);
    const scans = async () => Number((await db.admin.query("select count(*) from knowledge_website_scan_runs where workspace_id=$1", [ids.workspace])).rows[0].count);
    const sourceCount = async () => Number((await db.admin.query("select count(*) from knowledge_sources where workspace_id=$1", [ids.workspace])).rows[0].count);
    const empty = (name: string) => createKnowledgeSource(owner, { areaId: area.id, type: "url", name, url: "https://synthetic-company.com/knowledge" }, options);

    await t.test("first import fills a new private draft, consumes exactly one scan and preserves its empty origin", async () => {
      const baseline = await scans();
      const widerUntrustedInput = {
        areaId: area.id, name: "SYNTHETIC successful import", url: "https://synthetic-company.com/knowledge",
        content: "SYNTHETIC visitor-supplied content must not pretend to be the website import",
        structuredData: { approved: true },
      };
      const result = await createKnowledgeWebsiteImport(owner, widerUntrustedInput, { ...options, scanPorts: ports() });
      assert.equal(result.websiteImport.status, "ready");
      assert.match(result.source.version!.content, /SYNTHETIC company information/u);
      assert.equal(result.source.version!.version, 2);
      assert.equal(result.source.revision, 2);
      assert.equal(result.source.approvedVersionId, null);
      assert.equal(result.source.version!.status, "draft");
      assert.equal(await scans(), baseline + 1);
      assert.equal(Number((await db.admin.query("select scan_count from knowledge_query_usage where workspace_id=$1", [ids.workspace])).rows[0].scan_count), 1);
      assert.deepEqual(result.source.version!.structuredData, {});
      assert.doesNotMatch(result.source.version!.content, /visitor-supplied/u);
      const versions = (await db.admin.query("select version,content,status from knowledge_source_versions where source_id=$1 order by version", [result.source.id])).rows;
      assert.equal(versions.length, 2); assert.equal(versions[0].content, "");
      assert.equal(versions[1].status, "draft");
      assert.equal(Number((await db.admin.query("select count(*) from knowledge_chunks where source_id=$1", [result.source.id])).rows[0].count), 0);
      assert.equal(Number((await db.admin.query("select count(*) from knowledge_publication_workflows where source_id=$1", [result.source.id])).rows[0].count), 0);
      const proposal = (await db.admin.query("select status,accepted_version_id,evidence->>'runId' as run from knowledge_change_proposals where source_id=$1", [result.source.id])).rows[0];
      assert.equal(proposal.status, "accepted"); assert.equal(proposal.accepted_version_id, result.source.draftVersionId); assert.ok(proposal.run);
    });

    await t.test("failed scan keeps its exact URL source and explicit retry fills that same source", async () => {
      const baseline = await sourceCount();
      const failed = await createKnowledgeWebsiteImport(owner, { areaId: area.id, name: "SYNTHETIC retry import", url: "https://synthetic-company.com/knowledge" }, { ...options, scanPorts: ports("<html><body></body></html>") });
      assert.equal(failed.websiteImport.status, "scan_failed");
      assert.equal(failed.websiteImport.errorCode, "website_content_empty");
      assert.equal(failed.source.version!.content, "");
      assert.equal(await sourceCount(), baseline + 1);
      const retried = await importInitialKnowledgeWebsite(owner, { sourceId: failed.source.id, expectedVersion: 1 }, { ...options, scanPorts: ports() });
      assert.equal(retried.websiteImport.status, "ready");
      assert.equal(retried.source.id, failed.source.id);
      assert.equal(await sourceCount(), baseline + 1);
    });

    await t.test("nonempty drafts and published versions are never fetched or overwritten by initial import", async () => {
      const draft = await createKnowledgeSource(owner, { areaId: area.id, type: "url", name: "SYNTHETIC existing draft", url: "https://synthetic-company.com/knowledge", content: "SYNTHETIC existing human draft" }, options);
      const baseline = await scans(), observed = { requests: 0 };
      const untouched = await importInitialKnowledgeWebsite(owner, { sourceId: draft.id, expectedVersion: draft.revision }, { ...options, scanPorts: ports(html, undefined, observed) });
      assert.equal(untouched.websiteImport.status, "changes_pending");
      assert.equal(untouched.source.version!.content, draft.version!.content);
      for (const action of ["submit", "review", "approve", "publish"] as const) {
        const source = await current(draft.id);
        await executeKnowledgeWorkflow(owner, { action, sourceId: source.id, versionId: source.draftVersionId!, expectedVersion: source.revision, reason: "SYNTHETIC normal review and publication fixture" }, options);
      }
      const published = await current(draft.id);
      assert.ok(published.approvedVersionId);
      const result = await importInitialKnowledgeWebsite(owner, { sourceId: draft.id, expectedVersion: published.revision }, { ...options, scanPorts: ports(html, undefined, observed) });
      assert.equal(result.websiteImport.status, "changes_pending");
      assert.equal(result.source.approvedVersionId, published.approvedVersionId);
      assert.equal(result.source.version!.content, draft.version!.content);
      assert.equal(await scans(), baseline); assert.equal(observed.requests, 0);
    });

    await t.test("concurrent human edits are preserved and the fetched website is not applied", async () => {
      const source = await empty("SYNTHETIC concurrent edit");
      const result = await importInitialKnowledgeWebsite(owner, { sourceId: source.id, expectedVersion: 1 }, { ...options, scanPorts: ports(html, async () => {
        // The network port runs after reservation COMMIT, so another real
        // tenant transaction can acquire the lock and create a human draft.
        await updateKnowledgeSource(owner, { sourceId: source.id, expectedVersion: 1, content: "SYNTHETIC concurrent human content" }, options);
      }) });
      assert.equal(result.websiteImport.status, "stale");
      assert.equal(result.source.version!.content, "SYNTHETIC concurrent human content");
      assert.equal(result.source.version!.version, 2);
      assert.equal(Number((await db.admin.query("select count(*) from knowledge_change_proposals where source_id=$1", [source.id])).rows[0].count), 0);
    });

    await t.test("a normal concurrent proposal edit cannot be automatically accepted as fetched website content", async () => {
      const source = await empty("SYNTHETIC concurrent proposal edit");
      let edited = false;
      // Intercept the real scanner finish COMMIT, then use the normal workflow
      // from a separate connection before the import's final acceptance opens.
      // No test hook or alternative write path exists in production code.
      const racingPool = {
        async connect() {
          const client = await db.pool.connect();
          const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          return new Proxy(client, {
            get(target, property) {
              if (property === "query") return async (...args: unknown[]) => {
                const result = await query(...args);
                if (!edited && typeof args[0] === "string" && /^\s*commit\s*;?\s*$/iu.test(args[0])) {
                  const row = (await db.admin.query(`select p.id,p.revision from knowledge_change_proposals p
                    join knowledge_website_scan_runs r on r.proposal_id=p.id
                    where p.source_id=$1 and p.status='open' and r.status='changed'`, [source.id])).rows[0];
                  if (row) {
                    edited = true;
                    await executeKnowledgeWorkflow(owner, {
                      action: "proposal-edit", proposalId: row.id, proposalRevision: row.revision,
                      reason: "SYNTHETIC concurrent normal proposal edit after completed scan",
                      changes: { content: "SYNTHETIC separately edited proposal, not the fetched website", structuredData: { syntheticHumanEdit: true } },
                    }, options);
                  }
                }
                return result;
              };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      };
      const result = await importInitialKnowledgeWebsite(owner, { sourceId: source.id, expectedVersion: 1 }, {
        ...options, pool: racingPool as unknown as NonNullable<TenantTransactionOptions["pool"]>, scanPorts: ports(),
      });
      assert.equal(edited, true);
      assert.equal(result.websiteImport.status, "stale");
      assert.equal(result.websiteImport.errorCode, "STALE_PROPOSAL");
      assert.equal(result.source.version!.version, 1); assert.equal(result.source.version!.content, "");
      assert.deepEqual(result.source.version!.structuredData, {}); assert.equal(result.source.approvedVersionId, null);
      const proposal = (await db.admin.query("select status,revision,changes,accepted_version_id from knowledge_change_proposals where source_id=$1", [source.id])).rows[0];
      assert.equal(proposal.status, "open"); assert.equal(proposal.revision, 2); assert.equal(proposal.accepted_version_id, null);
      assert.match(proposal.changes.content, /separately edited/u); assert.deepEqual(proposal.changes.structuredData, { syntheticHumanEdit: true });
      assert.equal(Number((await db.admin.query("select count(*) from knowledge_source_versions where source_id=$1", [source.id])).rows[0].count), 1);
    });

    await t.test("a concurrent second import is busy without a duplicate scan or version", async () => {
      const source = await empty("SYNTHETIC single active scan");
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const baseline = await scans();
      const first = importInitialKnowledgeWebsite(owner, { sourceId: source.id, expectedVersion: 1 }, { ...options, scanPorts: ports(html, async () => { entered(); await gate; }) });
      try {
        await started;
        const busy = await importInitialKnowledgeWebsite(owner, { sourceId: source.id, expectedVersion: 1 }, { ...options, scanPorts: ports() });
        assert.equal(busy.websiteImport.status, "busy");
        assert.equal(await scans(), baseline + 1);
      } finally { release(); }
      assert.equal((await first).websiteImport.status, "ready");
      assert.equal((await current(source.id)).version!.version, 2);
    });

    await t.test("foreign sources and read-only actors cannot trigger a fetch or any scan reservation", async () => {
      const other = await createKnowledgeSource(foreign, { areaId: foreignArea.id, type: "url", name: "SYNTHETIC foreign URL", url: "https://synthetic-company.com/knowledge" }, options);
      const own = await empty("SYNTHETIC reader URL"), baseline = await scans(), observed = { requests: 0 };
      const opts = { ...options, scanPorts: ports(html, undefined, observed) };
      await assert.rejects(importInitialKnowledgeWebsite(owner, { sourceId: other.id, expectedVersion: 1 }, opts), code("NOT_FOUND", "FORBIDDEN"));
      await assert.rejects(importInitialKnowledgeWebsite(reader, { sourceId: own.id, expectedVersion: 1 }, opts), code("FORBIDDEN"));
      assert.equal(observed.requests, 0); assert.equal(await scans(), baseline);
    });

    await t.test("private DNS destinations are denied by the unchanged scanner with a persisted partial result", async () => {
      let requests = 0;
      const unsafe: WebsiteScanPorts = { resolve: async () => [{ address: "10.0.0.7", family: 4 }], request: async () => { requests += 1; throw Error("must never connect"); } };
      const result = await createKnowledgeWebsiteImport(owner, { areaId: area.id, name: "SYNTHETIC denied private DNS", url: "https://synthetic-company.com/knowledge" }, { ...options, scanPorts: unsafe });
      assert.equal(result.websiteImport.status, "scan_failed");
      assert.equal(result.websiteImport.errorCode, "website_address_denied");
      assert.equal(result.source.version!.version, 1); assert.equal(result.source.version!.content, ""); assert.equal(requests, 0);
    });

    await t.test("no caller may keep an outer tenant transaction open across website network work", async () => {
      const source = await empty("SYNTHETIC nested import rejected"), baseline = await scans();
      await assert.rejects(withCrmRead(owner, () => importInitialKnowledgeWebsite(owner, { sourceId: source.id, expectedVersion: 1 }, { ...options, scanPorts: ports() }), options), code("VALIDATION_ERROR"));
      assert.equal(await scans(), baseline);
    });
  } finally {
    await db.stop();
    await rm(db.directory, { recursive: true, force: true });
  }
});
