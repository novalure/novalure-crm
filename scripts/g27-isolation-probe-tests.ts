import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { probeSignature, runG27IsolationProbe } from "../src/lib/g27-preview-isolation-probe";
import { CRM_VERCEL_PROJECT_ID, NOVALURE_VERCEL_TEAM_ID, EVELYN_V2_PREVIEW_URL } from "../src/lib/evelyn-approval-client";

const now = Date.parse("2026-09-24T12:00:00Z");
const env = { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview",
  VERCEL_PROJECT_ID: CRM_VERCEL_PROJECT_ID, VERCEL_GIT_COMMIT_REF: "codex/crm-production-readiness-g27",
  VERCEL_GIT_COMMIT_SHA: "a".repeat(40), VERCEL_URL: "synthetic-crm-preview.vercel.app",
  NOVALURE_SESSION_SECRET: "synthetic-test-secret-".repeat(3) };
function request(at = now, body?: string) {
  const timestamp = String(at), nonce = randomUUID();
  return new Request(`https://${env.VERCEL_URL}/api/qa/g27-isolation`, { method: "POST", body,
    headers: { "x-g27-time": timestamp, "x-g27-nonce": nonce,
      "x-g27-signature": probeSignature(env.NOVALURE_SESSION_SECRET, timestamp, nonce, env.VERCEL_GIT_COMMIT_SHA) } });
}

test("temporary isolation probe closes outside its exact signed Preview context", async t => {
  for (const [name, override, req, time] of [
    ["Production", { VERCEL_ENV: "production" }, request(), now],
    ["Production target", { VERCEL_TARGET_ENV: "production" }, request(), now],
    ["other project", { VERCEL_PROJECT_ID: "prj_other" }, request(), now],
    ["main", { VERCEL_GIT_COMMIT_REF: "main" }, request(), now],
    ["different commit", { VERCEL_GIT_COMMIT_SHA: "b".repeat(40) }, request(), now],
    ["expired request", {}, request(now - 31000), now],
    ["expired probe", {}, request(), Date.parse("2026-09-25T00:00:00Z")],
    ["wrong signing secret", { NOVALURE_SESSION_SECRET: "wrong".repeat(15) }, request(), now],
    ["wrong origin", { VERCEL_URL: "other.vercel.app" }, request(), now],
  ] as const) {
    await t.test(name, async () => {
      const never = async (): Promise<never> => { throw new Error("Must not acquire tokens or send requests"); };
      const response = await runG27IsolationProbe(req, { ...env, ...override }, { token: never, fetch: never }, time);
      assert.equal(response.status, 404);
    });
  }
  await t.test("caller-supplied body is rejected", async () => {
    const never = async (): Promise<never> => { throw new Error("No transport"); };
    assert.equal((await runG27IsolationProbe(request(now, "{}"), env, { token: never, fetch: never }, now)).status, 400);
  });
});

test("probe sends only the two fixed incomplete cases with distinct fresh OIDC identities", async () => {
  const options: unknown[] = [], sent: { url: string; body: unknown; nonce: string }[] = [];
  const jwt = `test.${Buffer.from(JSON.stringify({ owner_id: NOVALURE_VERCEL_TEAM_ID,
    project_id: CRM_VERCEL_PROJECT_ID, environment: "preview" })).toString("base64url")}.test`;
  const response = await runG27IsolationProbe(request(), env, {
    token: async input => { options.push(input); return jwt; },
    fetch: async (url, input) => {
      const headers = new Headers(input?.headers);
      sent.push({ url: String(url), body: JSON.parse(String(input?.body)), nonce: headers.get("x-evelyn-request-nonce")! });
      assert.equal(input?.redirect, "error");
      return Response.json({ error: sent.length === 1 ? "INVALID_INPUT" : "SERVICE_AUTH_DENIED" },
        { status: sent.length === 1 ? 400 : 401, headers: { "cache-control": "no-store" } });
    },
  }, now);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "PASS");
  assert.deepEqual(sent.map(item => item.body), [
    { action: { tenantId: "afeac3f9-7534-47f5-b749-b3fd91b8f91b" } },
    { action: { tenantId: "d7ec955a-812d-4d3d-a65a-369d8fa9c0c2" } },
  ]);
  assert.ok(sent.every(item => item.url === `${EVELYN_V2_PREVIEW_URL}/api/v2/approvals/requests`));
  assert.notEqual(sent[0].nonce, sent[1].nonce);
  assert.equal(options.length, 4);
  assert.equal(options[1], undefined);
  assert.equal(options[3], undefined);
  assert.equal((options[0] as { skipCache: boolean }).skipCache, true);
  assert.notEqual((options[0] as { jti: string }).jti, (options[2] as { jti: string }).jti);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("probe stops on source identity mismatch or unexpected control response", async t => {
  for (const mode of ["wrong-team", "control-denied", "cookie", "html"] as const) {
    await t.test(mode, async () => {
      let requests = 0;
      const jwt = `test.${Buffer.from(JSON.stringify({ owner_id: mode === "wrong-team" ? "team_other" : NOVALURE_VERCEL_TEAM_ID,
        project_id: CRM_VERCEL_PROJECT_ID, environment: "preview" })).toString("base64url")}.test`;
      const response = await runG27IsolationProbe(request(), env, {
        token: async () => jwt,
        fetch: async () => {
          requests++;
          if (mode === "html") return new Response("<html>Protection</html>", { status: 401 });
          return Response.json({ error: mode === "control-denied" ? "SERVICE_AUTH_DENIED" : "INVALID_INPUT" },
            { status: mode === "control-denied" ? 401 : 400,
              headers: { "cache-control": "no-store", ...(mode === "cookie" ? { "set-cookie": "synthetic=1" } : {}) } });
        },
      }, now);
      assert.notEqual(response.status, 200);
      assert.equal((await response.json()).status, "BLOCKED");
      assert.equal(requests, mode === "wrong-team" ? 0 : 1);
    });
  }
});
