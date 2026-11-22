import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { WebsiteSalesDiscoveryCandidate, WebsiteSalesDiscoveryMatch, WebsiteSalesDiscoveryReceipt, WebsiteSalesDiscoveryRegister } from "../src/lib/website-sales-discovery";

type Client = { match(candidate: WebsiteSalesDiscoveryCandidate): Promise<WebsiteSalesDiscoveryMatch>;
  createRegistration(candidate: WebsiteSalesDiscoveryCandidate, match: WebsiteSalesDiscoveryMatch, decision: WebsiteSalesDiscoveryRegister["decision"], metadata: { idempotencyKey: string; correlationId: string }): WebsiteSalesDiscoveryRegister;
  register(command: WebsiteSalesDiscoveryRegister): Promise<WebsiteSalesDiscoveryReceipt>; reconcile(command: WebsiteSalesDiscoveryRegister): Promise<WebsiteSalesDiscoveryReceipt | null> };
test("actual Evelyn discovery/client → loopback HTTP → ordinary persisted session/CSRF → restricted PostgreSQL", { timeout: 240000 }, async t => {
  const source = process.env.EVELYN_WEBSITE_DISCOVERY_SOURCE;
  assert.ok(source && isAbsolute(source) && source.endsWith("website-sales-discovery-client.ts"), "Set the absolute actual Evelyn discovery client source");
  for (const name of ["VERCEL", "VERCEL_ENV", "VERCEL_URL"]) assert.equal(process.env[name], undefined, "Local synthetic acceptance only");
  const module = await import(pathToFileURL(source).href) as { WebsiteSalesDiscoveryClient: new (options: { origin: string; workspaceId: string; projectId: string; environment: "local"; transport(request: Request): Promise<Response> }) => Client };
  const directory = source.slice(0, source.lastIndexOf("/"));
  const discovery = await import(pathToFileURL(directory + "/website-sales-discovery.ts").href);
  const research = await import(pathToFileURL(directory + "/../external-research/service.ts").href);
  const db = await startLocalSalesDb();
  const envNames = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET"];
  const original = Object.fromEntries(envNames.map(name => [name, process.env[name]])); let server: Server | undefined;
  try {
    await applySalesSchema(db, { maxMigrationNumber: 90 });
    await db.admin.query("begin"); await db.admin.query(await readFile("migrations/202_website_sales_ireland.sql", "utf8")); await db.admin.query("commit");
    const actor = await seedSalesBrowser(db), projectId = randomUUID();
    await db.admin.query("insert into projects(id,workspace_id,name,type,division) values($1,$2,'Synthetic Discovery','Website','WEB_DESIGN')", [projectId, actor.workspaceId]);
    const cookie = "v2." + randomBytes(32).toString("base64url"), secret = randomBytes(48).toString("base64url");
    await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')",
      [randomUUID(), createHash("sha256").update(cookie).digest("hex"), actor.authIdentityId, actor.userId, actor.workspaceId]);
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_SESSION_SECRET: secret,
      NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    const route = await import("../src/app/api/crm/website-sales/discovery/route"); let origin = "";
    server = createServer(async (incoming, outgoing) => {
      try {
        const url = new URL(incoming.url ?? "/", origin); assert.equal(url.pathname, "/api/crm/website-sales/discovery");
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of incoming) { bytes += chunk.length; assert.ok(bytes <= 131072); chunks.push(Buffer.from(chunk)); }
        const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
        const response = await route.POST(new Request(url, { method: "POST", headers, body: Buffer.concat(chunks).toString("utf8") }));
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
      } catch { outgoing.writeHead(500, { "Content-Type": "application/json" }); outgoing.end('{"code":"LOCAL_RELAY_FAILURE"}'); }
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object"); origin = `http://127.0.0.1:${address.port}`; process.env.NOVALURE_APP_ORIGIN = origin;
    let loseNextResponse = false;
    const transport = async (request: Request) => {
      assert.equal(new URL(request.url).origin, origin);
      const operation = JSON.parse(await request.clone().text()).operation;
      const headers = new Headers(request.headers); headers.set("cookie", `novalure_session=${cookie}`); headers.set("origin", origin); headers.set("sec-fetch-site", "same-origin");
      const csrf = createCsrfToken({ method: "POST", pathname: "/api/crm/website-sales/discovery", secret, sessionCookie: cookie }); assert.ok(csrf); headers.set("x-novalure-csrf-token", csrf.token);
      const response = await fetch(new Request(request, { headers }));
      if (!response.ok) { const value = await response.clone().json() as { code?: string }; t.diagnostic(`LOCAL_HTTP_DENIAL ${response.status} ${value.code ?? "UNKNOWN"}`); }
      if (loseNextResponse && response.ok && operation === "register") { loseNextResponse = false; await response.arrayBuffer(); throw Error("Synthetic lost committed response"); }
      return response;
    };
    const client = () => new module.WebsiteSalesDiscoveryClient({ origin, workspaceId: actor.workspaceId, projectId, environment: "local", transport });
    const service = new research.ExternalResearchService({ fetcher: { async fetch(url: string) { return { requestedUrl: url, finalUrl: url, status: 200,
      headers: { "content-type": "text/html" }, body: "<p>Synthetic Café Company. 1 Test Street, Dublin, Ireland. Public Contact public@example.invalid. shared.example</p>" }; } } });
    const batch = await discovery.discoverWebsiteSalesCandidates({ workspaceId: actor.workspaceId, projectId, countryCode: "IE", region: "Dublin", industry: "Café", missionId: "synthetic-discovery-connected", seedUrls: ["https://public.example/company"] }, {
      research: service, extract: async (sources: { contentDigest: string; excerpt: string }[]) => ({ candidates: [{ companyName: "Synthetic Café Company", locationLabel: "1 Test Street, Dublin, Ireland", address: "1 Test Street, Dublin, Ireland", domain: "shared.example",
        bindings: [{ sourceDigest: sources[0]!.contentDigest, quote: sources[0]!.excerpt }], contacts: [{ name: "Public Contact", email: "public@example.invalid", phone: null, sourceDigest: sources[0]!.contentDigest, quote: sources[0]!.excerpt }] }] }) });
    assert.equal(batch.candidates.length, 1); const candidate = batch.candidates[0] as WebsiteSalesDiscoveryCandidate;
    let registration: WebsiteSalesDiscoveryRegister; let receipt: WebsiteSalesDiscoveryReceipt;
    const decision = (found: WebsiteSalesDiscoveryMatch): WebsiteSalesDiscoveryRegister["decision"] => ({ companyId: found.identity?.companyId ?? found.companies.find(company => company.reasons.includes("EXACT_NORMALIZED_NAME"))?.companyId ?? null,
      locationId: found.identity?.locationId ?? null, contactId: found.contactId, createCompany: !found.companies.some(company => company.reasons.includes("EXACT_NORMALIZED_NAME")), createContact: !found.contactId, reviewed: true, reason: "Actual reviewed synthetic public company and branch evidence" });
    const metadata = () => ({ idempotencyKey: randomUUID(), correlationId: randomUUID() });
    await t.test("source discovery hands a sourced candidate to real CRM registration", async () => {
      const runtime = client(), found = await runtime.match(candidate); assert.equal(found.status, "NEW"); registration = runtime.createRegistration(candidate, found, decision(found), metadata());
      receipt = await runtime.register(registration); assert.equal(receipt.identity.workspaceId, actor.workspaceId); assert.equal(receipt.canContact, false); assert.ok(receipt.contactId);
      const reloaded = await client().match(candidate); assert.equal(reloaded.status, "MATCH"); assert.equal(reloaded.identity?.companyId, receipt.identity.companyId);
    });
    await t.test("lost committed response reconciles using the exact original request without duplicate CRM rows", async () => {
      const found = await client().match(candidate); const originalCommand = client().createRegistration(candidate, found, { ...decision(found), createContact: false }, metadata());
      loseNextResponse = true; await assert.rejects(client().register(originalCommand), (error: unknown) => error instanceof Error && "outcome" in error && error.outcome === "UNKNOWN");
      const recovered = await client().reconcile(originalCommand); assert.ok(recovered); assert.equal(recovered.identity.locationId, receipt.identity.locationId);
      const rows = (await db.admin.query("select (select count(*)::int from organizations where project_id=$1) companies,(select count(*)::int from contacts where project_id=$1) contacts,(select count(*)::int from crm_company_locations where project_id=$1) locations", [projectId])).rows[0];
      assert.deepEqual(rows, { companies: 1, contacts: 1, locations: 1 });
    });
    await t.test("shared-domain branch stays separate; domain-only second company requires reviewed selection", async () => {
      const branch = structuredClone(candidate); branch.candidateId = randomUUID(); branch.address = branch.locationLabel = "2 Test Street, Cork, Ireland";
      branch.contacts = []; branch.sourceReferences[0]!.quote = "Synthetic Café Company. 2 Test Street, Cork, Ireland. shared.example";
      const found = await client().match(branch); assert.equal(found.status, "NEW"); const result = await client().register(client().createRegistration(branch, found, { ...decision(found), createContact: false }, metadata()));
      assert.equal(result.identity.companyId, receipt.identity.companyId); assert.notEqual(result.identity.locationId, receipt.identity.locationId);
      const different = structuredClone(branch); different.candidateId = randomUUID(); different.companyName = "Different Franchise"; different.sourceReferences[0]!.quote = "Different Franchise. 2 Test Street, Cork, Ireland. shared.example";
      assert.equal((await client().match(different)).status, "AMBIGUOUS");
    });
    await t.test("ordinary session requires CSRF and rejects a foreign project", async () => {
      const body = JSON.stringify({ contractVersion: "website-sales-discovery-v1", operation: "match", projectId, candidate });
      assert.equal((await fetch(origin + "/api/crm/website-sales/discovery", { method: "POST", headers: { "Content-Type": "application/json", cookie: `novalure_session=${cookie}`, origin }, body })).status, 403);
      const foreign = new module.WebsiteSalesDiscoveryClient({ origin, workspaceId: actor.workspaceId, projectId: randomUUID(), environment: "local", transport });
      await assert.rejects(foreign.match(candidate), /DISCOVERY_DENIED_403/);
    });
    t.diagnostic("ACTUAL_COMPANION_DISCOVERY_AND_CLIENT; REAL_LOCAL_HTTP_CSRF_PG; SYNTHETIC_SESSION_AND_PUBLIC_SOURCE; NO_LIVE_PROVIDER_OR_OUTBOUND");
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
    await closeLocalTestPool(); for (const name of envNames) { if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name]; } await db.stop();
  }
});
