/** Server-only composition for the dedicated, checkout-attested Node process. */
import 'server-only';
import { readWebsiteSalesAdvisoryJob, claimWebsiteSalesAdvisoryJob, withWebsiteSalesAdvisoryExecutorActor,
  readWebsiteSalesAdvisoryDemo, completeWebsiteSalesAdvisoryJob, markWebsiteSalesAdvisoryJobUnknown,
  type WebsiteSalesAdvisoryExecutor } from '../src/lib/db/website-sales-advisory-jobs';
import { verifyWebsiteStudioQaCertificate } from '../src/lib/website-sales-studio-qa';
import { createWebsiteSalesAdvisoryVideoJobRunner } from './website-sales-advisory-video-worker';

export const runWebsiteSalesAdvisoryVideoJob = createWebsiteSalesAdvisoryVideoJobRunner<WebsiteSalesAdvisoryExecutor>({
  read: readWebsiteSalesAdvisoryJob,
  claim: claimWebsiteSalesAdvisoryJob,
  withActor: (executor, id, run) => withWebsiteSalesAdvisoryExecutorActor(executor, id, actor => run({ job: actor.job, isCurrent: actor.isCurrent })),
  readDemo: readWebsiteSalesAdvisoryDemo,
  verifyQa: (certificate, artifact, workflowId, builderId, now) => { verifyWebsiteStudioQaCertificate(certificate, artifact, workflowId, builderId, now); },
  complete: completeWebsiteSalesAdvisoryJob,
  markUnknown: markWebsiteSalesAdvisoryJobUnknown,
});
