import assert from "node:assert/strict";
import { test } from "node:test";
import { GET, POST } from "../src/app/api/crm/evelyn-contracts/route";
import { CRM_VERCEL_PROJECT_ID } from "../src/lib/evelyn-approval-client";
import { getSessionCookieOptions } from "../src/lib/auth/session";
import { getLoginChallengeCookieOptions } from "../src/lib/auth/auth-flow";
import { getPasswordResetExchangeCookieOptions } from "../src/lib/auth/password-reset";

// These are local HTTP boundary regressions, never live workload identity evidence.
test("G08 route rejects service bearer and forged Owner headers in every runtime scope", async t => {
  const keys = ["VERCEL", "VERCEL_ENV", "VERCEL_TARGET_ENV", "VERCEL_PROJECT_ID"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const cases = [
      { name: "local identity, including spoofed HTTP headers", values: {} },
      { name: "Production runtime", values: { VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_ID: CRM_VERCEL_PROJECT_ID } },
      { name: "foreign Preview project", values: { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_PROJECT_ID: "prj_Foreign" } },
      { name: "Production target despite Preview ENV", values: { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "production", VERCEL_PROJECT_ID: CRM_VERCEL_PROJECT_ID } },
    ];
    for (const scenario of cases) await t.test(scenario.name, async () => {
      for (const key of keys) delete process.env[key];
      Object.assign(process.env, scenario.values);
      for (const [method, handler] of [["GET", GET], ["POST", POST]] as const) {
        const response = await handler(new Request("https://synthetic.invalid/api/crm/evelyn-contracts", {
          method, headers: { "x-vercel-env": "preview", "x-vercel-project-id": CRM_VERCEL_PROJECT_ID, "x-novalure-role": "owner", authorization: "Bearer qa-crm-v1.synthetic-untrusted-identity" },
        }));
        assert.ok([401, 403].includes(response.status));
      }
    });
  } finally {
    for (const key of keys) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
});

test("Preview MFA session, challenge and reset cookies use HTTPS without changing localhost behavior", async t => {
  const keys = ["VERCEL", "VERCEL_ENV", "NODE_ENV"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const cases = [
    { name: "actual Vercel Preview", values: { VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production" }, secure: true },
    { name: "Vercel Production", values: { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" }, secure: true },
    { name: "Vercel development", values: { VERCEL: "1", VERCEL_ENV: "development", NODE_ENV: "development" }, secure: false },
    { name: "localhost development", values: { NODE_ENV: "development" }, secure: false },
    { name: "standalone Production", values: { NODE_ENV: "production" }, secure: true },
    { name: "local Preview-shaped browser harness", values: { VERCEL_ENV: "preview", NODE_ENV: "production" }, secure: false },
    { name: "trimmed Vercel Preview", values: { VERCEL: "1", VERCEL_ENV: " preview " }, secure: true },
  ];
  try {
    for (const scenario of cases) await t.test(scenario.name, () => {
      for (const key of keys) delete process.env[key];
      Object.assign(process.env, scenario.values);
      for (const options of [getSessionCookieOptions, getLoginChallengeCookieOptions, getPasswordResetExchangeCookieOptions]) {
        for (const maxAge of [60, 0]) {
          const cookie = options(maxAge);
          assert.equal(cookie.secure, scenario.secure);
          assert.equal(cookie.httpOnly, true);
          assert.equal(cookie.sameSite, "lax");
          assert.equal(cookie.maxAge, maxAge);
          if (maxAge === 0) assert.equal(cookie.expires?.getTime(), 0);
        }
      }
    });
  } finally {
    for (const key of keys) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
});
