import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { onRequestError } from "../src/instrumentation.ts";

const instrumentationSource = await readFile(
  new URL("../src/instrumentation.ts", import.meta.url),
  "utf8",
);

test("uncaught server errors emit one structured record without URL, message, token or customer data", () => {
  const originalError = console.error;
  const records = [];
  console.error = (value) => records.push(value);

  try {
    onRequestError(
      new Error("secret=do-not-log customer@example.invalid"),
      {
        headers: {
          authorization: "Bearer do-not-log",
          "x-vercel-id": "fra1::safe-request-id",
        },
        method: "POST",
        path: "/api/forms/submissions?token=do-not-log&email=customer@example.invalid",
      },
      {
        revalidateReason: undefined,
        renderSource: "server-rendering",
        renderType: "dynamic",
        routePath: "/api/forms/submissions",
        routeType: "route",
        routerKind: "App Router",
      },
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(records.length, 1);
  const serialized = String(records[0]);
  const record = JSON.parse(serialized);
  assert.equal(record.event, "novalure.request.failed");
  assert.equal(record.level, "error");
  assert.equal(record.method, "POST");
  assert.equal(record.route, "/api/forms/submissions");
  assert.equal(record.requestId, "fra1::safe-request-id");
  for (const forbidden of ["do-not-log", "customer@example.invalid", "authorization", "token="]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  }
});

test("production startup keeps security assertions before the structured ready event", () => {
  const readyLog = instrumentationSource.indexOf('event: "novalure.runtime.ready"');
  assert.ok(readyLog > instrumentationSource.indexOf("assertOAuthStateSecretConfigured();"));
  assert.ok(readyLog > instrumentationSource.indexOf("assertCsrfConfiguration();"));
  assert.ok(readyLog > instrumentationSource.indexOf("assertPublicSubmissionAbuseConfiguration();"));
  assert.ok(readyLog > instrumentationSource.indexOf("assertAuthSecurityConfiguration();"));
  assert.match(instrumentationSource, /process\.env\.NEXT_RUNTIME === "edge" \|\| !isProductionRuntime\(\)/u);
});

test("instrumentation source never serializes raw request paths, headers or error messages", () => {
  const errorHook = instrumentationSource.slice(
    instrumentationSource.indexOf("export const onRequestError"),
    instrumentationSource.indexOf("export async function register"),
  );
  assert.doesNotMatch(errorHook, /request\.path|error\.message|\.stack|JSON\.stringify\(request|headers:/u);
  assert.match(errorHook, /context\.routePath/u);
  assert.match(errorHook, /requestIdFromHeaders\(request\.headers\)/u);
});
