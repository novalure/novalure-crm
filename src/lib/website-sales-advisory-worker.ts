import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { advisoryAdviceDraftSchema, advisoryAdviceInputSchema, advisoryAssertionSchema, advisoryGroundedFactSchema,
  advisoryKnowledgeSchema, advisoryRecordSchema, advisoryRoleplayInputSchema, advisoryTranscriptSchema } from './website-sales-advisory-types';
import { runWebsiteSalesAdvisoryModel, type AdvisoryModelInput, type AdvisoryModelPorts, type AdvisoryModelResult } from './website-sales-advisory-model';
import { claimWebsiteSalesAdvisoryJob, completeWebsiteSalesAdvisoryJob, listDueWebsiteSalesAdvisoryJobs, readWebsiteSalesAdvisoryJob,
  markWebsiteSalesAdvisoryJobUnknown, withWebsiteSalesAdvisoryExecutorActor,
  type FrozenAdvisoryJob, type WebsiteSalesAdvisoryExecutor } from './db/website-sales-advisory-jobs';
import { areQueueWorkersPaused } from './cron/runtime';

/** No free-form provider output is ever passed through as a customer fact or commitment. */
export function advisoryJobModelInput(job: FrozenAdvisoryJob): AdvisoryModelInput {
  const context = job.frozenContext;
  const base = { requestId: job.id, identity: job.identity, workflowId: job.workflowId, sources: [], segments: [], scenario: null };
  if (job.kind === 'ADVICE') {
    const request = advisoryAdviceInputSchema.parse(context.request);
    const facts = z.array(advisoryGroundedFactSchema).max(200).parse(context.facts);
    // Keep complete exact excerpts and their positions; shared evidence references can contain different facts.
    const selected = facts.filter(f => request.factRefs.some(r => r.id === f.evidenceRef.id && r.version === f.evidenceRef.version && r.digest === f.evidenceRef.digest)).slice(0, 20);
    return { ...base, kind: 'ADVICE', question: request.question, sources: selected.map(f => ({ ref: f.evidenceRef, text: f.text })) };
  }
  if (job.kind === 'TRANSCRIPT_ANALYSIS') {
    const transcript = advisoryRecordSchema.parse(context.transcript), body = advisoryTranscriptSchema.parse(transcript.payload);
    return { ...base, kind: 'TRANSCRIPT_ANALYSIS', question: 'Find exact customer needs, constraints, questions and possible commitments for human review.', segments: body.segments };
  }
  if (job.kind === 'ROLEPLAY') {
    const request = advisoryRoleplayInputSchema.parse(context.request), knowledge = advisoryRecordSchema.parse(context.knowledge);
    const body = advisoryKnowledgeSchema.parse(knowledge.payload), scenario = body.scenarios.find(s => s.id === request.scenarioId);
    if (!scenario) throw Error('ADVISORY_ROLEPLAY_SCENARIO_REQUIRED');
    const previous = context.previousRoleplay === undefined ? null : advisoryRecordSchema.parse(context.previousRoleplay);
    const previousValue = previous?.payload.value;
    const previousReply = previousValue && typeof previousValue === 'object' && 'customerReply' in previousValue ? String(previousValue.customerReply) : null;
    return { ...base, kind: 'ROLEPLAY', question: request.sellerReply ?? scenario.customerOpening,
      sources: [{ ref: { id: knowledge.id, version: knowledge.version, digest: knowledge.digest }, text: body.content }],
      scenario: { situation: scenario.situation, opening: scenario.customerOpening, previousCustomerTurn: previousReply } };
  }
  throw Error('ADVISORY_MODEL_JOB_KIND_DENIED');
}

export function advisoryJobCandidate(job: FrozenAdvisoryJob, input: AdvisoryModelInput, output: AdvisoryModelResult): unknown {
  if (output.status !== 'READY') throw Error('ADVISORY_MODEL_RESULT_NOT_READY');
  if (job.kind === 'ADVICE') {
    const facts = z.array(advisoryGroundedFactSchema).parse(job.frozenContext.facts);
    const claims = output.selectedSourceIndices.map(index => {
      const source = input.sources[index];
      const fact = source && facts.find(f => f.text === source.text && f.evidenceRef.id === source.ref.id
        && f.evidenceRef.version === source.ref.version && f.evidenceRef.digest === source.ref.digest);
      if (!fact) throw Error('ADVISORY_SELECTED_FACT_CHANGED');
      return { factId: fact.id, exactQuote: source.text, explanation: 'Wörtlicher Auszug aus der freigegebenen Quelle; vor Veröffentlichung prüfen.' };
    });
    return advisoryAdviceDraftSchema.parse({ summary: output.text, claims, questions: [],
      limitations: ['Dieser Entwurf ist keine verbindliche Zusage und benötigt eine gesonderte Prüfung und Freigabe.'], humanReviewRequired: true });
  }
  if (job.kind === 'TRANSCRIPT_ANALYSIS') return output.assertions.map((assertion, index) => {
    const hex = createHash('sha256').update(JSON.stringify({ jobId: job.id, index, assertion })).digest('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return advisoryAssertionSchema.parse({ id, text: assertion.exactQuote, segmentIds: [assertion.segmentId], exactQuotes: [assertion.exactQuote], kind: assertion.kind });
  });
  if (job.kind === 'ROLEPLAY' && output.text) return { customerReply: output.text };
  throw Error('ADVISORY_GENERATED_RESULT_DENIED');
}

export interface AdvisoryWorkerOptions {
  executor: WebsiteSalesAdvisoryExecutor;
  /** Host-only test/provider dependencies; never read from an HTTP body. */
  modelPorts?: Omit<AdvisoryModelPorts, 'isCurrent' | 'actorAuthority'>;
}
export async function runWebsiteSalesAdvisoryModelJob(options: AdvisoryWorkerOptions, jobId: string) {
  if (areQueueWorkersPaused()) return { jobId, status: 'PAUSED' as const };
  if ((await readWebsiteSalesAdvisoryJob(options.executor, jobId)).kind === 'VIDEO') throw Error('ADVISORY_VIDEO_REQUIRES_DEDICATED_BROWSER_WORKER');
  const claimed = await claimWebsiteSalesAdvisoryJob(options.executor, jobId);
  if (!claimed) return { jobId, status: 'NOT_CLAIMED' as const };
  const leaseToken = claimed.leaseToken;
  if (!leaseToken) throw Error('ADVISORY_LEASE_REQUIRED');
  try {
    return await withWebsiteSalesAdvisoryExecutorActor(options.executor, jobId, async ({ session, job, isCurrent }) => {
      const input = advisoryJobModelInput(job);
      const current = async () => !areQueueWorkersPaused() && await isCurrent();
      const output = await runWebsiteSalesAdvisoryModel(session, input, { ...options.modelPorts, isCurrent: current,
        actorAuthority: { kind: 'BOUND_SALES_ADVISORY_EXECUTOR', isCurrentActor: async actor => actor === session && await current() } });
      if (output.status !== 'READY') {
        await markWebsiteSalesAdvisoryJobUnknown(options.executor, { jobId, leaseToken, contextDigest: job.contextDigest, errorCode: output.reason });
        return { jobId, status: 'UNKNOWN' as const, code: output.reason };
      }
      const completed = await completeWebsiteSalesAdvisoryJob(options.executor, { jobId, leaseToken, contextDigest: job.contextDigest,
        result: advisoryJobCandidate(job, input, output), providerReference: `model:${output.model}:${output.requestId}` });
      return { jobId, status: completed.status };
    });
  } catch {
    // No automatic replay after a possibly charged call or a lost completion acknowledgement.
    try { await markWebsiteSalesAdvisoryJobUnknown(options.executor, { jobId, leaseToken, contextDigest: claimed.contextDigest, errorCode: 'ADVISORY_WORKER_OUTCOME_UNCONFIRMED' }); } catch { /* database lease expiry also becomes UNKNOWN */ }
    return { jobId, status: 'UNKNOWN' as const, code: 'ADVISORY_WORKER_OUTCOME_UNCONFIRMED' };
  }
}

export async function runWebsiteSalesAdvisoryWorker(options: AdvisoryWorkerOptions, maximum = 1) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 5) throw Error('ADVISORY_WORKER_LIMIT_INVALID');
  const rows = await listDueWebsiteSalesAdvisoryJobs(options.executor, maximum), results = [];
  for (const row of rows) {
    if (areQueueWorkersPaused()) break;
    if (row.kind !== 'VIDEO') results.push(await runWebsiteSalesAdvisoryModelJob(options, row.id));
  }
  return results;
}
