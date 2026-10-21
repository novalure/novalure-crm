import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { studioEnquiryCandidateBinding, studioEnquiryCandidateRequestAllowed } from "../src/lib/studio-enquiry-candidate";

const origin = "http://127.0.0.1:3000";
const pathname = "/api/public/website-sales/enquiry";
const qaHost = "ep-synthetic-candidate-123-pooler.eu-west-2.aws.neon.tech";
const productionHost = "ep-synthetic-production-456-pooler.eu-west-2.aws.neon.tech";
function profile(): NodeJS.ProcessEnv {
  const url = `postgresql://novalure_app:synthetic-only@${qaHost}/neondb?sslmode=verify-full&channel_binding=require`;
  return {
    NODE_ENV: "test",
    STUDIO_ENQUIRY_CANDIDATE_ENABLED: "1", NOVALURE_QA_PROFILE: "isolated-candidate", CI: "true", GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "novalure/novalure-crm",
    GITHUB_WORKFLOW_REF: "novalure/novalure-crm/.github/workflows/livegang-e2e.yml@refs/heads/codex/evelyn-crm-package4-integration",
    GITHUB_REF: "refs/heads/codex/evelyn-crm-package4-integration", GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "1234567", GITHUB_RUN_ATTEMPT: "2", NOVALURE_QA_RUN_PREFIX: "GOLIVETEST_1234567_2",
    NOVALURE_APP_ORIGIN: origin, NOVALURE_QA_BASE_URL: origin,
    DATABASE_URL: url, NOVALURE_QA_DATABASE_URL: url, NOVALURE_QA_DATABASE_HOST: qaHost,
    NOVALURE_QA_MIGRATION_DATABASE_HOST: qaHost.replace("-pooler.", "."),
    NOVALURE_QA_DATABASE_NAME: "neondb", NOVALURE_QA_DATABASE_ROLE: "novalure_app",
    NOVALURE_QA_PROJECT_ID: "synthetic-candidate-123", NOVALURE_QA_BRANCH_ID: "br-synthetic-candidate-123",
    NOVALURE_PRODUCTION_DATABASE_HOST: productionHost,
    NOVALURE_PRODUCTION_MIGRATION_DATABASE_HOST: productionHost.replace("-pooler.", "."),
    STUDIO_ENQUIRY_SIGNING_SECRET: "SYNTHETIC-ONLY-NOT-A-CREDENTIAL-1234567890",
    STUDIO_ENQUIRY_QA_EMAILS_JSON: '["studio-candidate-1234567-2@example.invalid"]',
    STUDIO_ENQUIRY_QA_PHONES_JSON: "[]",
  };
}
const request = (url = origin + pathname, method = "POST") => ({ url, method });

test("only the complete local Actions profile yields public target coordinates", () => {
  assert.deepEqual(studioEnquiryCandidateBinding(profile()), {
    host: qaHost, name: "neondb", role: "novalure_app", project: "synthetic-candidate-123", branch: "br-synthetic-candidate-123",
  });
  assert.equal(studioEnquiryCandidateRequestAllowed(request(), profile()), true);
  const optionalOwner = profile(); delete optionalOwner.NOVALURE_QA_MIGRATION_DATABASE_HOST;
  assert.ok(studioEnquiryCandidateBinding(optionalOwner));
});

test("only the two reviewed branch and workflow pairs admit the isolated candidate profile", () => {
  const reviewedRefs = [
    "refs/heads/codex/evelyn-crm-package4-integration",
    "refs/heads/codex/crm-ux-i18n-polish",
  ];
  for (const ref of reviewedRefs) {
    const env = profile();
    env.GITHUB_REF = ref;
    env.GITHUB_WORKFLOW_REF = `novalure/novalure-crm/.github/workflows/livegang-e2e.yml@${ref}`;
    assert.ok(studioEnquiryCandidateBinding(env), ref);
    assert.equal(studioEnquiryCandidateRequestAllowed(request(), env), true, ref);
    for (const otherRef of reviewedRefs.filter(other => other !== ref)) {
      assert.equal(studioEnquiryCandidateBinding({ ...env,
        GITHUB_WORKFLOW_REF: `novalure/novalure-crm/.github/workflows/livegang-e2e.yml@${otherRef}`,
      }), null, "Separately approved refs cannot be mixed into an unreviewed pair");
    }
    for (const workflow of [
      `novalure/novalure-crm/.github/workflows/other.yml@${ref}`,
      `foreign/novalure-crm/.github/workflows/livegang-e2e.yml@${ref}`,
    ]) assert.equal(studioEnquiryCandidateBinding({ ...env, GITHUB_WORKFLOW_REF: workflow }), null, workflow);
  }
  for (const ref of ["refs/heads/main", "refs/pull/95/merge", "refs/tags/codex/crm-ux-i18n-polish",
    "refs/heads/codex/crm-ux-i18n-polish-copy", "refs/heads/codex/unreviewed-candidate"]) {
    const env = profile();
    env.GITHUB_REF = ref;
    env.GITHUB_WORKFLOW_REF = `novalure/novalure-crm/.github/workflows/livegang-e2e.yml@${ref}`;
    assert.equal(studioEnquiryCandidateBinding(env), null, ref);
  }
});

test("NextRequest loopback normalization retains the exact original candidate Host", () => {
  const frameworkRequest = new NextRequest(origin + pathname, {
    method: "POST", headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(new URL(frameworkRequest.url).origin, "http://localhost:3000");
  assert.equal(studioEnquiryCandidateRequestAllowed(frameworkRequest, profile()), true);
  for (const host of ["localhost:3000", "127.0.0.2:3000", "[::1]:3000", "attacker.invalid",
    "127.0.0.1:3001", "127.0.0.1:3000, attacker.invalid", ""]) {
    const otherHost = new NextRequest(origin + pathname, {
      method: "POST", headers: { host, "x-forwarded-host": "127.0.0.1:3000" },
    });
    assert.equal(studioEnquiryCandidateRequestAllowed(otherHost, profile()), false, host);
  }
  assert.equal(studioEnquiryCandidateRequestAllowed(request("http://localhost:3000" + pathname), profile()), false);
  for (const url of ["http://localhost:3001" + pathname, "https://localhost:3000" + pathname,
    "http://localhost:3000" + pathname + "?extra=1", "http://localhost:3000/wrong-path"]) {
    assert.equal(studioEnquiryCandidateRequestAllowed(new NextRequest(url, {
      method: "POST", headers: { host: "127.0.0.1:3000" },
    }), profile()), false);
  }
});

test("missing or changed trust/run fields cannot activate the candidate profile", () => {
  for (const key of ["STUDIO_ENQUIRY_CANDIDATE_ENABLED", "NOVALURE_QA_PROFILE", "CI", "GITHUB_ACTIONS", "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY", "GITHUB_WORKFLOW_REF", "GITHUB_REF", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
    "NOVALURE_QA_RUN_PREFIX", "NOVALURE_APP_ORIGIN", "NOVALURE_QA_BASE_URL"]) {
    for (const value of [undefined, "unexpected"]) {
      const env = profile(); env[key] = value;
      assert.equal(studioEnquiryCandidateBinding(env), null, key);
    }
  }
  for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_PROJECT_ID", "VERCEL_URL"]) {
    const env = profile(); env[key] = "";
    assert.equal(studioEnquiryCandidateBinding(env), null, key);
  }
});

test("production, owner, unbound, mismatched and non-Neon targets are refused", () => {
  for (const key of ["DATABASE_URL", "NOVALURE_QA_DATABASE_URL", "NOVALURE_QA_DATABASE_HOST", "NOVALURE_QA_DATABASE_NAME",
    "NOVALURE_QA_DATABASE_ROLE", "NOVALURE_QA_PROJECT_ID", "NOVALURE_QA_BRANCH_ID",
    "NOVALURE_PRODUCTION_DATABASE_HOST", "NOVALURE_PRODUCTION_MIGRATION_DATABASE_HOST"]) {
    const env = profile(); delete env[key]; assert.equal(studioEnquiryCandidateBinding(env), null, key);
  }
  for (const [key, value] of [
    ["NOVALURE_QA_PROJECT_ID", "misty-cloud-70835427"], ["NOVALURE_QA_BRANCH_ID", "br-snowy-fog-aldx77v8"],
    ["NOVALURE_QA_DATABASE_ROLE", "neondb_owner"], ["NOVALURE_QA_DATABASE_NAME", "postgres"],
    ["NOVALURE_QA_MIGRATION_DATABASE_HOST", productionHost.replace("-pooler.", ".")],
  ]) { const env = profile(); env[key] = value; assert.equal(studioEnquiryCandidateBinding(env), null, key); }
  for (const host of [productionHost, productionHost.replace("-pooler.", "."), "attacker.invalid", `${qaHost}.attacker.invalid`]) {
    const env = profile(); env.NOVALURE_QA_DATABASE_HOST = host;
    env.DATABASE_URL = env.NOVALURE_QA_DATABASE_URL = env.DATABASE_URL!.replace(qaHost, host);
    assert.equal(studioEnquiryCandidateBinding(env), null, host);
  }
});

test("connection routing overrides and nested/duplicate SSL options are rejected", () => {
  for (const suffix of ["&host=attacker.invalid", "&hostaddr=127.0.0.1", "&port=5433", "&user=neondb_owner",
    "&dbname=postgres", "&database=postgres", "&options=-c%20neon.project_id%3Dforged",
    "&%68ost=attacker.invalid", "&sslmode=disable", "&sslmode=require", "&channel_binding=disable", "#fragment"]) {
    const env = profile(); env.DATABASE_URL = env.NOVALURE_QA_DATABASE_URL = env.DATABASE_URL! + suffix;
    assert.equal(studioEnquiryCandidateBinding(env), null, suffix);
  }
  for (const mutate of [
    (url: string) => url.replace("novalure_app:", "neondb_owner:"),
    (url: string) => url.replace(qaHost, `${qaHost}:5433`),
    (url: string) => url.replace("/neondb?", "/postgres?"),
    (url: string) => url.replace("synthetic-only@", "@"),
    (url: string) => url.replace("verify-full", "disable"),
  ]) {
    const env = profile(); env.DATABASE_URL = env.NOVALURE_QA_DATABASE_URL = mutate(env.DATABASE_URL!);
    assert.equal(studioEnquiryCandidateBinding(env), null);
  }
  const valid = profile(); valid.DATABASE_URL = valid.NOVALURE_QA_DATABASE_URL = valid.DATABASE_URL!.replace("verify-full", "require");
  assert.ok(studioEnquiryCandidateBinding(valid));
});

test("HMAC input and recipient configuration is exact, bounded to one synthetic run", () => {
  for (const value of [undefined, "", "too-short", " ".repeat(40), " " + "x".repeat(32)]) {
    const env = profile(); env.STUDIO_ENQUIRY_SIGNING_SECRET = value;
    assert.equal(studioEnquiryCandidateBinding(env), null);
  }
  for (const emails of ["", "null", "[]", "{}", '["other@example.invalid"]',
    '["studio-candidate-1234567-2@example.invalid","other@example.invalid"]']) {
    const env = profile(); env.STUDIO_ENQUIRY_QA_EMAILS_JSON = emails;
    assert.equal(studioEnquiryCandidateBinding(env), null);
  }
  for (const phones of [undefined, "null", "{}", '["+353000000000"]']) {
    const env = profile(); env.STUDIO_ENQUIRY_QA_PHONES_JSON = phones;
    assert.equal(studioEnquiryCandidateBinding(env), null);
  }
});

test("only POST to the exact loopback enquiry endpoint is admitted", () => {
  for (const url of ["https://www.novalure-crm.app" + pathname, "https://foreign.invalid" + pathname,
    "http://localhost:3000" + pathname, "http://127.0.0.1:3001" + pathname, origin + "/api/public/website-sales",
    origin + pathname + "?target=production", origin + pathname + "#fragment", origin + pathname + "/",
    "http://user:password@127.0.0.1:3000" + pathname, "invalid"]) {
    assert.equal(studioEnquiryCandidateRequestAllowed(request(url), profile()), false, url);
  }
  for (const method of ["GET", "PUT", "DELETE", "OPTIONS", "post"]) {
    assert.equal(studioEnquiryCandidateRequestAllowed(request(undefined, method), profile()), false, method);
  }
});
