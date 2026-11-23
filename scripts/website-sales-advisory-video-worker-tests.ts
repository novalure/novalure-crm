import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { advisoryDigest, advisoryRecordDigest } from '../src/lib/website-sales-advisory-domain';
import type { AdvisoryRecord } from '../src/lib/website-sales-advisory-types';
import { buildWebsiteDemo, createWebsiteConcept, createWebsiteDiagnosis } from '../src/lib/website-sales-studio';
import type { WebsiteInvestmentInput, WebsiteProspectInput } from '../src/lib/website-prospect';
import { advisoryVideoBundleFromDemo, createWebsiteSalesAdvisoryVideoJobRunner, type AdvisoryVideoDemoSnapshot, type AdvisoryVideoWorkerJob, type AdvisoryVideoWorkerPorts, type AdvisoryVideoWorkerCompletion } from './website-sales-advisory-video-worker';

// Synthetic opaque-port fixtures test binding/state behavior; they are not database or production attestation.
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const reference = (row: Pick<AdvisoryRecord, 'id' | 'version' | 'digest'>) => ({ id: row.id, version: row.version, digest: row.digest });
async function fixture() {
  const timestamp = Date.now(), iso = (offset: number) => new Date(timestamp + offset).toISOString();
  const identity = { workspaceId: randomUUID(), projectId: randomUUID(), companyId: randomUUID(), locationId: randomUUID() }, workflowId = randomUUID(), builderId = randomUUID();
  const prospect: WebsiteProspectInput = { identity, country: 'IRELAND', identityStatus: 'VERIFIED', domain: null, path: 'NO_WEBSITE', ownWebsiteSearch: 'NONE_FOUND', obstacle: null, platformUrl: null, bookingRoute: 'UNKNOWN', need: 'EVIDENCED',
    evidence: (['IDENTITY', 'OWN_WEBSITE_SEARCH', 'BUSINESS_NEED'] as const).map(kind => ({ evidenceId: kind, identity, kind, sourceUrl: 'https://example.invalid/synthetic-adapter-proof', observedAt: iso(-60000), validUntil: iso(3600000), validityCondition: 'Synthetic fixture remains unchanged', finding: 'Synthetic customers need clear opening hours.', confidence: .95 })) };
  const investmentPlan: WebsiteInvestmentInput = { requestedStage: 'DEMO', completedStage: 'NONE', completedStageEvidence: null, estimatedCostMinor: 0, availableBudgetMinor: 0, expectedNetPriceMinor: 250000, estimatedDeliveryCostMinor: 50000, minimumMarginBasisPoints: 3000, requiredCapacityMinutes: 60, availableCapacityMinutes: 600, rightsVerified: true, budgetReference: null };
  const claim = { text: 'Synthetic customers need clear opening hours.', evidenceIds: ['BUSINESS_NEED'] }, scope = { included: ['Synthetic information pages'], excluded: ['Sending, booking, payment and publication'] }, revision = { version: 1, previousArtifactDigest: null };
  const diagnosis = createWebsiteDiagnosis({ prospect, companyName: 'Synthetic adapter company', locationLabel: 'Synthetic Dublin', recommendations: [claim], scope, investmentPlan, revision }, iso(-3000));
  const concept = createWebsiteConcept({ prospect, diagnosis, objective: 'Synthetic opening-hours information', hero: claim, sections: [{ title: 'Synthetic opening hours', body: claim }], visualDirection: 'STUDIO_BLUE', scope, investmentPlan, revision }, iso(-2000));
  const artifact = await buildWebsiteDemo({ prospect, concept, investmentPlan, revision }, { resolveAcceptedConcept: async () => ({ identity, artifactDigest: concept.artifactDigest, acceptanceId: randomUUID(), acceptedAt: iso(-1500) }) }, iso(-1000));
  const demoRef = { id: randomUUID(), version: artifact.version, digest: artifact.artifactDigest }, actorId = randomUUID();
  const record = (kind: AdvisoryRecord['kind'], payload: Record<string, unknown>, createdAt: string, parentRefs: AdvisoryRecord['parentRefs'] = []): AdvisoryRecord => {
    const row: AdvisoryRecord = { id: randomUUID(), identity, workflowId, kind, version: 1, workflowVersion: 2, digest: '', createdBy: actorId, createdAt, validUntil: iso(1200000), revokedAt: null, parentRefs, payload }; row.digest = advisoryRecordDigest(row); return row;
  };
  const storyboard = record('VIDEO_STORYBOARD', { status: 'READY', reasons: [], externalEffectAllowed: false, requiresServerAuthorization: true,
    value: { demoRef, packetRef: null, title: 'Synthetic native demo walkthrough', language: 'en', maximumSeconds: 20, assetRefs: [],
      shots: [{ index: 0, durationSeconds: 20, narration: 'This synthetic website preview proposes a clearer opening-hours section. It does not book, send messages or accept payments.', factId: randomUUID(), evidenceRef: demoRef, visual: 'PROTECTED_DEMO_CAPTURE', demoRef }],
      sourceBindingDigest: 'c'.repeat(64), status: 'STORYBOARD_REQUIRES_APPROVAL', customerSecretsIncluded: false, renderedVideo: false } }, iso(-300));
  const approval = record('VIDEO_APPROVAL', { recordRef: reference(storyboard), validUntil: iso(900000) }, iso(-100), [reference(storyboard)]);
  const frozenContext = { context: { identity, workflowId, workflowVersion: 2 }, record: approval, storyboard };
  const job: AdvisoryVideoWorkerJob = { id: randomUUID(), identity, workflowId, kind: 'VIDEO', version: 1, status: 'READY', recordRef: reference(approval), frozenContext,
    contextDigest: advisoryDigest(frozenContext), sourceRefs: [reference(storyboard)], leaseToken: null, leaseExpiresAt: null, resultDigest: null };
  const snapshot: AdvisoryVideoDemoSnapshot = { artifact, prospect, workflowId, builderId, certificate: { payload: { contractVersion: 'website-sales-rendered-qa-v1', issuer: 'synthetic-adapter-unit', keyId: 'synthetic-only', certificateId: randomUUID(), ...identity, workflowId,
    artifactDigest: artifact.artifactDigest, htmlDigest: artifact.content.htmlDigest, assetManifestDigest: artifact.content.assetManifestDigest, evidenceDigest: artifact.evidenceDigest, qaActorId: randomUUID(), sourceRevision: 'a'.repeat(40), checkedAt: iso(-500), expiresAt: iso(1200000),
    checks: { desktop: true, tablet: true, mobile: true, reducedMotion: true, keyboard: true, noConsoleErrors: true, noSideEffects: true } }, signature: 'A'.repeat(86) } };
  const calls = { read: 0, claim: 0, render: 0, verify: 0, complete: 0, unknown: 0 }, executor = Object.freeze({ syntheticOpaqueExecutor: true });
  let current = true, committed: AdvisoryVideoWorkerCompletion | null = null;
  const ports: AdvisoryVideoWorkerPorts<typeof executor> = {
    now: () => timestamp,
    read: async cap => { assert.equal(cap, executor); calls.read++; return structuredClone(job); },
    claim: async () => { calls.claim++; if (job.status !== 'READY') return null; job.status = 'CLAIMED'; job.version++; job.leaseToken = randomUUID(); job.leaseExpiresAt = iso(240000); return structuredClone(job); },
    withActor: async (_cap, _id, run) => run({ job: structuredClone(job), isCurrent: async () => current }),
    readDemo: async () => structuredClone(snapshot),
    verifyQa: async () => { calls.verify++; },
    render: async (bundle, raw, guard) => { calls.render++; assert(await guard.isCurrent()); const value = raw as { sourceBindingDigest: string; shots: { narration: string }[] };
      const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]); return { bytes, sha256: sha(bytes), mediaType: 'video/webm', durationSeconds: 20, width: 1280, height: 720, narration: 'CAPTIONS_ONLY', captionText: value.shots.map(row => row.narration).join('\n\n'), demoRef: bundle.demoRef, sourceBindingDigest: value.sourceBindingDigest, documentSha256: bundle.documentSha256, renderer: 'PLAYWRIGHT_SEALED_DEMO_V1', networkRequests: 3 }; },
    complete: async (_cap, input) => { calls.complete++; committed = input; job.status = 'SUCCEEDED'; job.resultDigest = input.video.sha256; job.version++; job.leaseToken = null; job.leaseExpiresAt = null; return structuredClone(job); },
    markUnknown: async () => { calls.unknown++; job.status = 'UNKNOWN'; job.leaseToken = null; job.leaseExpiresAt = null; },
  };
  return { timestamp, iso, identity, demoRef, job, snapshot, storyboard, approval, ports, executor, calls, setCurrent: (value: boolean) => { current = value; }, completion: () => committed };
}
test('canonical demo HTML and literal assets become exact sealed renderer paths and bytes', async () => {
  const f = await fixture(), bundle = advisoryVideoBundleFromDemo(f.snapshot, f.job, f.demoRef, f.iso(0));
  assert.equal(bundle.document, f.snapshot.artifact.content.html); assert.equal(bundle.documentSha256, sha(bundle.document));
  assert.deepEqual(bundle.assets.map(row => row.path), ['assets/studio.css', 'assets/placeholder.svg']);
  for (const asset of bundle.assets) assert.equal(asset.sha256, sha(asset.bytes));
  assert.throws(() => advisoryVideoBundleFromDemo({ ...f.snapshot, workflowId: randomUUID() }, f.job, f.demoRef, f.iso(0)), /BINDING_CHANGED/);
  assert.throws(() => advisoryVideoBundleFromDemo(f.snapshot, f.job, { ...f.demoRef, digest: 'f'.repeat(64) }, f.iso(0)), /BINDING_CHANGED/);
});
test('the private adapter completes only exact checked capture bytes and immutable approval proof', async () => {
  const f = await fixture(), result = await createWebsiteSalesAdvisoryVideoJobRunner(f.ports)(f.executor, f.job.id), completion = f.completion();
  assert.equal(result.status, 'SUCCEEDED'); assert.equal(f.calls.render, 1); assert.equal(f.calls.complete, 1); assert.equal(f.calls.unknown, 0); assert(f.calls.verify >= 3);
  assert(completion); assert.equal(completion.result, null); assert.deepEqual(completion.video.captureProof.storyboardRef, reference(f.storyboard));
  assert.equal(completion.video.captureProof.documentSha256, f.snapshot.artifact.content.htmlDigest); assert.equal(completion.video.captureProof.qaCertificateId, f.snapshot.certificate.payload.certificateId);
});
test('unresolved or completed work is not re-rendered or automatically retried', async () => {
  for (const status of ['UNKNOWN', 'CLAIMED', 'SUCCEEDED', 'FAILED', 'CANCELLED']) { const f = await fixture(); f.job.status = status;
    const result = await createWebsiteSalesAdvisoryVideoJobRunner(f.ports)(f.executor, f.job.id); assert.equal(result.status, ['UNKNOWN', 'CLAIMED'].includes(status) ? 'RECONCILIATION_REQUIRED' : 'NOT_CLAIMED'); assert.equal(f.calls.claim, status === 'CLAIMED' ? 1 : 0); assert.equal(f.calls.render, 0); assert.equal(f.calls.complete, 0); }
});
test('a changed context, approval or authority cannot start capture', async () => {
  const changed = await fixture(); changed.job.contextDigest = '0'.repeat(64); await assert.rejects(createWebsiteSalesAdvisoryVideoJobRunner(changed.ports)(changed.executor, changed.job.id), /DIGEST_CHANGED/); assert.equal(changed.calls.claim, 0);
  const f = await fixture(); f.approval.payload.recordRef = { ...reference(f.storyboard), digest: 'f'.repeat(64) }; f.approval.digest = advisoryRecordDigest(f.approval); f.job.recordRef = reference(f.approval); f.job.contextDigest = advisoryDigest(f.job.frozenContext);
  assert.equal((await createWebsiteSalesAdvisoryVideoJobRunner(f.ports)(f.executor, f.job.id)).status, 'UNKNOWN'); assert.equal(f.calls.render, 0); assert.equal(f.calls.complete, 0);
  const revoked = await fixture(); revoked.setCurrent(false); assert.equal((await createWebsiteSalesAdvisoryVideoJobRunner(revoked.ports)(revoked.executor, revoked.job.id)).status, 'UNKNOWN'); assert.equal(revoked.calls.render, 0);
});
test('QA rejection and source changes during capture retain UNKNOWN and never persist a video', async () => {
  const f = await fixture(); f.ports.verifyQa = () => { throw Error('synthetic invalid certificate'); }; assert.equal((await createWebsiteSalesAdvisoryVideoJobRunner(f.ports)(f.executor, f.job.id)).status, 'UNKNOWN'); assert.equal(f.calls.render, 0);
  const changed = await fixture(), render = changed.ports.render!; changed.ports.render = async (...args) => { const result = await render(...args); changed.snapshot.artifact = { ...changed.snapshot.artifact, content: { ...changed.snapshot.artifact.content, html: 'changed unsealed source' } }; return result; };
  assert.equal((await createWebsiteSalesAdvisoryVideoJobRunner(changed.ports)(changed.executor, changed.job.id)).status, 'UNKNOWN'); assert.equal(changed.calls.complete, 0); assert.equal(changed.calls.unknown, 1);
});
test('capture bytes and source proof are checked again before native atomic completion', async () => {
  for (const mode of ['hash', 'source', 'caption', 'duration']) { const f = await fixture(), render = f.ports.render!; f.ports.render = async (...args) => { const result = await render(...args); return { ...result, ...(mode === 'hash' ? { sha256: '0'.repeat(64) } : mode === 'source' ? { documentSha256: '0'.repeat(64) } : mode === 'caption' ? { captionText: 'changed narration' } : { durationSeconds: 21 }) }; };
    assert.equal((await createWebsiteSalesAdvisoryVideoJobRunner(f.ports)(f.executor, f.job.id)).status, 'UNKNOWN'); assert.equal(f.calls.complete, 0); assert.equal(f.calls.render, 1); }
});
test('a lost committed completion is reconciled through a fresh native read without re-rendering', async () => {
  const f = await fixture(), complete = f.ports.complete; f.ports.complete = async (...args) => { await complete(...args); throw Error('synthetic post-commit acknowledgement loss'); };
  const result = await createWebsiteSalesAdvisoryVideoJobRunner(f.ports)(f.executor, f.job.id); assert.equal(result.status, 'SUCCEEDED_RECONCILED'); assert.equal(f.calls.render, 1); assert.equal(f.calls.complete, 1); assert.equal(f.calls.unknown, 0);
});
test('unconfirmed completion failure is not retried with new rendering or another lease', async () => {
  const f = await fixture(); f.ports.complete = async () => { f.calls.complete++; throw Error('synthetic unavailable completion'); };
  const run = createWebsiteSalesAdvisoryVideoJobRunner(f.ports); assert.equal((await run(f.executor, f.job.id)).status, 'UNKNOWN'); assert.equal((await run(f.executor, f.job.id)).status, 'RECONCILIATION_REQUIRED'); assert.equal(f.calls.render, 1); assert.equal(f.calls.claim, 1); assert.equal(f.calls.complete, 1);
});
test('an expired native lease may become UNKNOWN but is never automatically captured again', async () => {
  const f = await fixture(); f.job.status = 'CLAIMED'; f.job.leaseToken = randomUUID(); f.job.leaseExpiresAt = f.iso(-1000); f.ports.claim = async () => { f.calls.claim++; f.job.status = 'UNKNOWN'; f.job.leaseToken = null; return null; };
  assert.equal((await createWebsiteSalesAdvisoryVideoJobRunner(f.ports)(f.executor, f.job.id)).status, 'RECONCILIATION_REQUIRED'); assert.equal(f.job.status, 'UNKNOWN'); assert.equal(f.calls.render, 0); assert.equal(f.calls.complete, 0);
});
test('the adapter renders actual canonical studio HTML and assets into measured WebM with sealed captions', { timeout: 65000 }, async () => {
  const f = await fixture(); delete f.ports.render; const result = await createWebsiteSalesAdvisoryVideoJobRunner(f.ports)(f.executor, f.job.id), completion = f.completion();
  assert.equal(result.status, 'SUCCEEDED'); assert(completion); assert(completion.video.bytes.byteLength > 1000); assert(completion.video.durationSeconds >= 19 && completion.video.durationSeconds <= 20.05);
  assert.equal(completion.video.sha256, sha(completion.video.bytes)); assert.equal(completion.video.captureProof.documentSha256, f.snapshot.artifact.content.htmlDigest);
  const directory = join(process.cwd(), '.npm-cache', 'qa', 'website-sales-advisory-video-worker-20261123'); await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'canonical-demo.webm'), completion.video.bytes);
  await writeFile(join(directory, 'result.json'), JSON.stringify({ syntheticOnly: true, actualCanonicalDemoRender: true, actualBrowserCapture: true, syntheticExecutorPorts: true, nativePostgresCompletion: false, realProviderCalls: 0,
    sha256: completion.video.sha256, byteLength: completion.video.bytes.byteLength, durationSeconds: completion.video.durationSeconds, mediaType: completion.video.mediaType, captureProof: completion.video.captureProof }, null, 2) + '\n');
});
