import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import * as client from "../src/lib/website-sales-operations-client";
import { websiteSalesConversationContract, type SalesConversationCommand } from "../src/lib/website-sales-conversation-types";
import { websiteSalesOperationsContract, type SalesOperationsCommand } from "../src/lib/website-sales-operations-types";
import { formatSalesMinor, formatSalesPercent, parseSalesHundredths, salesHundredthsInput } from "../src/lib/website-sales-operations-format";

const originalFetch = globalThis.fetch, originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), originalTimeout = globalThis.setTimeout;
const saved = new Map<string, string>(), storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); } };
Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://crm.example", href: "https://crm.example/" }, sessionStorage: storage } });
after(() => { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); });
function fixture() {
  const workspaceId = randomUUID(), actorId = randomUUID(), scope = { projectId: randomUUID(), companyId: randomUUID(), locationId: randomUUID() };
  const command: SalesConversationCommand = { contractVersion: websiteSalesConversationContract, operation: "advance_conversation", ...scope, expectedConversationVersion: 2, expectedWorkflowVersion: 3, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { canonicalMessageId: randomUUID(), language: "en" } };
  const workflow = { ...scope, workspaceId, id: randomUUID(), version: 4, evidenceDigest: "a".repeat(64), canContact: false };
  const effect = { workflow, conversation: { id: randomUUID(), version: 3, factsDigest: "b".repeat(64) }, topicTurnId: String(randomUUID()), draftTurnId: String(randomUUID()), canContact: false };
  const receipt = { contractVersion: websiteSalesConversationContract, persisted: true, correlationId: command.correlationId, commandId: randomUUID(), auditReference: randomUUID(), replayed: false, data: effect };
  return { workspaceId, actorId, scope, command, receipt };
}
function mock(run: (request: Request, body: Record<string, unknown>) => Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { const url = new URL(input instanceof Request ? input.url : String(input), "https://crm.example"); if (url.pathname === "/api/auth/csrf") return Response.json({ csrfToken: "synthetic-only" });
    // Native fetch consumes this retained Request directly. An extra mock-only Request would create another weakly linked signal.
    const request = input instanceof Request ? input : new Request(input, init); return run(request, request.method === "GET" ? {} : await request.json() as Record<string, unknown>); }) as typeof fetch;
}
function mark(f: ReturnType<typeof fixture>) { client.markSalesOperationsCurrentRead("conversation", f.workspaceId, f.actorId, f.command, f.scope); }
test("a lost committed conversation survives a fresh module, reconciles the exact original body and clears no other actor", async () => {
  const f = fixture(); let originalBody = "", writes = 0;
  mock(async (_request, body) => { writes++; originalBody = JSON.stringify(body); throw Error("simulated lost committed response"); });
  await assert.rejects(client.writeSalesOperations("conversation", f.workspaceId, f.actorId, f.command)); assert.equal(writes, 1);
  const fresh = await import(`${new URL("../src/lib/website-sales-operations-client.ts", import.meta.url).href}?reload=${randomUUID()}`) as typeof client;
  assert.notEqual(fresh.salesOperationsPending, client.salesOperationsPending); assert.equal(fresh.salesOperationsPending("conversation", f.workspaceId, f.actorId)?.body, originalBody);
  assert.equal(fresh.salesOperationsPending("conversation", f.workspaceId, randomUUID()), undefined);
  await assert.rejects(fresh.reconcileSalesOperations("conversation", f.workspaceId, f.actorId));
  fresh.markSalesOperationsCurrentRead("conversation", f.workspaceId, f.actorId, f.command, f.scope);
  mock(async (request, body) => { assert.equal(new URL(request.url).pathname, "/api/crm/website-sales/conversation/reconcile"); assert.equal(JSON.stringify(body), originalBody); assert.equal(request.headers.get("idempotency-key"), f.command.idempotencyKey); return Response.json({ ...f.receipt, contractVersion: "website-sales-conversation-reconcile-v1", status: "COMMITTED" }); });
  assert.equal(await fresh.reconcileSalesOperations("conversation", f.workspaceId, f.actorId), "COMMITTED"); assert.equal(fresh.salesOperationsPending("conversation", f.workspaceId, f.actorId), undefined);
});
test("an old current-read cannot authorize a later unknown write; NOT_FOUND retries preserve its exact body and key", async () => {
  const f = fixture(); mock(async () => { throw Error("lost"); }); await assert.rejects(client.writeSalesOperations("conversation", f.workspaceId, f.actorId, f.command)); mark(f);
  mock(async () => Response.json({ contractVersion: "website-sales-conversation-reconcile-v1", correlationId: f.command.correlationId, status: "NOT_FOUND" })); assert.equal(await client.reconcileSalesOperations("conversation", f.workspaceId, f.actorId), "NOT_FOUND");
  let dispatches = 0; mock(async (_request, body) => { dispatches++; assert.deepEqual(body, f.command); return Response.json(f.receipt); });
  await assert.rejects(client.writeSalesOperations("conversation", f.workspaceId, f.actorId, { ...f.command, idempotencyKey: randomUUID() }, true)); assert.equal(dispatches, 0);
  await client.writeSalesOperations("conversation", f.workspaceId, f.actorId, f.command, true); assert.equal(dispatches, 1);
  const next = { ...f.command, idempotencyKey: randomUUID(), correlationId: randomUUID() }; mock(async () => { throw Error("lost next"); }); await assert.rejects(client.writeSalesOperations("conversation", f.workspaceId, f.actorId, next)); mark(f);
  assert.equal(client.salesOperationsPending("conversation", f.workspaceId, f.actorId)?.currentRead, false);
});
test("malformed or cross-scope success receipts remain UNKNOWN and cannot permit a changed command", async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => { f.receipt.data.workflow.companyId = randomUUID(); }, (f: ReturnType<typeof fixture>) => { f.receipt.data.canContact = true; }, (f: ReturnType<typeof fixture>) => { f.receipt.data.workflow.evidenceDigest = "invalid"; }, (f: ReturnType<typeof fixture>) => { f.receipt.data.topicTurnId = "invalid"; }]) {
    const f = fixture(); mutate(f); mock(async () => Response.json(f.receipt)); await assert.rejects(client.writeSalesOperations("conversation", f.workspaceId, f.actorId, f.command));
    assert.equal(client.salesOperationsPending("conversation", f.workspaceId, f.actorId)?.state, "UNKNOWN"); assert.equal(client.salesOperationsPending("conversation", f.workspaceId, f.actorId)?.body, JSON.stringify(f.command));
  }
});
test("damaged storage and a different pending Sales area block dispatch; unavailable storage cannot dispatch", async () => {
  const f = fixture(); saved.set(`novalure.website-sales-conversation.pending.v1:${f.actorId}:${f.workspaceId}`, "{bad"); let calls = 0; mock(async () => { calls++; return Response.json(f.receipt); });
  await assert.rejects(client.writeSalesOperations("conversation", f.workspaceId, f.actorId, f.command)); assert.equal(client.salesOperationsPending("conversation", f.workspaceId, f.actorId)?.damaged, true);
  const other = fixture(); saved.set(`novalure.website-sales-lifecycle.pending.v1:${other.actorId}:${other.workspaceId}`, "{unconfirmed"); await assert.rejects(client.writeSalesOperations("conversation", other.workspaceId, other.actorId, other.command));
  const third = fixture(), set = storage.setItem; storage.setItem = () => { throw Error("quota"); }; try { await assert.rejects(client.writeSalesOperations("conversation", third.workspaceId, third.actorId, third.command)); assert.equal(calls, 0); } finally { storage.setItem = set; }
});
test("a RESOURCE reconciliation receipt is accepted, then a distinct full read supplies project policies", async () => {
  const f = fixture(), command: SalesOperationsCommand = { contractVersion: websiteSalesOperationsContract, operation: "plan_portfolio", ...f.scope, expectedVersion: 1, idempotencyKey: randomUUID(), correlationId: randomUUID(), payload: { portfolioId: randomUUID(), candidates: [] } };
  mock(async () => { throw Error("lost plan"); }); await assert.rejects(client.writeSalesOperations("autonomy", f.workspaceId, f.actorId, command));
  client.markSalesOperationsCurrentRead("autonomy", f.workspaceId, f.actorId, command, f.scope);
  mock(async () => Response.json({ contractVersion: "website-sales-operations-reconcile-v1", status: "COMMITTED", correlationId: command.correlationId, commandId: randomUUID(), auditReference: randomUUID(), replayed: true, data: { workspaceId: f.workspaceId, ...f.scope, version: 2, portfolioId: command.payload.portfolioId, allocationIds: [], canContact: false }, currentData: { projection: "RESOURCE", portfolio: null, cohort: null } }));
  assert.equal(await client.reconcileSalesOperations("autonomy", f.workspaceId, f.actorId), "COMMITTED");
  mock(async request => { assert.equal(request.method, "GET"); return Response.json({ contractVersion: websiteSalesOperationsContract, source: "database", workspaceId: f.workspaceId, ...f.scope, projection: "PORTFOLIO", canApprovePolicies: true, opportunities: [], opportunitiesHasMore: false, portfolio: { id: command.payload.portfolioId }, policies: [{ id: randomUUID() }], allocations: [], quotes: [], financialEvidence: [], outcomes: [], improvements: [], workflow: null, canWrite: true, canContact: false }); });
  assert.equal((await client.readSalesOperations(f.workspaceId, f.scope)).policies.length, 1);
});
test("bounded transport aborts a hanging request and cancels a hanging response stream without losing UNKNOWN", async () => {
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => originalTimeout(handler as (...values: unknown[]) => void, delay === 15000 ? 15 : delay, ...args)) as unknown as typeof setTimeout;
  try {
    const f = fixture(); let aborted = false;
    mock(async request => new Promise<Response>((_resolve, reject) => { const abort = () => { aborted = true; reject(Error("aborted")); }; if (request.signal.aborted) abort(); else request.signal.addEventListener("abort", abort, { once: true }); }));
    await assert.rejects(client.writeSalesOperations("conversation", f.workspaceId, f.actorId, f.command)); assert.equal(aborted, true); assert.equal(client.salesOperationsPending("conversation", f.workspaceId, f.actorId)?.state, "UNKNOWN");
    const next = fixture(); let cancelled = false; mock(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await assert.rejects(client.writeSalesOperations("conversation", next.workspaceId, next.actorId, next.command)); assert.equal(cancelled, true); assert.equal(client.salesOperationsPending("conversation", next.workspaceId, next.actorId)?.state, "UNKNOWN");
  } finally { globalThis.setTimeout = originalTimeout; }
});
test("invalid UTF-8 and oversized multibyte receipts never clear pending state", async () => {
  for (const bytes of [new Uint8Array([0xc0, 0xaf]), new TextEncoder().encode(JSON.stringify({ padding: "€".repeat(90000) }))]) {
    const f = fixture(); mock(async () => new Response(bytes)); await assert.rejects(client.writeSalesOperations("conversation", f.workspaceId, f.actorId, f.command)); assert.equal(client.salesOperationsPending("conversation", f.workspaceId, f.actorId)?.state, "UNKNOWN");
  }
});
test("EUR and percentage inputs retain exact cents through safe-integer boundaries and reject ambiguous notation", () => {
  assert.equal(parseSalesHundredths("123,45"), 12345); assert.equal(parseSalesHundredths("90071992547409.91"), Number.MAX_SAFE_INTEGER); assert.equal(salesHundredthsInput(Number.MAX_SAFE_INTEGER), "90071992547409.91");
  for (const raw of ["90071992547409.92", "1.005", "1e3", "-1", "1,234.50", "NaN", ""]) assert.throws(() => parseSalesHundredths(raw));
  assert.equal(formatSalesMinor(null, "de"), "Unbekannt"); assert.equal(formatSalesMinor(-12345, "en"), "−123.45 €");
  assert.equal(formatSalesPercent(-1250, "de"), "−12,50 %"); assert.equal(formatSalesPercent(null, "en"), "Unknown");
});
