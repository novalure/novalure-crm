import assert from "node:assert/strict";
import test from "node:test";
import { vercelDeploymentEvidence } from "./qa-g27-live-preview.mjs";
import { exactProbeResults } from "./qa-g27-isolation-probe.mjs";

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
