import assert from "node:assert/strict";
import test from "node:test";
import { vercelDeploymentEvidence, cleanupTarget } from "./qa-g27-live-preview.mjs";
import { exactProbeResults, previewAccessHeaders } from "./qa-g27-isolation-probe.mjs";
import { verifyCrmBrowserBinding, crmBrowserOrigin } from "./lib/g27-preview-access.mjs";

test("cleanup permits only the exact schema-only Evelyn branch with absent lineage and pinned schema source", () => {
  const oldKey = process.env.G27_EVELYN_NEON_API_KEY, oldProject = process.env.G27_EVELYN_NEON_PROJECT_ID;
  process.env.G27_EVELYN_NEON_API_KEY = "synthetic-test-only";
  process.env.G27_EVELYN_NEON_PROJECT_ID = "super-block-59791927";
  const target = { system: "evelyn", provider: "neon", environment: "preview", disposable: true,
    projectId: "super-block-59791927", branchId: "br-young-water-awa2ri4k", branchName: "evelyn-g27-qa-20260924",
    parentBranchId: null, parentBranchName: null, schemaSourceBranchId: "br-dry-thunder-awmimouk",
    schemaSourceBranchName: "main", createdAt: "2026-09-24T12:09:41Z", apiKeyEnv: "G27_EVELYN_NEON_API_KEY" }; // gitleaks:allow -- environment variable name, not a credential
  const publicTarget = Object.fromEntries(Object.entries(target).filter(([key]) => !["environment", "disposable", "apiKeyEnv"].includes(key)));
  const prior = { cleanup: { targets: [publicTarget] } };
  const preseed = { database: { evelynProjectId: target.projectId, evelynBranchId: target.branchId, evelynParentBranchId: null } };
  try {
    assert.equal(cleanupTarget(target, prior, preseed).schemaOnly, true);
    for (const change of [{ branchId: "br-other" }, { projectId: "production-project" },
      { schemaSourceBranchId: "br-other" }, { schemaSourceBranchName: "other" },
      { parentBranchId: "br-dry-thunder-awmimouk" }, { environment: "production" }, { disposable: false }]) {
      assert.throws(() => cleanupTarget({ ...target, ...change }, prior, preseed));
    }
  } finally {
    if (oldKey === undefined) delete process.env.G27_EVELYN_NEON_API_KEY; else process.env.G27_EVELYN_NEON_API_KEY = oldKey;
    if (oldProject === undefined) delete process.env.G27_EVELYN_NEON_PROJECT_ID; else process.env.G27_EVELYN_NEON_PROJECT_ID = oldProject;
  }
});

test("CRM browser alias is re-resolved and rejects deployment, commit, team, project and environment drift", async () => {
  const previousFetch = globalThis.fetch;
  const section = { deploymentId: "dpl_synthetic", url: "https://novalure-synthetic-novalure.vercel.app", commitSha: "a".repeat(40) };
  const valid = { id: section.deploymentId, url: new URL(section.url).hostname,
    projectId: "prj_R32Okl6AHijTohvuKmryuTLjWMsk", teamId: "team_sjD78IkSicXJK6TAOR1JC7Wv",
    meta: { githubCommitSha: section.commitSha, githubCommitRef: "codex/crm-production-readiness-g27" },
    readyState: "READY", target: null };
  try {
    globalThis.fetch = async () => Response.json(valid);
    assert.equal(await verifyCrmBrowserBinding(section), crmBrowserOrigin);
    for (const change of [{ id: "dpl_other" }, { url: "other.vercel.app" }, { projectId: "prj_other" },
      { teamId: "team_other" }, { target: "production" }, { readyState: "BUILDING" },
      { meta: { ...valid.meta, githubCommitSha: "b".repeat(40) } },
      { meta: { ...valid.meta, githubCommitRef: "main" } }]) {
      globalThis.fetch = async () => Response.json({ ...valid, ...change });
      await assert.rejects(verifyCrmBrowserBinding(section), /BINDING_MISMATCH/);
    }
  } finally { globalThis.fetch = previousFetch; }
});

test("Preview access token is origin-bound by project/team/environment and expires", () => {
  const claims = { project_id: "prj_R32Okl6AHijTohvuKmryuTLjWMsk", owner_id: "team_sjD78IkSicXJK6TAOR1JC7Wv",
    environment: "development", exp: 2000 };
  const jwt = values => `synthetic.${Buffer.from(JSON.stringify(values)).toString("base64url")}.synthetic`;
  const token = jwt(claims);
  assert.deepEqual(previewAccessHeaders(token, 1000), { "x-vercel-trusted-oidc-idp-token": token });
  for (const change of [{ project_id: "prj_other" }, { owner_id: "team_other" }, { environment: "production" }, { exp: 0 }]) {
    assert.throws(() => previewAccessHeaders(jwt({ ...claims, ...change }), 1000), /BINDING_FAILED/);
  }
});

test("probe caller independently rejects swapped, duplicate, missing and extra pass=true records", () => {
  const control = { name: "control", status: 400, code: "INVALID_INPUT", json: true, noStore: true, noCookie: true, pass: true };
  const foreign = { name: "foreign", status: 401, code: "SERVICE_AUTH_DENIED", json: true, noStore: true, noCookie: true, pass: true };
  assert.equal(exactProbeResults([control, foreign]), true);
  for (const results of [[foreign, control], [control, control], [foreign, foreign], [control],
    [control, foreign, foreign], [control, { ...foreign, status: 400 }], [control, { ...foreign, noCookie: false }]]) {
    assert.equal(exactProbeResults(results), false);
  }
});

test("independent CRM commit preflight prevents signing or invoking a different Preview commit", async () => {
  const previousFetch = globalThis.fetch, previousToken = process.env.G27_VERCEL_API_TOKEN;
  process.env.G27_VERCEL_API_TOKEN = "synthetic-unit-test-token-not-a-credential";
  let reachedSigning = false;
  try {
    globalThis.fetch = async () => Response.json({ id: "dpl_synthetic", projectId: "prj_R32Okl6AHijTohvuKmryuTLjWMsk",
      teamId: "team_sjD78IkSicXJK6TAOR1JC7Wv", readyState: "READY", target: null,
      url: "novalure-synthetic-novalure.vercel.app", gitSource: {
        sha: "b".repeat(40), ref: "codex/crm-production-readiness-g27" } });
    await assert.rejects(async () => {
      await vercelDeploymentEvidence("CRM", { teamId: "team_sjD78IkSicXJK6TAOR1JC7Wv" },
        "https://novalure-synthetic-novalure.vercel.app", { crmDeploymentId: "dpl_synthetic",
          crmCommitSha: "a".repeat(40), crmVercelProjectId: "prj_R32Okl6AHijTohvuKmryuTLjWMsk" });
      reachedSigning = true;
    }, { message: "CRM_DEPLOYMENT_COMMIT_MISMATCH" });
    assert.equal(reachedSigning, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.G27_VERCEL_API_TOKEN;
    else process.env.G27_VERCEL_API_TOKEN = previousToken;
  }
});

test("live runner refuses deployment identity drift before application traffic", async t => {
  const originalFetch = globalThis.fetch;
  const oldToken = process.env.G27_VERCEL_API_TOKEN;
  process.env.G27_VERCEL_API_TOKEN = "synthetic-unit-test-token-not-a-credential";
  const section = { teamId: "team_sjD78IkSicXJK6TAOR1JC7Wv", vercelProjectId: "prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I" };
  const pins = { evelynDeploymentId: "dpl_78AgPzc13Y2LNKFmZKMLpbDhdDiA",
    evelynCommitSha: "1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc" };
  const valid = { id: pins.evelynDeploymentId, projectId: section.vercelProjectId,
    teamId: section.teamId, url: "evelyn-jyh6ijl3u-novalure.vercel.app",
    readyState: "READY", target: null, gitSource: { sha: pins.evelynCommitSha, ref: "codex/evelyn-g27-qa-20260924" } };
  try {
    for (const [label, change, code] of [
      ["exact handoff", {}, null],
      ["wrong deployment", { id: "dpl_other" }, "DEPLOYMENT_ID_MISMATCH"],
      ["wrong project", { projectId: "prj_other" }, "DEPLOYMENT_PROJECT_MISMATCH"],
      ["wrong team", { teamId: "team_other" }, "DEPLOYMENT_TEAM_MISMATCH"],
      ["missing team", { teamId: undefined }, "DEPLOYMENT_TEAM_MISMATCH"],
      ["wrong branch", { gitSource: { ...valid.gitSource, ref: "main" } }, "DEPLOYMENT_BRANCH_MISMATCH"],
      ["wrong commit", { gitSource: { ...valid.gitSource, sha: "0".repeat(40) } }, "DEPLOYMENT_COMMIT_MISMATCH"],
      ["old URL cannot pass through a movable alias", { url: "evelyn-g0yxclae8-novalure.vercel.app",
        alias: [valid.url] }, "DEPLOYMENT_ORIGIN_MISMATCH"],
      ["Production", { target: "production" }, "DEPLOYMENT_NOT_PREVIEW_READY"],
      ["not READY", { readyState: "BUILDING" }, "DEPLOYMENT_NOT_PREVIEW_READY"],
    ]) {
      await t.test(label, async () => {
        let calls = 0;
        globalThis.fetch = async (url, options) => {
          calls++;
          assert.equal(new URL(url).origin, "https://api.vercel.com");
          assert.equal(options.method, "GET");
          assert.equal(options.redirect, "error");
          return Response.json({ ...valid, ...change });
        };
        const run = () => vercelDeploymentEvidence("EVELYN", section,
          "https://evelyn-jyh6ijl3u-novalure.vercel.app", pins);
        if (code) await assert.rejects(run(), { message: `EVELYN_${code}` });
        else assert.equal((await run()).deploymentId, pins.evelynDeploymentId);
        assert.equal(calls, 1);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.G27_VERCEL_API_TOKEN;
    else process.env.G27_VERCEL_API_TOKEN = oldToken;
  }
});
