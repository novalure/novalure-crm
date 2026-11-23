import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const advisoryVideoWorkerUsage = 'node --conditions=react-server --import tsx scripts/website-sales-advisory-video-worker-cli.mjs --profile <UUID> --job <UUID>';
export function parseAdvisoryVideoWorkerArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length !== 4) throw Error('ADVISORY_VIDEO_WORKER_ARGUMENTS_REQUIRED');
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!['--profile', '--job'].includes(flag) || values.has(flag) || !uuid.test(value ?? '')) throw Error('ADVISORY_VIDEO_WORKER_ARGUMENTS_INVALID');
    values.set(flag, value.toLowerCase());
  }
  if (values.size !== 2) throw Error('ADVISORY_VIDEO_WORKER_ARGUMENTS_REQUIRED');
  return { help: false, profileId: values.get('--profile'), jobId: values.get('--job') };
}
async function nativePorts() {
  const host = await import('../src/lib/website-sales-advisory-host.ts');
  const worker = await import('./website-sales-advisory-video-worker-native.ts');
  return { configuredExecutor: host.configuredAdvisoryExecutor, close: host.closeAdvisoryExecutorPool, runJob: worker.runWebsiteSalesAdvisoryVideoJob };
}
/** The only production selector is an already configured fixed profile. No caller URLs, modules or credentials. */
export async function runAdvisoryVideoWorkerCli(args, load = nativePorts) {
  const selected = parseAdvisoryVideoWorkerArguments(args);
  if (selected.help) return { exitCode: 0, output: advisoryVideoWorkerUsage };
  const ports = await load();
  try {
    const executor = await ports.configuredExecutor(selected.profileId, 'CHECKED_OUT_NODE');
    const result = await ports.runJob(executor, selected.jobId);
    if (result.jobId !== selected.jobId || !['NOT_CLAIMED', 'RECONCILIATION_REQUIRED', 'SUCCEEDED', 'SUCCEEDED_RECONCILED', 'UNKNOWN'].includes(result.status)) throw Error('ADVISORY_VIDEO_WORKER_RESULT_INVALID');
    return { exitCode: ['UNKNOWN', 'RECONCILIATION_REQUIRED'].includes(result.status) ? 2 : 0,
      output: JSON.stringify({ runtime: 'CHECKED_OUT_NODE', jobId: result.jobId, status: result.status, resultDigest: result.resultDigest }) };
  } finally { await ports.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const result = await runAdvisoryVideoWorkerCli(process.argv.slice(2)); process.stdout.write(result.output + '\n'); process.exitCode = result.exitCode; }
  catch { process.stderr.write('The video job could not be confirmed. Check the configured profile, current authority and original job status.\n'); process.exitCode = 1; }
}
