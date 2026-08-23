import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function assertImmutableActions(workflow) {
  const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gmu)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  for (const reference of uses) assert.match(reference, /^[^@\s]+@[a-f0-9]{40}$/u);
}

function assertProtectedAttestationProducer(workflow) {
  assert.match(
    workflow,
    /permissions:\s*\n\s+attestations: write\s*\n\s+contents: read\s*\n\s+id-token: write/u,
    "PROTECTED_WORKFLOW_OIDC_PERMISSION_REQUIRED",
  );
  assert.equal(
    (workflow.match(/\bid-token: write\b/gu) ?? []).length,
    2,
    "PROTECTED_WORKFLOW_OIDC_PERMISSION_MUST_BE_MINIMAL",
  );
  assert.equal(
    (workflow.match(/\battestations: write\b/gu) ?? []).length,
    2,
    "PROTECTED_WORKFLOW_ATTESTATION_PERMISSION_MUST_BE_MINIMAL",
  );
  assert.doesNotMatch(
    workflow,
    /\b(?:artifact-metadata|packages|pull-requests): write\b/u,
    "PROTECTED_WORKFLOW_UNNECESSARY_WRITE_PERMISSION",
  );
  assert.equal(
    (workflow.match(/uses: actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6\s+# v4\.2\.0/gu) ?? []).length,
    2,
    "PROTECTED_WORKFLOW_PINNED_ATTESTATION_PRODUCER_REQUIRED",
  );
  assert.match(workflow, /subject-path:\s*\$\{\{ steps\.provenance_subject\.outputs\.artifact_path \}\}/u);
  assert.match(workflow, /steps\.github_attestation\.outputs\.bundle-path/u);
  assert.match(workflow, /github-artifact-attestation\.sigstore\.json/u);
  assert.match(workflow, /protected-workflow-artifact-manifest\.json/u);
  assert.match(workflow, /--format=posix/u);
  assert.match(workflow, /--sort=name/u);
  assert.match(workflow, /protected-preview-public-runtime:/u, "PROTECTED_PUBLIC_PRODUCER_JOB_REQUIRED");
  assert.match(
    workflow,
    /node scripts\/qa-protected-public-action-runner\.mjs/u,
    "PROTECTED_PUBLIC_PRODUCER_RUNNER_REQUIRED",
  );
  assert.match(workflow, /NOVALURE_QA_PUBLIC_RUNTIME_INPUT_B64:\s*\$\{\{ secrets\.NOVALURE_QA_PUBLIC_RUNTIME_INPUT_B64 \}\}/u);
  assert.match(workflow, /NOVALURE_WORKFLOW_PUBLIC_BATCH_POLICY:\s*fresh-deployment-bound-single-use-v1/u);
  assert.match(workflow, /Require two fresh deployment-bound single-use batches and run Public Preview QA/u);
  assert.match(workflow, /path: candidate\s*\n\s+persist-credentials: false\s*\n\s+ref:\s*\$\{\{ inputs\.candidate_branch \}\}/u);
  assert.match(workflow, /git -C "\$NOVALURE_PUBLIC_CANDIDATE_ROOT" rev-parse HEAD/u);
  assert.match(workflow, /NOVALURE_WORKFLOW_CANDIDATE_SHA/u);
  assert.match(workflow, /recordType: "NOVALURE_PUBLIC_RUNTIME_ARTIFACT_MANIFEST"/u);
  assert.match(workflow, /github-public-runtime-attestation\.sigstore\.json/u);
  assert.match(workflow, /exact-preview-public-runtime-\$\{\{ inputs\.candidate_sha \}\}/u);
  for (const name of [
    "funnel-publish-token-rotation.json",
    "public-form-funnel-cleanup.json",
    "public-form-live-submission.json",
    "public-form-long-proof-refresh.json",
    "public-funnel-live-submission.json",
    "public-funnel-long-proof-refresh.json",
  ]) {
    assert.match(workflow, new RegExp(name.replaceAll(".", "\\."), "u"));
  }
}

test("automatic PR and push quality workflow has separate read-only gates", () => {
  const workflow = read("../.github/workflows/quality-gates.yml");
  assert.match(workflow, /^on:\s*\n\s+pull_request:\s*\n\s+push:/mu);
  assert.match(workflow, /^permissions:\s*\n\s+contents: read/mu);
  assert.doesNotMatch(workflow, /workflow_dispatch|environment:|secrets\.|NOVALURE_QA_|VERCEL_|deploy|promot|reset/i);
  for (const contract of [
    "gate: Lint",
    "gate: Typecheck",
    "gate: Unit and contract tests",
    "gate: Integration tests",
    "gate: Production build",
    "production-sca:",
    "baseline-license-policy:",
    "dependency-review:",
    "sast:",
    "sbom:",
  ]) assert.match(workflow, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  assert.match(workflow, /node-version-file: \.node-version/u);
  assert.match(workflow, /package-manager-cache: false/u);
  assert.match(workflow, /npm ci/u);
  assert.match(workflow, /npm audit --omit=dev --audit-level=moderate/u);
  assert.match(workflow, /node scripts\/dependency-license-policy\.mjs/u);
  assert.match(workflow, /github\/codeql-action\/init@[a-f0-9]{40}/u);
  assert.match(workflow, /github\/codeql-action\/analyze@[a-f0-9]{40}/u);
  assert.match(workflow, /actions\/dependency-review-action@[a-f0-9]{40}/u);
  assert.match(workflow, /security-events: write/u);
  assert.match(workflow, /npm sbom --sbom-format=cyclonedx/u);
  assertImmutableActions(workflow);
});

test("manual protected E2E keeps secrets fileless and uploads an immutable attested evidence subject", () => {
  const workflow = read("../.github/workflows/livegang-e2e.yml");
  const runner = read("./qa-protected-preview-action-runner.mjs");
  const attestation = read("./final-preview-release-attestation-contract.mjs");
  assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:/mu);
  assert.match(workflow, /environment: go-live-preview/u);
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.trusted_harness_sha \}\}/u);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{ inputs\.candidate_sha \}\}/u);
  assert.match(workflow, /GITHUB_WORKFLOW_REF[\s\S]*refs\/heads\/main/u);
  assert.match(workflow, /vars\.NOVALURE_QA_TRUSTED_HARNESS_SHA/u);
  assert.match(workflow, /node scripts\/qa-protected-preview-action-runner\.mjs/u);
  assert.match(workflow, /NOVALURE_QA_TWO_TENANT_ENV_B64:\s*\$\{\{ secrets\.NOVALURE_QA_TWO_TENANT_ENV_B64 \}\}/u);
  assert.match(workflow, /NOVALURE_QA_VERCEL_SHARE_URL:\s*\$\{\{ secrets\.NOVALURE_QA_VERCEL_SHARE_URL \}\}/u);
  assert.doesNotMatch(workflow, /base64\s+--decode|--env-file|GITHUB_ENV|\.env\.qa-two-tenant/u);
  assert.doesNotMatch(workflow, /path:\s*artifacts\/qa|path:\s*\$\{\{[^\n]+\}\}\s*\n\s*if-no-files-found: warn/u);
  for (const name of [
    "preflight-two-tenant-e2e.json",
    "preflight-two-tenant-e2e.sha256",
    "execute-two-tenant-e2e.json",
    "execute-two-tenant-e2e.sha256",
  ]) {
    assert.equal((workflow.match(new RegExp(name.replaceAll(".", "\\."), "gu")) ?? []).length >= 2, true);
  }
  assert.match(workflow, /find "\$EVIDENCE_ROOT"[^\n]+-type f -links 1/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assertProtectedAttestationProducer(workflow);
  for (const provenanceName of [
    "protected-workflow-artifact-manifest.json",
    "github-artifact-attestation.sigstore.json",
    "artifact_sha256_path",
    "manifest_sha256_path",
    "bundle_sha256_path",
  ]) assert.match(workflow, new RegExp(provenanceName.replaceAll(".", "\\."), "u"));
  assert.match(runner, /parseEnv\(source\)/u);
  assert.match(runner, /decoded\.fill\(0\)/u);
  assert.match(runner, /qaProtectedActionBundleAllowedNames/u);
  assert.match(runner, /qaProtectedActionChildEnvironmentNames/u);
  assert.match(runner, /O_NOFOLLOW/u);
  assert.match(runner, /nlink !== 1/u);
  assert.doesNotMatch(runner, /NOVALURE_QA_TWO_TENANT_ENV_B64[^\n]*(?:writeFile|appendFile|open\()/u);
  const publicRunner = read("./qa-protected-public-action-runner.mjs");
  assert.match(publicRunner, /crossTenantBatchId:\s*parsed\.crossTenantBatchId/u);
  assert.match(publicRunner, /fresh-deployment-bound-single-use-v1/u);
  assert.match(publicRunner, /PROTECTED_PUBLIC_BATCH_POLICY_INVALID/u);
  assert.match(attestation, /workflowTrust\.trustedHarnessSha === runtime\.trustedHarnessSha/u);
  assert.match(attestation, /FINAL_ATTESTATION_TWO_TENANT_TRUSTED_WORKFLOW_RECEIPT_INVALID/u);
  assertImmutableActions(workflow);
});

test("protected workflow contract rejects a missing OIDC permission or attestation producer", () => {
  const workflow = read("../.github/workflows/livegang-e2e.yml");
  assert.throws(
    () => assertProtectedAttestationProducer(workflow.replace("id-token: write", "id-token: read")),
    /PROTECTED_WORKFLOW_OIDC_PERMISSION_MUST_BE_MINIMAL/u,
  );
  assert.throws(
    () => assertProtectedAttestationProducer(
      workflow.replace(
        "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6 # v4.2.0",
        "actions/attest@v4",
      ),
    ),
    /PROTECTED_WORKFLOW_PINNED_ATTESTATION_PRODUCER_REQUIRED/u,
  );
  assert.throws(
    () => assertProtectedAttestationProducer(
      workflow.replace(
        "uses: actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6 # v4.2.0",
        "run: echo producer-removed",
      ),
    ),
    /PROTECTED_WORKFLOW_PINNED_ATTESTATION_PRODUCER_REQUIRED/u,
  );
  assert.throws(
    () => assertProtectedAttestationProducer(
      workflow.replace(
        "node scripts/qa-protected-public-action-runner.mjs",
        "node scripts/public-runtime-preview-e2e.mjs",
      ),
    ),
    /PROTECTED_PUBLIC_PRODUCER_RUNNER_REQUIRED/u,
  );
});
