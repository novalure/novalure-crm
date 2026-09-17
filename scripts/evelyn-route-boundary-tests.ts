import assert from "node:assert/strict";
import { test } from "node:test";
import { GET, POST } from "../src/app/api/crm/evelyn-contracts/route";
import { CRM_VERCEL_PROJECT_ID } from "../src/lib/evelyn-approval-client";

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
