import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { startLocalSalesDb, applySalesSchema } from './lib/local-sales-db.mjs';
import { seedSalesBrowser } from './lib/sales-browser-fixture.mjs';
import { createCsrfToken } from '../src/lib/security/csrf-core';
import { closeLocalTestPool, getLocalTestPool } from '../src/lib/db/local-test-transport';
import type { WebsiteProspectIdentity, WebsiteProspectInput } from '../src/lib/website-prospect';

type Metadata = { idempotencyKey: string; correlationId: string };
type Workflow = WebsiteProspectIdentity & { id: string; version: number; locationVersion: number;
  status: 'OBSERVED' | 'QUALIFIED' | 'OFFER_DRAFT' | 'STOPPED'; evidenceDigest: string;
  leadId: string | null; dealId: string | null; nextTaskId: string | null; offerDraftId: string | null; canContact: false };
interface Client {
  registerLocation(input: { projectId: string; companyId: string; address: string; sourceUrl: string; sourceReference: string }, metadata: Metadata): Promise<Record<string, unknown>>;
  observe(input: WebsiteProspectInput, locationVersion: number, metadata: Metadata, expectedVersion?: number, investmentPlan?: unknown): Promise<Workflow>;
  read(identity: WebsiteProspectIdentity): Promise<Workflow | null>;
  qualify(workflow: Workflow, input: { contactId: string; opportunitySummary: string; nextAction: string }, metadata: Metadata): Promise<Workflow>;
  prepareOffer(workflow: Workflow, content: unknown, metadata: Metadata): Promise<Workflow>;
  stop(workflow: Workflow, reason: 'REPLY_RECEIVED' | 'OPT_OUT', sourceReference: string, metadata: Metadata): Promise<Workflow>;
}
type ClientModule = { WebsiteSalesClient: new (options: { origin: string; workspaceId: string; environment: 'local';
  transport: (request: Request) => Promise<Response>; now: () => string }) => Client };
const routePath = '/api/crm/website-sales';
const metadata = (): Metadata => ({ idempotencyKey: randomUUID(), correlationId: randomUUID() });

// Deliberately outside generic unit CI: this acceptance requires the actual other
// repository source. Missing it fails; no copy, stand-in client or skipped PASS.
test('actual Evelyn client → loopback HTTP → CRM session/CSRF route → PostgreSQL and independent readback', { timeout: 240_000 }, async t => {
  const source = process.env.EVELYN_WEBSITE_SALES_SOURCE;
  assert.ok(source && isAbsolute(source) && source.endsWith('website-sales-client.ts'), 'Set EVELYN_WEBSITE_SALES_SOURCE to the absolute actual Evelyn client source file');
  for (const key of ['VERCEL', 'VERCEL_ENV', 'VERCEL_URL']) assert.equal(process.env[key], undefined, 'Connected fixture is local only');
  const externalModule = await import(pathToFileURL(source).href) as ClientModule;
  assert.equal(typeof externalModule.WebsiteSalesClient, 'function');
  const db = await startLocalSalesDb();
  const envNames = ['DATABASE_URL', 'NODE_ENV', 'CRM_LOCAL_TEST_DATABASE', 'NOVALURE_SESSION_SECRET', 'NOVALURE_APP_ORIGIN',
    'NOVALURE_AUTH_STRICT', 'NOVALURE_AUTH_ENCRYPTION_KEY', 'NOVALURE_AUTH_RATE_LIMIT_SECRET'];
  const original = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
  let server: Server | undefined;
  try {
    await applySalesSchema(db);
    async function websiteFixture() {
      const base = await seedSalesBrowser(db);
      const projectId = randomUUID(), pipelineId = randomUUID(), developerId = randomUUID(), developerContactId = randomUUID();
      // Division is fixed before commercial use. The fixture never bypasses or
      // disables the actual immutable-project/division guards.
      await db.admin.query("insert into projects(id,workspace_id,name,type,customer_type,default_operating_model,division) values($1,$2,'SYNTHETIC Website Sales Project','Bauträger','property_developer','novalure_internal','WEB_DESIGN')", [projectId, base.workspaceId]);
      await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'synthetic-website-sales','SYNTHETIC Website Sales','sales',true)", [pipelineId, base.workspaceId, projectId]);
      for (const [position, name] of ['Neu', 'Qualifizieren', 'Angebot', 'Gewonnen', 'Verloren'].entries()) {
        await db.admin.query('insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category,probability) values($1,$2,$3,$4,$5,$6,$7,$8)',
          [pipelineId, base.workspaceId, projectId, `synthetic-website-${position}`, name, position, position === 3 ? 'won' : position === 4 ? 'lost' : 'work', position === 3 ? 100 : 50]);
      }
      await db.admin.query('update projects set default_pipeline_id=$2 where id=$1', [projectId, pipelineId]);
      await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC Website Customer','Bauträger')", [developerId, base.workspaceId, projectId]);
      await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,email,role) values($1,$2,$3,$4,$5,'Synthetic developer representative','synthetic-developer@example.invalid','Bauträger')", [developerContactId, base.workspaceId, projectId, developerId, base.userId]);
      return { ...base, projectId, pipelineId, developerId, developerContactId };
    }
    const first = await websiteFixture(), second = await websiteFixture();
    const secret = randomBytes(48).toString('base64url');
    const sessions = await Promise.all([first, second].map(async fixture => {
      const cookie = 'v2.' + randomBytes(32).toString('base64url');
      await db.admin.query('insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval \'1 hour\')',
        [randomUUID(), createHash('sha256').update(cookie).digest('hex'), fixture.authIdentityId, fixture.userId, fixture.workspaceId]);
      return cookie;
    }));
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: 'test', CRM_LOCAL_TEST_DATABASE: '1',
      NOVALURE_SESSION_SECRET: secret, NOVALURE_AUTH_STRICT: '1', NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString('hex'),
      NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString('hex') });
    const pool = await getLocalTestPool(process.env.DATABASE_URL!); assert.ok(pool);
    pool.on('connect', connection => {
      const query = connection.query.bind(connection);
      connection.query = ((...args: unknown[]) => {
        const pending: unknown = Reflect.apply(query, undefined, args);
        if (!(pending instanceof Promise)) return pending;
        return pending.catch((error: unknown) => {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          if (code === '42501') {
            const sql = typeof args[0] === 'string' ? args[0] : '';
            const tables = [...sql.matchAll(/\b(?:from|into|update|join)\s+(?:public\.)?([a-z_][a-z_0-9]*)/ig)].map(match => match[1]).slice(0, 8);
            t.diagnostic(JSON.stringify({ scope: 'LOCAL_SYNTHETIC_SQL_DENIAL', sqlstate: code, tables }));
          }
          throw error;
        });
      }) as typeof connection.query;
    });
    const route = await import('../src/app/api/crm/website-sales/route');
    let origin = '', requests = 0;
    server = createServer(async (incoming, outgoing) => {
      requests++;
      try {
        assert.equal(new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname, routePath, 'Only the exact CRM route is exposed');
        const chunks: Buffer[] = []; let length = 0;
        // The local relay's larger hard cap lets the actual application prove its
        // stricter 131072-byte guard. This is not a product/runtime limit change.
        for await (const chunk of incoming) { const buffer = Buffer.from(chunk); length += buffer.length; assert.ok(length <= 262_144); chunks.push(buffer); }
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
        const request = new Request(origin + incoming.url, { method: incoming.method, headers,
          ...(!['GET', 'HEAD'].includes(incoming.method ?? '') ? { body: Buffer.concat(chunks).toString('utf8') } : {}) });
        const response = incoming.method === 'GET' ? await route.GET(request) : await route.POST(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
      } catch { outgoing.writeHead(500, { 'Content-Type': 'application/json' }); outgoing.end('{"error":"LOCAL_CONNECTED_HANDLER_FAILURE"}'); }
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address === 'object'); origin = `http://127.0.0.1:${address.port}`;
    process.env.NOVALURE_APP_ORIGIN = origin;
    const clock = new Date().toISOString();
    let loseNextCommittedResponse = false;
    async function authenticatedFetch(request: Request, cookie = sessions[0]!) {
        assert.equal(new URL(request.url).origin, origin);
        const headers = new Headers(request.headers); headers.set('cookie', `novalure_session=${cookie}`); headers.set('origin', origin); headers.set('sec-fetch-site', 'same-origin');
        if (request.method !== 'GET') {
          const csrf = createCsrfToken({ method: request.method, pathname: routePath, secret, sessionCookie: cookie }); assert.ok(csrf);
          headers.set('x-novalure-csrf-token', csrf.token);
        }
        const response = await fetch(new Request(request, { headers }));
        if (!response.ok) { const safe = await response.clone().json() as { code?: unknown }; t.diagnostic(JSON.stringify({ scope: 'LOCAL_SYNTHETIC_HTTP_DENIAL', status: response.status, code: typeof safe.code === 'string' && /^[A-Z0-9_]+$/.test(safe.code) ? safe.code : 'UNCLASSIFIED' })); }
        return response;
    }
    const client = (workspaceId = first.workspaceId, cookie = sessions[0]!) => new externalModule.WebsiteSalesClient({ origin, workspaceId, environment: 'local', now: () => clock,
      transport: async request => {
        const response = await authenticatedFetch(request, cookie);
        if (loseNextCommittedResponse && request.method === 'POST' && response.ok) { loseNextCommittedResponse = false; await response.arrayBuffer(); throw new Error('SYNTHETIC response lost after real route commit'); }
        return response;
      } });
    const runtime = client();
    function prospect(identity: WebsiteProspectIdentity, path: WebsiteProspectInput['path'] = 'NO_WEBSITE'): WebsiteProspectInput {
      const kinds: WebsiteProspectInput['evidence'][number]['kind'][] = ['IDENTITY', 'OWN_WEBSITE_SEARCH', 'BUSINESS_NEED',
        ...(path === 'WEBSITE_OBSTACLE' ? ['OBSTACLE' as const] : path === 'PLATFORM_PRIMARY' ? ['PLATFORM_PRESENCE' as const, 'BOOKING_ROUTE' as const] : [])];
      return { identity, country: 'IRELAND', identityStatus: 'VERIFIED', path, domain: path === 'WEBSITE_OBSTACLE' ? 'company.example' : null,
        ownWebsiteSearch: path === 'WEBSITE_OBSTACLE' ? 'FOUND' : 'NONE_FOUND', obstacle: path === 'WEBSITE_OBSTACLE' ? 'CONFIRMED_REPRODUCIBLE' : null,
        platformUrl: path === 'PLATFORM_PRIMARY' ? 'https://booking.example/company' : null,
        bookingRoute: path === 'PLATFORM_PRIMARY' ? 'CHECKED_WORKING' : 'UNKNOWN', need: 'EVIDENCED',
        evidence: kinds.map((kind, index) => ({ evidenceId: `synthetic-${index}`, identity, kind, sourceUrl: 'https://company.example/about',
          observedAt: new Date(Date.parse(clock) - 1_000).toISOString(), validUntil: new Date(Date.parse(clock) + 3_600_000).toISOString(),
          validityCondition: 'Synthetic local evidence rechecked before use', finding: 'SYNTHETIC source-bound finding', confidence: 0.9 })) };
    }
    async function register(number: number) {
      const location = await runtime.registerLocation({ projectId: first.projectId, companyId: first.developerId, address: `${number} Synthetic Street, Dublin, Ireland`,
        sourceUrl: 'https://company.example/about', sourceReference: `SYNTHETIC registered location ${number}` }, metadata());
      assert.equal(typeof location.id, 'string'); assert.equal(typeof location.version, 'number');
      return { identity: { workspaceId: first.workspaceId, projectId: first.projectId, companyId: first.developerId, locationId: String(location.id) }, version: Number(location.version) };
    }
    const counts = async () => (await db.admin.query(`select (select count(*)::int from leads where workspace_id=$1) as leads,
      (select count(*)::int from deals where workspace_id=$1) as deals,(select count(*)::int from tasks where workspace_id=$1) as tasks,
      (select count(*)::int from crm_offers where workspace_id=$1) as offers,(select count(*)::int from crm_offer_deliveries where workspace_id=$1) as deliveries`, [first.workspaceId])).rows[0];
    const baseline = await counts();
    await t.test('chunked multibyte oversize is rejected by the real CRM route before any receipt or business write', async () => {
      const before = await counts();
      const receipts = Number((await db.admin.query('select count(*) from crm_command_receipts where workspace_id=$1', [first.workspaceId])).rows[0].count);
      const encoded = new TextEncoder().encode(JSON.stringify({ payload: '€'.repeat(45_000) }));
      assert.ok(encoded.byteLength > 131_072 && encoded.byteLength < 262_144);
      const stream = () => new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encoded.slice(0, 60_000)); controller.enqueue(encoded.slice(60_000)); controller.close();
      } });
      const meta = metadata();
      const requestInit: RequestInit & { duplex: 'half' } = { method: 'POST', headers: { 'Content-Type': 'application/json',
        'Idempotency-Key': meta.idempotencyKey, 'X-Correlation-Id': meta.correlationId }, body: stream(), duplex: 'half' };
      const request = new Request(origin + routePath, requestInit);
      assert.equal(request.headers.has('content-length'), false);
      const actualHttp = await authenticatedFetch(request);
      assert.equal(actualHttp.status, 413); assert.equal((await actualHttp.json()).code, 'PAYLOAD_TOO_LARGE');
      const csrf = createCsrfToken({ method: 'POST', pathname: routePath, secret, sessionCookie: sessions[0]! }); assert.ok(csrf);
      const directHeaders = new Headers(requestInit.headers);
      directHeaders.set('cookie', `novalure_session=${sessions[0]!}`); directHeaders.set('origin', origin);
      directHeaders.set('sec-fetch-site', 'same-origin'); directHeaders.set('x-novalure-csrf-token', csrf.token);
      const directRoute = await route.POST(new Request(origin + routePath, { ...requestInit, headers: directHeaders, body: stream() }));
      assert.equal(directRoute.status, 413); assert.equal((await directRoute.json()).code, 'PAYLOAD_TOO_LARGE');
      assert.deepEqual(await counts(), before);
      assert.equal(Number((await db.admin.query('select count(*) from crm_command_receipts where workspace_id=$1', [first.workspaceId])).rows[0].count), receipts);
    });
    const firstLocation = await register(1), input = prospect(firstLocation.identity), observeMeta = metadata();
    const diagnosisPlan = { requestedStage: 'DIAGNOSIS', completedStage: 'NONE', estimatedCostMinor: 0, availableBudgetMinor: 0,
      expectedNetPriceMinor: null, estimatedDeliveryCostMinor: null, minimumMarginBasisPoints: 0, requiredCapacityMinutes: 1,
      availableCapacityMinutes: 1, rightsVerified: false, budgetReference: null };
    let workflow = await runtime.observe(input, firstLocation.version, observeMeta, undefined, diagnosisPlan);
    await t.test('fresh-CSRF idempotent retransmit reuses one observation; changed payload conflicts', async () => {
      assert.equal(workflow.status, 'OBSERVED'); assert.equal((await runtime.observe(input, firstLocation.version, observeMeta, undefined, diagnosisPlan)).id, workflow.id);
      const changed = structuredClone(input); changed.evidence[0]!.finding = 'SYNTHETIC changed finding';
      await assert.rejects(runtime.observe(changed, firstLocation.version, observeMeta, undefined, diagnosisPlan), /WEBSITE_SALES_DENIED_409/);
      assert.equal(Number((await db.admin.query('select count(*) from crm_website_sales_observations where workspace_id=$1 and location_id=$2', [first.workspaceId, input.identity.locationId])).rows[0].count), 1);
      const decision = (await db.admin.query('select investment_decision from crm_website_sales_observations where workspace_id=$1 and location_id=$2', [first.workspaceId, input.identity.locationId])).rows[0].investment_decision;
      assert.equal(decision.stage, 'DIAGNOSIS'); assert.equal(decision.requestedStageAllowed, true); assert.equal(decision.spendAuthorized, false);
    });
    await t.test('qualify persists canonical lead/deal/task and prepares only one DRAFT offer', async () => {
      workflow = await runtime.qualify(workflow, { contactId: first.developerContactId, opportunitySummary: 'SYNTHETIC Irish website opportunity', nextAction: 'SYNTHETIC clarify website scope' }, metadata());
      assert.equal(workflow.status, 'QUALIFIED'); assert.ok(workflow.leadId && workflow.dealId && workflow.nextTaskId); assert.equal(workflow.canContact, false);
      const canonical = (await db.admin.query('select l.id as lead_id,d.id as deal_id,t.id as task_id from leads l join deals d on d.workspace_id=l.workspace_id and d.lead_id=l.id join tasks t on t.workspace_id=l.workspace_id and t.lead_id=l.id where l.workspace_id=$1 and l.id=$2 and d.id=$3 and t.id=$4', [first.workspaceId, workflow.leadId, workflow.dealId, workflow.nextTaskId])).rows;
      assert.equal(canonical.length, 1);
      const pipelineBinding = (await db.admin.query(`select d.stage,p.default_pipeline_id,s.pipeline_id,s.id as stage_id
        from deals d join projects p on p.workspace_id=d.workspace_id and p.id=d.project_id
        join crm_pipeline_stages s on s.workspace_id=d.workspace_id and s.project_id=d.project_id
          and s.pipeline_id=p.default_pipeline_id and s.name=d.stage
        where d.workspace_id=$1 and d.id=$2`, [first.workspaceId, workflow.dealId])).rows;
      assert.equal(pipelineBinding.length, 1, 'Opportunity must match a visible column of the canonical project pipeline');
      assert.equal(pipelineBinding[0].default_pipeline_id, first.pipelineId);
      assert.equal(pipelineBinding[0].pipeline_id, first.pipelineId);
      assert.equal(pipelineBinding[0].stage, 'Qualifizieren');
      workflow = await runtime.prepareOffer(workflow, { subject: 'SYNTHETIC website draft', recipientName: 'Synthetic developer representative', recipientEmail: 'synthetic-developer@example.invalid',
        scope: 'SYNTHETIC website scope', paymentPlan: 'SYNTHETIC draft terms', discounts: 'SYNTHETIC none', specialTerms: 'SYNTHETIC none', riskComplianceNotes: 'SYNTHETIC local acceptance only',
        terms: 'SYNTHETIC not an approved offer', validUntil: new Date(Date.parse(clock) + 86_400_000).toISOString(), currency: 'EUR', taxBasis: 'NET',
        items: [{ description: 'SYNTHETIC website work', quantity: 1, unitNetCents: 100_000 }] }, metadata());
      assert.equal(workflow.status, 'OFFER_DRAFT'); assert.ok(workflow.offerDraftId);
      const offer = (await db.admin.query('select status from crm_offers where workspace_id=$1 and id=$2', [first.workspaceId, workflow.offerDraftId])).rows[0];
      assert.equal(offer.status, 'DRAFT'); assert.equal((await counts()).deliveries, baseline.deliveries);
    });
    await t.test('reply stops the stored workflow; opt-out on another location also has no delivery', async () => {
      workflow = await runtime.stop(workflow, 'REPLY_RECEIVED', 'SYNTHETIC reply record', metadata()); assert.equal(workflow.status, 'STOPPED');
      const stoppedTask = (await db.admin.query('select status,metadata from tasks where workspace_id=$1 and id=$2', [first.workspaceId, workflow.nextTaskId])).rows[0];
      assert.equal(stoppedTask.status, 'done'); assert.equal(stoppedTask.metadata.stopped, true); assert.equal(stoppedTask.metadata.stopReason, 'REPLY_RECEIVED');
      const location = await register(2); const observed = await runtime.observe(prospect(location.identity, 'PLATFORM_PRIMARY'), location.version, metadata());
      assert.equal((await runtime.stop(observed, 'OPT_OUT', 'SYNTHETIC opt-out record', metadata())).status, 'STOPPED');
      assert.deepEqual((await db.admin.query('select stop_reason from crm_website_sales_workflows where workspace_id=$1 order by stop_reason', [first.workspaceId])).rows,
        [{ stop_reason: 'OPT_OUT' }, { stop_reason: 'REPLY_RECEIVED' }]);
      assert.equal((await counts()).deliveries, baseline.deliveries);
    });
    await t.test('second tenant cannot read or mutate the first tenant through the actual HTTP/session boundary', async () => {
      const before = requests;
      const foreignSessionClient = client(first.workspaceId, sessions[1]!);
      await assert.rejects(foreignSessionClient.read(input.identity), /WEBSITE_SALES_DENIED_(403|404)/);
      await assert.rejects(foreignSessionClient.observe(input, firstLocation.version, metadata(), workflow.version), /WEBSITE_SALES_DENIED_(403|404)/);
      assert.ok(requests >= before + 2);
      assert.equal(Number((await db.admin.query('select count(*) from crm_website_sales_workflows where workspace_id=$1', [second.workspaceId])).rows[0].count), 0);
    });
    await t.test('stale evidence and revoked actor cannot create qualified records', async () => {
      const location = await register(3), stale = prospect(location.identity, 'WEBSITE_OBSTACLE');
      for (const evidence of stale.evidence) { evidence.observedAt = new Date(Date.parse(clock) - 7_200_000).toISOString(); evidence.validUntil = new Date(Date.parse(clock) - 3_600_000).toISOString(); }
      const before = await counts();
      const observed = await runtime.observe(stale, location.version, metadata());
      await assert.rejects(runtime.qualify(observed, { contactId: first.developerContactId, opportunitySummary: 'SYNTHETIC stale opportunity', nextAction: 'SYNTHETIC stale action' }, metadata()), /WEBSITE_SALES_STATE_INVALID|WEBSITE_SALES_DENIED_(400|409|422)/);
      // The actual client stops stale state locally; a crafted HTTP command must
      // independently fail at the server's current-evidence check as well.
      const staleMeta = metadata(), staleResponse = await authenticatedFetch(new Request(origin + routePath, { method: 'POST', headers: { 'Content-Type': 'application/json',
        'Idempotency-Key': staleMeta.idempotencyKey, 'X-Correlation-Id': staleMeta.correlationId }, body: JSON.stringify({ contractVersion: 'website-sales-ireland-v1', operation: 'qualify',
        projectId: observed.projectId, companyId: observed.companyId, locationId: observed.locationId, expectedVersion: observed.version, ...staleMeta,
        payload: { contactId: first.developerContactId, opportunitySummary: 'SYNTHETIC stale bypass attempt', nextAction: 'SYNTHETIC blocked action', expectedEvidenceDigest: observed.evidenceDigest } }) }));
      assert.equal(staleResponse.status, 409); assert.equal((await staleResponse.json()).code, 'CURRENT_EVIDENCE_REQUIRED');
      await db.admin.query("update workspace_users set role='assistant',product_role='viewer' where id=$1", [first.userId]);
      try { await assert.rejects(runtime.registerLocation({ projectId: first.projectId, companyId: first.developerId, address: '9 Synthetic Street, Dublin, Ireland', sourceUrl: 'https://company.example/about', sourceReference: 'SYNTHETIC revoked actor' }, metadata()), /WEBSITE_SALES_DENIED_403/); }
      finally { await db.admin.query("update workspace_users set role='owner',product_role='novalureAdmin' where id=$1", [first.userId]); }
      assert.deepEqual(await counts(), before);
    });
    await t.test('lost response after real commit is UNKNOWN; fresh client reads and exact retransmit does not duplicate', async () => {
      const location = await register(4), fresh = prospect(location.identity, 'WEBSITE_OBSTACLE'), meta = metadata();
      loseNextCommittedResponse = true;
      await assert.rejects(runtime.observe(fresh, location.version, meta), (error: unknown) => error instanceof Error && 'outcome' in error && error.outcome === 'UNKNOWN');
      const freshClient = client(); const recovered = await freshClient.read(location.identity); assert.ok(recovered); assert.equal(recovered.status, 'OBSERVED');
      assert.equal((await freshClient.observe(fresh, location.version, meta)).id, recovered.id);
      assert.equal(Number((await db.admin.query('select count(*) from crm_website_sales_observations where workspace_id=$1 and location_id=$2', [first.workspaceId, location.identity.locationId])).rows[0].count), 1);
      assert.equal((await counts()).deliveries, baseline.deliveries);
    });
    const final = await counts();
    assert.equal(final.leads, baseline.leads + 1); assert.equal(final.deals, baseline.deals + 1); assert.equal(final.tasks, baseline.tasks + 1);
    assert.equal(final.offers, baseline.offers + 1); assert.equal(final.deliveries, baseline.deliveries);
    t.diagnostic('LOCAL_REAL_HTTP_AND_POSTGRES_SYNTHETIC_PAYLOAD_ONLY; ACTUAL_EXTERNAL_EVELYN_SOURCE; NO_PROVIDER_OR_OUTBOUND_EFFECT');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
    await closeLocalTestPool();
    for (const key of envNames) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    await db.stop();
  }
});
