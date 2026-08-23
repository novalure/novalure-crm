#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { validatePreviewShareUrl } from "./qa-two-tenant-e2e.mjs";
import { parseQaTwoTenantConfig } from "./lib/qa-two-tenant-matrix.mjs";

const workflowConfirmation = "RUN_EXACT_PROTECTED_PREVIEW_QA";
const workflowEnvironment = "go-live-preview";
const productionOrigin = "https://www.novalure-crm.app";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required; protected Preview QA is fail-closed.`);
  return value;
}

export function validateProtectedPreviewWorkflowContract(env = process.env, options = {}) {
  if (required(env, "GITHUB_EVENT_NAME") !== "workflow_dispatch") {
    throw new Error("Protected Preview QA is available only through workflow_dispatch.");
  }
  if (required(env, "NOVALURE_WORKFLOW_ENVIRONMENT") !== workflowEnvironment) {
    throw new Error("Protected Preview QA must use the go-live-preview GitHub Environment.");
  }
  if (required(env, "NOVALURE_WORKFLOW_CONFIRMATION") !== workflowConfirmation) {
    throw new Error(`NOVALURE_WORKFLOW_CONFIRMATION must equal ${workflowConfirmation}.`);
  }

  const expected = Object.freeze({
    branchId: required(env, "NOVALURE_WORKFLOW_NEON_BRANCH_ID"),
    candidateBranch: required(env, "NOVALURE_WORKFLOW_CANDIDATE_BRANCH"),
    candidateSha: required(env, "NOVALURE_WORKFLOW_CANDIDATE_SHA").toLowerCase(),
    deploymentId: required(env, "NOVALURE_WORKFLOW_DEPLOYMENT_ID"),
    githubRef: required(env, "GITHUB_REF"),
    githubRepository: required(env, "GITHUB_REPOSITORY"),
    githubSha: required(env, "GITHUB_SHA").toLowerCase(),
    githubWorkflowRef: required(env, "GITHUB_WORKFLOW_REF"),
    previewHost: required(env, "NOVALURE_WORKFLOW_PREVIEW_HOST").toLowerCase(),
    previewOrigin: required(env, "NOVALURE_WORKFLOW_PREVIEW_ORIGIN"),
    projectId: required(env, "NOVALURE_WORKFLOW_NEON_PROJECT_ID"),
    trustedHarnessSha: required(env, "NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA").toLowerCase(),
    trustedHarnessShaInput: required(env, "NOVALURE_WORKFLOW_TRUSTED_HARNESS_SHA_INPUT").toLowerCase(),
  });
  if (!/^[a-f0-9]{40}$/u.test(expected.candidateSha)) {
    throw new Error("The remote candidate must use one exact lowercase candidate SHA.");
  }
  if (
    !/^[a-f0-9]{40}$/u.test(expected.trustedHarnessSha)
    || expected.trustedHarnessShaInput !== expected.trustedHarnessSha
    || expected.githubSha !== expected.trustedHarnessSha
    || expected.githubRef !== "refs/heads/main"
    || expected.githubWorkflowRef
      !== `${expected.githubRepository}/.github/workflows/livegang-e2e.yml@refs/heads/main`
  ) {
    throw new Error("The action must execute from the exact protected-main trusted harness commit.");
  }
  if (!/^codex\/[A-Za-z0-9._/-]{1,220}$/u.test(expected.candidateBranch)) {
    throw new Error("The candidate branch must be an explicit codex/ Preview branch.");
  }
  if (!/^dpl_[A-Za-z0-9]{20,80}$/u.test(expected.deploymentId)) {
    throw new Error("The workflow deployment id must be an exact Vercel deployment id.");
  }

  let preview;
  try {
    preview = new URL(expected.previewOrigin);
  } catch {
    throw new Error("The workflow Preview origin is invalid.");
  }
  if (
    preview.origin !== expected.previewOrigin
    || preview.protocol !== "https:"
    || preview.hostname !== expected.previewHost
    || !preview.hostname.endsWith(".vercel.app")
    || preview.username
    || preview.password
    || preview.pathname !== "/"
    || preview.search
    || preview.hash
  ) {
    throw new Error("The workflow Preview origin and host must identify one exact HTTPS Vercel deployment.");
  }
  if (new Set(["novalure-crm.app", "www.novalure-crm.app"]).has(preview.hostname)) {
    throw new Error("Production origin is forbidden for protected Preview QA.");
  }

  const config = parseQaTwoTenantConfig(env, { requireExecution: true });
  if (
    config.baseUrl !== expected.previewOrigin
    || config.productionOrigin !== productionOrigin
    || config.expectedDeploymentId !== expected.deploymentId
    || config.expectedGitBranch !== expected.candidateBranch
    || config.expectedGitSha !== expected.candidateSha
    || config.database.projectId !== expected.projectId
    || config.database.branchId !== expected.branchId
    || config.database.role !== "novalure_app"
  ) {
    throw new Error("The encrypted QA bundle does not match the dispatched deployment, commit, or Neon target.");
  }

  const shareUrl = validatePreviewShareUrl(
    options.shareUrl ?? required(env, "NOVALURE_QA_VERCEL_SHARE_URL"),
    config.baseUrl,
  );
  if (shareUrl.origin !== expected.previewOrigin) {
    throw new Error("The Vercel Share URL must be scoped directly to the exact Preview deployment origin.");
  }

  return Object.freeze({
    branchId: config.database.branchId,
    candidateBranch: config.expectedGitBranch,
    candidateSha: config.expectedGitSha,
    deploymentId: config.expectedDeploymentId,
    previewHost: preview.hostname,
    projectId: config.database.projectId,
    trustedHarnessSha: expected.trustedHarnessSha,
    workflowRef: expected.githubWorkflowRef,
  });
}

const directEntrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (directEntrypoint) {
  try {
    validateProtectedPreviewWorkflowContract();
    console.log("PROTECTED_PREVIEW_WORKFLOW_CONTRACT_OK");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Protected Preview workflow contract failed.");
    process.exitCode = 1;
  }
}
