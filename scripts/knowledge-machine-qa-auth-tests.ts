import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CrmMachineAuthError, verifyCrmMachineToken } from "../src/lib/crm-machine-auth";
import { handleMachineKnowledgeRequest } from "../src/lib/knowledge-center/assistant-http";
import {
  KNOWLEDGE_QA_IDENTITY_ID, KNOWLEDGE_QA_ISSUER, KNOWLEDGE_QA_MAX_TTL_SECONDS,
  KNOWLEDGE_QA_OWNER_ID, KNOWLEDGE_QA_RECEIVER_BRANCH, KNOWLEDGE_QA_RECEIVER_PROJECT_ID,
  KNOWLEDGE_QA_SENDER_PROJECT_ID, KNOWLEDGE_QA_SUBJECT, knowledgeQaAudience,
  resolveKnowledgeQaProfile, verifyKnowledgeQaToken, type KnowledgeQaAuthOptions,
} from "../src/lib/knowledge-center/qa-machine-auth";

const now = new Date("2026-10-20T07:00:00Z"), seconds = now.valueOf() / 1000;
const workspaceId = "603df0e3-5b1f-4a9f-a914-e7986a2d3a08";
const hostname = "novalure-qa123-novalure.vercel.app";
const url = `https://${hostname}/api/integrations/knowledge/voice`;
const token = `eyJ${"a".repeat(20)}.${"b".repeat(24)}.${"c".repeat(24)}`;
const env = {
  NODE_ENV: "production" as const,
  VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview", VERCEL_URL: hostname,
  VERCEL_PROJECT_ID: KNOWLEDGE_QA_RECEIVER_PROJECT_ID, VERCEL_GIT_COMMIT_REF: KNOWLEDGE_QA_RECEIVER_BRANCH,
  CRM_KNOWLEDGE_QA_MACHINE_ENABLED: "1", CRM_KNOWLEDGE_QA_WORKSPACE_ID: workspaceId,
};
const denied = (error: unknown) => error instanceof CrmMachineAuthError && error.status === 403;
type Result = Awaited<ReturnType<NonNullable<KnowledgeQaAuthOptions["verifier"]>>>;
function options(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}): KnowledgeQaAuthOptions {
  return {
    env, now,
    verifier: async (_token, verification) => {
      assert.equal(verification?.issuer, KNOWLEDGE_QA_ISSUER);
      assert.equal(verification?.audience, knowledgeQaAudience(workspaceId));
      assert.equal(verification?.projectId, KNOWLEDGE_QA_SENDER_PROJECT_ID);
      assert.equal(verification?.ownerId, KNOWLEDGE_QA_OWNER_ID);
      assert.equal(verification?.environment, "preview");
      assert.deepEqual(verification?.algorithms, ["RS256"]);
      return {
        payload: {
          aud: knowledgeQaAudience(workspaceId), iss: KNOWLEDGE_QA_ISSUER,
          project_id: KNOWLEDGE_QA_SENDER_PROJECT_ID, owner_id: KNOWLEDGE_QA_OWNER_ID,
          sub: KNOWLEDGE_QA_SUBJECT, environment: "preview", jti: randomUUID(),
          exp: seconds + 3600, iat: seconds - 5, nbf: seconds - 5, ...overrides,
        }, protectedHeader: { alg: "RS256", typ: "JWT", kid: "local-qa-key", ...header },
      } as Result;
    },
  };
}

test("QA accepts only its own exact workload profile and returns a truthful audit identity", async () => {
  const claims = await verifyKnowledgeQaToken(token, url, options());
  assert.equal(claims.identityId, KNOWLEDGE_QA_IDENTITY_ID);
  assert.equal(claims.role, "Evelyn.QA"); assert.equal(claims.environment, "preview");
  assert.equal(claims.workspaceId, workspaceId); assert.equal(claims.projectId, KNOWLEDGE_QA_SENDER_PROJECT_ID);
  assert.equal(claims.subject, KNOWLEDGE_QA_SUBJECT); assert.match(claims.jtiHash, /^[a-f0-9]{64}$/);
  assert(Object.isFrozen(claims));
  assert.equal(resolveKnowledgeQaProfile(url, { NODE_ENV: "test" }) , null);
});

test("QA configuration is explicitly classified as forbidden in Production", async () => {
  const manifest = JSON.parse(await readFile(new URL("../config/vercel-environment-manifest.json", import.meta.url), "utf8"));
  for (const name of ["CRM_KNOWLEDGE_QA_MACHINE_ENABLED", "CRM_KNOWLEDGE_QA_WORKSPACE_ID"]) {
    assert(manifest.previewOnlyOrTestOnly.includes(name));
    assert(manifest.forbiddenInProduction.includes(name));
  }
});

test("QA runtime bindings reject before calling any token verifier", async () => {
  for (const patch of [
    { VERCEL: undefined }, { VERCEL_ENV: "production" }, { VERCEL_TARGET_ENV: "staging" },
    { VERCEL_PROJECT_ID: KNOWLEDGE_QA_SENDER_PROJECT_ID }, { VERCEL_GIT_COMMIT_REF: "main" },
    { VERCEL_GIT_COMMIT_REF: undefined }, { VERCEL_URL: "attacker.invalid" },
    { VERCEL_URL: `https://${hostname}` }, { VERCEL_URL: `${hostname}:443` },
    { CRM_KNOWLEDGE_QA_WORKSPACE_ID: "client-chosen" }, { CRM_KNOWLEDGE_QA_MACHINE_ENABLED: undefined },
  ]) {
    let called = false;
    await assert.rejects(verifyKnowledgeQaToken(token, url, {
      env: { ...env, ...patch }, now, verifier: async () => { called = true; throw new Error("not reached"); },
    }), denied);
    assert.equal(called, false);
  }
  for (const input of [
    `http://${hostname}/api/integrations/knowledge/voice`,
    `https://attacker.invalid/api/integrations/knowledge/voice`,
    `https://user@${hostname}/api/integrations/knowledge/voice`,
    url + "?workspaceId=" + workspaceId, url + "#fragment", `https://${hostname}/api/crm/contract/v1`,
  ]) await assert.rejects(verifyKnowledgeQaToken(token, input, options()), denied);
});

test("QA denies altered claims, missing time claims, oversized TTL and unverified signatures", async () => {
  for (const patch of [
    { aud: "https://vercel.com/novalure" }, { aud: "urn:novalure:crm:production" },
    { aud: knowledgeQaAudience(randomUUID()) }, { iss: "https://issuer.invalid" },
    { project_id: KNOWLEDGE_QA_RECEIVER_PROJECT_ID }, { owner_id: "team_foreign" },
    { environment: "production" }, { environment: "development" },
    { sub: "owner:novalure:project:evelyn:environment:production" }, { sub: "owner:novalure:project:other:environment:preview" },
    { jti: undefined }, { jti: "not-a-uuid" }, { exp: undefined }, { iat: undefined }, { nbf: undefined },
    { exp: seconds - 60 }, { exp: seconds + KNOWLEDGE_QA_MAX_TTL_SECONDS + 1, iat: seconds },
    { iat: seconds + 31 }, { nbf: seconds + 31 }, { nbf: seconds + 3600 }, { exp: seconds + 0.5 },
  ]) await assert.rejects(verifyKnowledgeQaToken(token, url, options(patch)), denied);
  for (const header of [{ alg: "HS256" }, { typ: "OTHER" }, { kid: "" }]) {
    await assert.rejects(verifyKnowledgeQaToken(token, url, options({}, header)), denied);
  }
  await assert.rejects(verifyKnowledgeQaToken(token, url, { env, now, verifier: async () => { throw new Error("bad signature"); } }), denied);
  await assert.rejects(verifyKnowledgeQaToken("not-a-token", url, options()), denied);
});

test("QA does not make the original Production verifier accept Preview", async () => {
  let verifierCalled = false;
  await assert.rejects(verifyCrmMachineToken(token, {
    env: { NODE_ENV: "production", CRM_MACHINE_AUTH_ENABLED: "1", VERCEL_ENV: "preview" },
    verifier: async () => { verifierCalled = true; throw new Error("must not verify"); },
  }), denied);
  assert.equal(verifierCalled, false);
});

test("selected QA auth fails closed without Production fallback or SQL", async () => {
  let productionCalled = false, sqlCalled = false;
  const response = await handleMachineKnowledgeRequest(new Request(url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "synthetic" }),
  }), "voice", {
    qaMachineAuth: options({ environment: "production" }),
    machineAuth: {
      env: { NODE_ENV: "production", VERCEL_ENV: "production", CRM_MACHINE_AUTH_ENABLED: "1" },
      verifier: async () => { productionCalled = true; throw new Error("no fallback"); },
    },
    pool: { connect: async () => { sqlCalled = true; throw new Error("no SQL"); } },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "ASSISTANT_ACCESS_DENIED");
  assert.equal(productionCalled, false); assert.equal(sqlCalled, false);
});
