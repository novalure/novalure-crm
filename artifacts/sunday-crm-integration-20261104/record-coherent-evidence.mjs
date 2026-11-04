import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const base = '80de72a4fb92befa73128aaa7d801adc35c7fd1d';
const source = '19af886e81362b6acd3cbd463e428b2c678f2236';
const serverStart = 'b58071ace04e2bca2bf8b9bec5a71cdc7f3779ce';
const directory = 'artifacts/sunday-crm-integration-20261104/coherent-final';
const hash = value => createHash('sha256').update(value).digest('hex');
const git = args => execFileSync('git', args);
assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), source);
const runs = [];
for (const label of ['server', 'helper', 'outputs', 'media-191', 'direct-browser', 'parent-browser', 'typecheck', 'affected-lint', 'build']) {
  const file = `${directory}/${label}.log`, bytes = await readFile(file), text = bytes.toString();
  assert.match(text, /LOCAL_CHILD_EXIT=0\s*$/);
  const raw = { schemaVersion: 1, type: 'EXACT_CONSOLE_OUTPUT_LOSSLESS_TRANSPORT', encoding: 'base64',
    sourceRevision: source, ...(label === 'server' ? { executionStartedAtRevision: serverStart,
      qualification: 'Server sources unchanged through19af; only the separate parent-browser test changed while this run completed.' } : {}),
    originalPath: file, originalBytes: bytes.length, originalSha256: hash(bytes), dataBase64: bytes.toString('base64') };
  const transport = `${directory}/${label}.raw.json`;
  await writeFile(transport, JSON.stringify(raw, null, 2) + '\n', { flag: 'wx' });
  const counts = text.match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)[\s\S]*?ℹ skipped (\d+)/);
  if (counts) { assert.equal(Number(counts[3]), 0); assert.equal(Number(counts[4]), 0); }
  runs.push({ label, exitCode: 0, sourceRevision: source, transport, originalSha256: hash(bytes),
    ...(label === 'server' ? { executionStartedAtRevision: serverStart,
      qualification: 'Unchanged server suite and runtime-source closure reused through19af; not a second execution.' } : {}),
    ...(counts ? { tests: +counts[1], passed: +counts[2], failed: +counts[3], skipped: +counts[4] } : {}) });
}
for (const [from, name, count] of [
  ['.npm-cache/qa/property-direct-create/results.json', 'direct-browser-results.json', 18],
  ['.npm-cache/qa/crm-core-refresh/results.json', 'parent-browser-results.json', 7],
]) {
  const json = JSON.parse(await readFile(from));
  assert.equal(json.results.length, count); assert.ok(json.results.every(row => row.status === 'PASS'));
  assert.deepEqual(json.browserErrors, []); assert.equal(json.databaseIntegration, false);
  await copyFile(from, `${directory}/${name}`);
  Object.assign(runs.find(r => r.label === (count === 18 ? 'direct-browser' : 'parent-browser')), { cases: count, passed: count,
    browserErrors: 0, syntheticHttp: true, databaseIntegration: false, report: `${directory}/${name}` });
}
await copyFile('.npm-cache/qa/property-public-output/verification.json', `${directory}/outputs-verification.json`);
const files = [];
for (const name of (await readdir('.npm-cache/qa/property-public-output')).filter(name => /\.(pdf|html)$/.test(name)).sort()) {
  const file = `.npm-cache/qa/property-public-output/${name}`, bytes = await readFile(file);
  files.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
}
const output = JSON.parse(await readFile(`${directory}/outputs-verification.json`));
assert.equal(output.generated.length, 24); assert.equal(output.generated.reduce((n, row) => n + row.pages, 0), 54);
assert.equal(files.filter(f => f.path.endsWith('.html')).length, 12);
const changedFiles = git(['diff', '--name-only', base, source]).toString().trim().split('\n');
const sourceFiles = changedFiles.filter(file => file.startsWith('src/') || file.startsWith('migrations/'));
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(git(['show', `${source}:${file}`]))]));
const reviewPath = 'artifacts/sunday-crm-integration-20261104/root-independent-review-19af886e.json';
const review = JSON.parse(await readFile(reviewPath)); assert.equal(review.head, source); assert.equal(review.base, base);
assert.deepEqual(review.findings, { critical: 0, high: 0, medium: 0, low: 0 });
const result = { schemaVersion: 1, recordedAtUtc: new Date().toISOString(), status: 'LOCAL_COHERENT_SOURCE_AND_TARGETED_CANDIDATE_CHECKS_COMPLETE_EXTERNAL_GATES_OPEN',
  base, sourceRevision: source, sourceHashes, changedFiles,
  qualification: 'Exact candidate local source checks; new disposable loopback PostgreSQL clusters and synthetic tenants, actual components/parent with synthetic HTTP, generated PDF bytes. No live or production acceptance.',
  authority: 'PARENT_EXPLICIT_LOCAL_INTEGRATION_ONLY',
  cherryPicks: git(['log', '--reverse', '--format=%H%x09%s', `${base}..${source}`]).toString().trim().split('\n'),
  conflict: 'Only050d58a crm-workspace conflict: retain existing URL-restoration useCallback, explicit-null All and replaceHistory; add begin/complete/fail switch tickets and guard dependency. No duplicate handler. Dedicated seventh actual-parent case verifies guarded URL restoration.',
  isolation: { parentEnvironment: 'PLATFORM_ALLOWLIST_ONLY_NO_CREDENTIALS_OR_DATABASE_URL_INHERITED', nodeEgress: 'LOOPBACK_SOCKET_PRELOAD_INHERITED_BY_NODE_CHILDREN',
    runner: 'artifacts/sunday-crm-integration-20261104/run-isolated-local.mjs', guard: 'artifacts/sunday-crm-integration-20261104/loopback-only.mjs',
    fixtureLimits: 'Partial historical schemas, unchanged exclusions. Media group combines092-096/121/189/191; output group applies106+155/163/166/190, not a complete production-upgrade rehearsal.' },
  runs, outputs: { generatedPdfs: 24, parsedPages: 54, generatedHtml: 12, developerZeroPdfByteControls: 'asking/public/rent exact SourceSQL to PDF; unconfirmed and mismatched denied, confirmed and nondeveloper controls retained',
    report: `${directory}/outputs-verification.json`, reportBaseField: 'Historical fixture base11c4384c, not the current execution revision', files,
    visualQualification: 'Current bytes parsed and asserted; no new independent visual or live-browser PDF-layout acceptance claimed.' },
  preserved: ['PR129 invitation/message authority fences', 'Current bb8 assistant and migration188', 'Current commercial billing/navigation', 'Media189 plus exact owner dependency191', 'Existing workspace settings and authorized URL restoration', 'Package/lock/deployment/workflows unchanged'],
  excludedDuplicateCommits: ['6330b449', '3a28f879', '8939a4b', '0bb165a'],
  independentSourceReview: { path: reviewPath, sha256: hash(await readFile(reviewPath)), scope: review.reviewScope, findings: review.findings, genuineApp: false },
  historicalFailures: 'All original donor/QA failures and prior8/9 scope-string failure remain unchanged. No failures occurred in the current targeted candidate runs; old failing evidence is not relabelled.',
  lifecycle: 'Former SRC05 pending-ref/remount and late-parent-refresh source findings addressed within the passing18 direct-component and7 actual-parent local cases. This is bounded synthetic HTTP qualification, not a global/live SRC05 acceptance.',
  open: ['Independent review applies only to this exact local source delta; no genuine App or native CI attestation', 'Full production role/schema/identity/business-flow acceptance and actual target gates', 'Complete production migration rehearsal; 189/190/191 have not been applied to production', 'Historical published snapshots require supported review and republish/revoke; no retrospective repair', 'Existing live QA residue groups and untested matrix remain outside this task', 'Commercial and financial authority for future real provider actions'],
  realEffects: { providerCalls: 0, modelCalls: 0, appCalls: 0, productionDatabaseConnections: 0, productionMigrations: 0, customerWrites: 0, pushes: 0, pullRequests: 0, deployments: 0, budgetChanges: 0 }
};
await writeFile(`${directory}/completion.json`, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
