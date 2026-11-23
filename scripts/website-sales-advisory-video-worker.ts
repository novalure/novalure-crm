/** Private Node worker adapter. A browser or HTTP caller cannot construct its native executor. */
import { createHash } from 'node:crypto';
import { advisoryDigest, verifyAdvisoryRecord } from '../src/lib/website-sales-advisory-domain';
import { advisoryIdentitySchema, advisoryRecordPayloadSchemas, advisoryReferenceSchema, advisoryUuid, type AdvisoryIdentity, type AdvisoryReference } from '../src/lib/website-sales-advisory-types';
import { verifyWebsiteStudioArtifact, websiteStudioAssetManifestDigest, type WebsiteDemoArtifact } from '../src/lib/website-sales-studio';
import { studioRasterBytes } from '../src/lib/website-sales-studio-brand';
import type { WebsiteProspectInput } from '../src/lib/website-prospect';
import type { WebsiteStudioQaCertificate } from '../src/lib/website-sales-studio-types';
import { renderWebsiteSalesAdvisoryVideo, type AdvisoryVideoBundle, type AdvisoryVideoCapture } from './website-sales-advisory-video-render';

type Json = Record<string, unknown>;
export type AdvisoryVideoWorkerJob = {
  id: string; identity: AdvisoryIdentity; workflowId: string; kind: string; version: number; status: string;
  recordRef: AdvisoryReference; frozenContext: Json; contextDigest: string; sourceRefs: AdvisoryReference[];
  leaseToken: string | null; leaseExpiresAt: string | null; resultDigest: string | null;
};
export type AdvisoryVideoDemoSnapshot = { artifact: WebsiteDemoArtifact; prospect: WebsiteProspectInput; certificate: WebsiteStudioQaCertificate; builderId: string; workflowId: string };
export type AdvisoryVideoWorkerCompletion = { jobId: string; leaseToken: string; contextDigest: string; result: null;
  video: { bytes: Uint8Array; mediaType: 'video/webm'; sha256: string; durationSeconds: number; width: number; height: number; captureProof: Json } };
export interface AdvisoryVideoWorkerPorts<Executor> {
  read(executor: Executor, jobId: string): Promise<AdvisoryVideoWorkerJob>;
  claim(executor: Executor, jobId: string): Promise<AdvisoryVideoWorkerJob | null>;
  withActor<T>(executor: Executor, jobId: string, run: (actor: { job: AdvisoryVideoWorkerJob; isCurrent(): Promise<boolean> }) => Promise<T>): Promise<T>;
  readDemo(executor: Executor, jobId: string): Promise<AdvisoryVideoDemoSnapshot>;
  verifyQa(certificate: WebsiteStudioQaCertificate, artifact: WebsiteDemoArtifact, workflowId: string, builderId: string, now: string): void | Promise<void>;
  complete(executor: Executor, input: AdvisoryVideoWorkerCompletion): Promise<AdvisoryVideoWorkerJob>;
  markUnknown(executor: Executor, input: { jobId: string; leaseToken: string; contextDigest: string; errorCode: string }): Promise<unknown>;
  render?: typeof renderWebsiteSalesAdvisoryVideo;
  now?: () => number;
}
export type AdvisoryVideoWorkerOutcome = { jobId: string; status: 'NOT_CLAIMED' | 'RECONCILIATION_REQUIRED' | 'SUCCEEDED' | 'SUCCEEDED_RECONCILED' | 'UNKNOWN'; resultDigest: string | null };
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const equalRef = (a: AdvisoryReference, b: AdvisoryReference) => a.id === b.id && a.version === b.version && a.digest === b.digest;
function requireRule(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
function object(value: unknown): Json { requireRule(value && typeof value === 'object' && !Array.isArray(value), 'ADVISORY_VIDEO_CONTEXT_INVALID'); return value as Json; }
function checkedJob(job: AdvisoryVideoWorkerJob, expectedId: string) {
  requireRule(job.id === expectedId && job.kind === 'VIDEO' && Number.isSafeInteger(job.version) && job.version > 0, 'ADVISORY_VIDEO_JOB_REQUIRED');
  advisoryIdentitySchema.parse(job.identity); advisoryUuid.parse(job.workflowId); advisoryReferenceSchema.parse(job.recordRef);
  requireRule(job.contextDigest === advisoryDigest(job.frozenContext), 'ADVISORY_VIDEO_CONTEXT_DIGEST_CHANGED');
  return job;
}
function sameJob(a: AdvisoryVideoWorkerJob, b: AdvisoryVideoWorkerJob) {
  requireRule(a.id === b.id && a.workflowId === b.workflowId && advisoryDigest(a.identity) === advisoryDigest(b.identity) && a.contextDigest === b.contextDigest && equalRef(a.recordRef, b.recordRef)
    && advisoryDigest(a.sourceRefs) === advisoryDigest(b.sourceRefs), 'ADVISORY_VIDEO_JOB_BINDING_CHANGED');
}
function approvedStoryboard(job: AdvisoryVideoWorkerJob, now: string) {
  const context = object(job.frozenContext.context), identity = advisoryIdentitySchema.parse(context.identity);
  requireRule(advisoryDigest(identity) === advisoryDigest(job.identity) && context.workflowId === job.workflowId && Number.isSafeInteger(context.workflowVersion) && Number(context.workflowVersion) > 0, 'ADVISORY_VIDEO_CONTEXT_SCOPE_CHANGED');
  const scope = { identity, workflowId: job.workflowId, workflowVersion: Number(context.workflowVersion) };
  const approval = verifyAdvisoryRecord(job.frozenContext.record, scope, now), storyboard = verifyAdvisoryRecord(job.frozenContext.storyboard, scope, now);
  requireRule(approval.kind === 'VIDEO_APPROVAL' && storyboard.kind === 'VIDEO_STORYBOARD' && equalRef(job.recordRef, approval), 'ADVISORY_VIDEO_APPROVAL_REQUIRED');
  const permission = advisoryRecordPayloadSchemas.VIDEO_APPROVAL.parse(approval.payload), evaluation = advisoryRecordPayloadSchemas.VIDEO_STORYBOARD.parse(storyboard.payload);
  requireRule(equalRef(permission.recordRef, storyboard) && Date.parse(permission.validUntil) > Date.parse(now) && Date.parse(approval.createdAt) >= Date.parse(storyboard.createdAt)
    && approval.parentRefs.some(ref => equalRef(ref, storyboard)) && job.sourceRefs.some(ref => equalRef(ref, storyboard)) && evaluation.status === 'READY' && evaluation.value, 'ADVISORY_VIDEO_APPROVAL_BINDING_CHANGED');
  return { reference: { id: storyboard.id, version: storyboard.version, digest: storyboard.digest }, value: evaluation.value };
}
/** Convert canonical demo bytes only. Public URLs, omitted raster bodies and substitute HTML are rejected. */
export function advisoryVideoBundleFromDemo(snapshot: AdvisoryVideoDemoSnapshot, job: Pick<AdvisoryVideoWorkerJob, 'identity' | 'workflowId'>, demoRef: AdvisoryReference, now: string): AdvisoryVideoBundle {
  const artifact = verifyWebsiteStudioArtifact(snapshot.artifact, snapshot.prospect, now);
  requireRule(artifact.kind === 'DEMO' && snapshot.workflowId === job.workflowId && advisoryDigest(artifact.identity) === advisoryDigest(job.identity)
    && artifact.version === demoRef.version && artifact.artifactDigest === demoRef.digest, 'ADVISORY_VIDEO_DEMO_BINDING_CHANGED');
  requireRule(artifact.content.htmlDigest === sha(artifact.content.html) && artifact.content.assetManifestDigest === websiteStudioAssetManifestDigest(artifact.content.assets), 'ADVISORY_VIDEO_DEMO_BYTES_CHANGED');
  const assets = artifact.content.assets.map(asset => {
    const bytes = new Uint8Array('bodyEncoding' in asset ? studioRasterBytes(asset) : new TextEncoder().encode(asset.body));
    requireRule(sha(bytes) === asset.sha256, 'ADVISORY_VIDEO_ASSET_BYTES_CHANGED');
    return { path: `assets/${asset.path}`, mediaType: asset.mediaType, sha256: asset.sha256, bytes };
  });
  return { demoRef, document: artifact.content.html, documentSha256: artifact.content.htmlDigest, assets };
}
function demoBinding(snapshot: AdvisoryVideoDemoSnapshot, bundle: AdvisoryVideoBundle) {
  return advisoryDigest({ demoRef: bundle.demoRef, documentSha256: bundle.documentSha256, assetManifestDigest: snapshot.artifact.content.assetManifestDigest,
    workflowId: snapshot.workflowId, builderId: snapshot.builderId, certificate: snapshot.certificate });
}
function checkedCapture(value: AdvisoryVideoCapture, bundle: AdvisoryVideoBundle, storyboard: ReturnType<typeof approvedStoryboard>['value']) {
  requireRule(value.mediaType === 'video/webm' && value.renderer === 'PLAYWRIGHT_SEALED_DEMO_V1' && value.narration === 'CAPTIONS_ONLY'
    && value.bytes instanceof Uint8Array && value.bytes.byteLength >= 5 && value.bytes.byteLength <= 25_000_000 && Buffer.from(value.bytes.subarray(0, 4)).toString('hex') === '1a45dfa3'
    && value.sha256 === sha(value.bytes) && equalRef(value.demoRef, bundle.demoRef) && value.documentSha256 === bundle.documentSha256
    && value.sourceBindingDigest === storyboard.sourceBindingDigest && value.captionText === storyboard.shots.map(shot => shot.narration).join('\n')
    && value.width === 1280 && value.height === 720 && Number.isFinite(value.durationSeconds) && value.durationSeconds > 0 && value.durationSeconds <= storyboard.maximumSeconds + .05
    && Number.isSafeInteger(value.networkRequests) && value.networkRequests >= 1, 'ADVISORY_VIDEO_RENDER_PROOF_INVALID');
}

/** No automatic retry for CLAIMED/UNKNOWN jobs, rendering failures or ambiguous completion. */
export function createWebsiteSalesAdvisoryVideoJobRunner<Executor>(ports: AdvisoryVideoWorkerPorts<Executor>) {
  return async function runWebsiteSalesAdvisoryVideoJob(executor: Executor, rawJobId: string): Promise<AdvisoryVideoWorkerOutcome> {
    const jobId = advisoryUuid.parse(rawJobId), time = () => new Date((ports.now ?? Date.now)()).toISOString();
    const before = checkedJob(await ports.read(executor, jobId), jobId);
    if (before.status === 'UNKNOWN') return { jobId, status: 'RECONCILIATION_REQUIRED', resultDigest: before.resultDigest };
    if (before.status === 'CLAIMED') {
      // The native atomic claim transitions an expired lease to UNKNOWN; it never reclaims it.
      await ports.claim(executor, jobId); const current = checkedJob(await ports.read(executor, jobId), jobId); sameJob(before, current);
      return { jobId, status: 'RECONCILIATION_REQUIRED', resultDigest: current.resultDigest };
    }
    if (before.status !== 'READY') return { jobId, status: 'NOT_CLAIMED', resultDigest: before.resultDigest };
    const claimed = await ports.claim(executor, jobId);
    if (!claimed) return { jobId, status: 'NOT_CLAIMED', resultDigest: null };
    checkedJob(claimed, jobId); sameJob(before, claimed);
    requireRule(claimed.status === 'CLAIMED' && claimed.leaseToken && claimed.leaseExpiresAt && Date.parse(claimed.leaseExpiresAt) > Date.parse(time()), 'ADVISORY_VIDEO_LEASE_REQUIRED');
    const leaseToken = claimed.leaseToken;
    const execution: { capture: AdvisoryVideoCapture | null; completionStarted: boolean } = { capture: null, completionStarted: false };
    try {
      return await ports.withActor(executor, jobId, async actor => {
        checkedJob(actor.job, jobId); sameJob(claimed, actor.job);
        requireRule(actor.job.status === 'CLAIMED' && actor.job.leaseToken === leaseToken && await actor.isCurrent(), 'ADVISORY_VIDEO_LEASE_CHANGED');
        const storyboard = approvedStoryboard(actor.job, time());
        const read = async () => { const snapshot = await ports.readDemo(executor, jobId); const bundle = advisoryVideoBundleFromDemo(snapshot, actor.job, storyboard.value.demoRef, time());
          await ports.verifyQa(snapshot.certificate, snapshot.artifact, snapshot.workflowId, snapshot.builderId, time()); return { snapshot, bundle }; };
        const initial = await read(), expected = demoBinding(initial.snapshot, initial.bundle);
        const isCurrent = async () => { try { if (!await actor.isCurrent()) return false; approvedStoryboard(actor.job, time()); const current = await read(); return demoBinding(current.snapshot, current.bundle) === expected; } catch { return false; } };
        const capture = await (ports.render ?? renderWebsiteSalesAdvisoryVideo)(initial.bundle, storyboard.value, { isCurrent }); execution.capture = capture;
        checkedCapture(capture, initial.bundle, storyboard.value);
        requireRule(await isCurrent(), 'ADVISORY_VIDEO_SOURCE_CHANGED_BEFORE_COMPLETE');
        execution.completionStarted = true;
        const completed = checkedJob(await ports.complete(executor, { jobId, leaseToken, contextDigest: claimed.contextDigest, result: null,
          video: { bytes: capture.bytes, mediaType: capture.mediaType, sha256: capture.sha256, durationSeconds: capture.durationSeconds, width: capture.width, height: capture.height,
            captureProof: { storyboardRef: storyboard.reference, demoRef: capture.demoRef, sourceBindingDigest: capture.sourceBindingDigest,
              documentSha256: capture.documentSha256, assetManifestDigest: initial.snapshot.artifact.content.assetManifestDigest,
              qaCertificateId: initial.snapshot.certificate.payload.certificateId, qaSourceRevision: initial.snapshot.certificate.payload.sourceRevision,
              renderer: capture.renderer, narration: capture.narration, captionText: capture.captionText, networkRequests: capture.networkRequests } } }), jobId);
        sameJob(claimed, completed);
        requireRule(completed.status === 'SUCCEEDED' && completed.resultDigest === capture.sha256, 'ADVISORY_VIDEO_COMPLETION_UNCONFIRMED');
        return { jobId, status: 'SUCCEEDED', resultDigest: capture.sha256 };
      });
    } catch {
      const capture = execution.capture;
      if (execution.completionStarted && capture !== null) {
        try { const current = checkedJob(await ports.read(executor, jobId), jobId); sameJob(claimed, current);
          if (current.status === 'SUCCEEDED' && current.resultDigest === capture.sha256) return { jobId, status: 'SUCCEEDED_RECONCILED', resultDigest: capture.sha256 };
        } catch { /* Fresh native reads may be unavailable; retain ambiguity. */ }
      }
      try { await ports.markUnknown(executor, { jobId, leaseToken, contextDigest: claimed.contextDigest, errorCode: 'ADVISORY_VIDEO_WORKER_OUTCOME_UNKNOWN' }); } catch { /* A revoked lease cannot be replaced or retried by this worker. */ }
      return { jobId, status: 'UNKNOWN', resultDigest: null };
    }
  };
}
