import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import * as client from "../src/lib/website-sales-workbench-client";
import { qualifyWebsiteProspect } from "../src/lib/website-prospect";

const originalFetch = globalThis.fetch, originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const storage = new Map<string, string>();
const sessionStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://crm.example", href: "https://crm.example/" }, sessionStorage } });
after(() => { globalThis.fetch = originalFetch; if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); });

function fixture() {
  const workspaceId = randomUUID(), actorId = randomUUID(), projectId = randomUUID(), companyId = randomUUID();
  const command: client.WebsiteSalesBrowserCommand = { operation: "register_location", projectId, companyId,
    payload: { countryCode: "IE", address: "1 Synthetic Street, Dublin, Ireland", sourceUrl: "https://company.example/about", sourceReference: "Synthetic location source" } };
  const location = { id: randomUUID(), workspaceId, projectId, companyId, version: 1, countryCode: "IE" };
  return { workspaceId, actorId, command, location };
}
function mockTransport(operation: (body: Record<string, unknown>, request: Request) => Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "https://crm.example");
    if (url.pathname === "/api/auth/csrf") return Response.json({ csrfToken: "synthetic-one-time-csrf" });
    assert.equal(url.origin, "https://crm.example");
    assert.equal(url.pathname, "/api/crm/website-sales");
    const request = new Request(input, init);
    return operation(await request.json() as Record<string, unknown>, request);
  }) as typeof fetch;
}
function receipt(body: Record<string, unknown>, location: unknown) {
  return Response.json({ contractVersion: "website-sales-ireland-v1", persisted: true, correlationId: body.correlationId,
    commandId: randomUUID(), auditReference: randomUUID(), replayed: false, data: { location } });
}

test("a lost committed response survives a fresh module and reconciles only the exact saved body and key", async () => {
  const f = fixture(); let lostBody = "";
  mockTransport(async body => { lostBody = JSON.stringify(body); throw new Error("synthetic lost committed response"); });
  await assert.rejects(client.commandWebsiteSalesWorkbench(f.workspaceId, f.actorId, f.command), (error: unknown) => error instanceof client.WebsiteSalesBrowserError && error.outcome === "UNKNOWN");
  const saved = client.websiteSalesPending(f.workspaceId, f.actorId)!;
  assert.equal(saved.state, "UNKNOWN"); assert.equal(saved.currentRead, false);
  assert.equal(storage.size > 0, true); assert.equal(saved.body, lostBody);
  const source = new URL("../src/lib/website-sales-workbench-client.ts", import.meta.url).href;
  const fresh = await import(`${source}?fresh=${randomUUID()}`) as typeof client;
  assert.notEqual(fresh.websiteSalesPending, client.websiteSalesPending, "A genuinely fresh module must rehydrate the durable recovery record");
  const restored = fresh.websiteSalesPending(f.workspaceId, f.actorId)!;
  assert.equal(restored.body, saved.body); assert.equal(restored.idempotencyKey, saved.idempotencyKey); assert.equal(restored.currentRead, false);
  await assert.rejects(fresh.commandWebsiteSalesWorkbench(f.workspaceId, f.actorId, f.command, true));
  fresh.websiteSalesMarkCurrentRead(f.workspaceId, f.actorId, f.command, restored);
  mockTransport(async (body, request) => { assert.equal(JSON.stringify(body), saved.body); assert.equal(request.headers.get("idempotency-key"), saved.idempotencyKey); return receipt(body, f.location); });
  await fresh.commandWebsiteSalesWorkbench(f.workspaceId, f.actorId, f.command, true);
  assert.equal(fresh.websiteSalesPending(f.workspaceId, f.actorId), null);
  assert.equal(sessionStorage.getItem(`novalure.website-sales.pending.v1:${f.actorId}:${f.workspaceId}`), null);
});

test("a late read for the preceding action cannot unlock a later uncertain action at the same company", async () => {
  const f = fixture(); mockTransport(async () => { throw new Error("lost"); });
  await assert.rejects(client.commandWebsiteSalesWorkbench(f.workspaceId, f.actorId, f.command));
  const first = client.websiteSalesPending(f.workspaceId, f.actorId)!;
  client.websiteSalesMarkCurrentRead(f.workspaceId, f.actorId, f.command, first);
  mockTransport(async body => receipt(body, f.location));
  await client.commandWebsiteSalesWorkbench(f.workspaceId, f.actorId, f.command, true);
  mockTransport(async () => { throw new Error("next lost"); });
  await assert.rejects(client.commandWebsiteSalesWorkbench(f.workspaceId, f.actorId, { ...f.command, payload: { ...f.command.payload, address: "2 Synthetic Street, Dublin, Ireland" } }));
  client.websiteSalesMarkCurrentRead(f.workspaceId, f.actorId, f.command, first);
  assert.equal(client.websiteSalesPending(f.workspaceId, f.actorId)?.currentRead, false);
});

test("reconciliation denial preserves original UNKNOWN metadata and another actor cannot see it", async () => {
  const f = fixture(); mockTransport(async () => { throw new Error("lost"); });
  await assert.rejects(client.commandWebsiteSalesWorkbench(f.workspaceId, f.actorId, f.command));
  const saved = client.websiteSalesPending(f.workspaceId, f.actorId)!;
  assert.equal(client.websiteSalesPending(f.workspaceId, randomUUID()), null);
  client.websiteSalesMarkCurrentRead(f.workspaceId, f.actorId, f.command, saved);
  mockTransport(async () => new Response(null, { status: 403 }));
  await assert.rejects(client.commandWebsiteSalesWorkbench(f.workspaceId, f.actorId, f.command, true));
  const retained = client.websiteSalesPending(f.workspaceId, f.actorId)!;
  assert.equal(retained.state, "UNKNOWN"); assert.equal(retained.body, saved.body); assert.equal(retained.idempotencyKey, saved.idempotencyKey);
});

test("malformed location acknowledgement stays UNKNOWN instead of permitting another write", async () => {
  const f = fixture(); mockTransport(async body => receipt(body, { ...f.location, id: undefined }));
  await assert.rejects(client.commandWebsiteSalesWorkbench(f.workspaceId, f.actorId, f.command));
  assert.equal(client.websiteSalesPending(f.workspaceId, f.actorId)?.state, "UNKNOWN");
  let calls = 0; mockTransport(async body => { calls++; return receipt(body, f.location); });
  await assert.rejects(client.commandWebsiteSalesWorkbench(f.workspaceId, f.actorId, f.command)); assert.equal(calls, 0);
});

test("invalid stored recovery is blocked and storage failure prevents dispatch", async () => {
  const f = fixture(), key = `novalure.website-sales.pending.v1:${f.actorId}:${f.workspaceId}`;
  storage.set(key, "{invalid");
  assert.equal(client.websiteSalesPending(f.workspaceId, f.actorId)?.recoveryError, true);
  let calls = 0; mockTransport(async body => { calls++; return receipt(body, f.location); });
  await assert.rejects(client.commandWebsiteSalesWorkbench(f.workspaceId, f.actorId, f.command)); assert.equal(calls, 0);
  const other = fixture(), set = sessionStorage.setItem;
  sessionStorage.setItem = () => { throw new Error("unavailable"); };
  try { await assert.rejects(client.commandWebsiteSalesWorkbench(other.workspaceId, other.actorId, other.command)); assert.equal(calls, 0); }
  finally { sessionStorage.setItem = set; }
});

test("workflow acknowledgements require exact scope, explicit false contact permission and current hash/version shapes", async () => {
  for (const patch of [{ canContact: undefined }, { evidenceDigest: "invalid" }, { locationVersion: 0 }, { locationId: randomUUID() }]) {
    const f = fixture(), locationId = randomUUID();
    const command: client.WebsiteSalesBrowserCommand = { operation: "stop", projectId: f.command.projectId, companyId: f.command.companyId,
      locationId, expectedVersion: 1, payload: { reason: "NO_FIT", sourceReference: "Synthetic stop reference" } };
    mockTransport(async body => Response.json({ contractVersion: "website-sales-ireland-v1", persisted: true,
      correlationId: body.correlationId, commandId: randomUUID(), auditReference: randomUUID(), replayed: false, data: { workflow: {
        id: randomUUID(), workspaceId: f.workspaceId, projectId: command.projectId, companyId: command.companyId, locationId,
        version: 2, locationVersion: 1, status: "STOPPED", evidenceDigest: "a".repeat(64), canContact: false, ...patch,
      } } }));
    await assert.rejects(client.commandWebsiteSalesWorkbench(f.workspaceId, f.actorId, command));
    assert.equal(client.websiteSalesPending(f.workspaceId, f.actorId)?.state, "UNKNOWN");
  }
});

test("a detail response from another location is never displayed in the selected scope", async () => {
  const f = fixture(), locationId = randomUUID();
  globalThis.fetch = (async () => Response.json({ contractVersion: "website-sales-workbench-v1", source: "database", workspaceId: f.workspaceId,
    projectId: f.command.projectId, companyId: f.command.companyId, view: "detail", canWrite: true, canContact: false,
    location: { ...f.location, sourceUrl: "https://company.example" }, workflow: null, contact: null, observation: null })) as typeof fetch;
  await assert.rejects(client.readWebsiteSalesWorkbench(f.workspaceId, { view: "detail", projectId: f.command.projectId, companyId: f.command.companyId, locationId }, new AbortController().signal),
    (error: unknown) => error instanceof client.WebsiteSalesBrowserError && error.outcome === "DENIED");
});

test("browser receipt binding matches actual server normalization for uppercase identity/domain and whitespace facts", async () => {
  const f = fixture(), locationId = randomUUID();
  const identity = { workspaceId: f.workspaceId.toUpperCase(), projectId: f.command.projectId.toUpperCase(), companyId: f.command.companyId.toUpperCase(), locationId: locationId.toUpperCase() };
  const now = new Date().toISOString(), end = new Date(Date.now() + 3_600_000).toISOString();
  const prospect = { identity, country: "IRELAND", identityStatus: "VERIFIED", domain: " EXAMPLE.IE ", path: "WEBSITE_OBSTACLE", ownWebsiteSearch: "FOUND",
    obstacle: "CONFIRMED_REPRODUCIBLE", platformUrl: null, bookingRoute: "UNKNOWN", need: "EVIDENCED",
    evidence: ["IDENTITY", "OWN_WEBSITE_SEARCH", "OBSTACLE", "BUSINESS_NEED"].map(kind => ({ evidenceId: ` fact-${kind} `, identity, kind,
      sourceUrl: "https://company.example/source", observedAt: now, validUntil: end, finding: " Scoped synthetic finding ", validityCondition: " Company and location unchanged ", confidence: 0.9 })) };
  const assessed = qualifyWebsiteProspect(prospect, now);
  mockTransport(async body => Response.json({ contractVersion: "website-sales-ireland-v1", persisted: true, correlationId: body.correlationId,
    commandId: randomUUID(), auditReference: randomUUID(), replayed: false, data: { workflow: { ...assessed.identity, id: randomUUID(),
      version: 1, locationVersion: 1, status: "OBSERVED", evidenceDigest: assessed.evidenceDigest, canContact: false } } }));
  await client.commandWebsiteSalesWorkbench(f.workspaceId, f.actorId, { operation: "observe", projectId: f.command.projectId, companyId: f.command.companyId,
    locationId, locationVersion: 1, payload: { prospect } });
  assert.equal(client.websiteSalesPending(f.workspaceId, f.actorId), null);
});
