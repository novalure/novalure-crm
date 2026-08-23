import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { onRequestError } from "../src/instrumentation.ts";

const instrumentationSource = await readFile(
  new URL("../src/instrumentation.ts", import.meta.url),
  "utf8",
);
const reservationRepositorySource = await readFile(
  new URL("../src/lib/db/reservation-repositories.ts", import.meta.url),
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
          "x-request-id": "caller-controlled@example.invalid",
          "x-vercel-id": "forged::platform-id",
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
  assert.match(record.requestId, /^internal:[0-9a-f-]{36}$/u);
  for (const forbidden of [
    "do-not-log",
    "customer@example.invalid",
    "caller-controlled",
    "forged::platform-id",
    "authorization",
    "token=",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  }
});

test("caller-supplied request ids are always ignored", () => {
  const originalError = console.error;
  const records = [];
  console.error = (value) => records.push(value);

  try {
    onRequestError(
      new Error("not logged"),
      {
        headers: {
          "x-request-id": "customer@example.invalid",
          "x-vercel-id": "forged::platform-id",
        },
        method: "GET",
        path: "/private?token=not-logged",
      },
      {
        revalidateReason: undefined,
        renderSource: "server-rendering",
        renderType: "dynamic",
        routePath: "/private",
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
  assert.match(record.requestId, /^internal:[0-9a-f-]{36}$/u);
  assert.doesNotMatch(serialized, /customer@example\.invalid|forged::platform-id|not-logged/u);
});

test("even well-formed platform-shaped request ids are not trusted without verification", () => {
  const originalError = console.error;
  const records = [];
  console.error = (value) => records.push(value);

  try {
    onRequestError(
      new Error("not logged"),
      {
        headers: { "x-vercel-id": "fra1::iad1::platform-shaped-id" },
        method: "GET",
        path: "/private",
      },
      {
        revalidateReason: undefined,
        renderSource: "server-rendering",
        renderType: "dynamic",
        routePath: "/private",
        routeType: "route",
        routerKind: "App Router",
      },
    );
  } finally {
    console.error = originalError;
  }

  const serialized = String(records[0]);
  assert.match(JSON.parse(serialized).requestId, /^internal:[0-9a-f-]{36}$/u);
  assert.doesNotMatch(serialized, /fra1::iad1::platform-shaped-id|not logged/u);
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
  assert.match(errorHook, /createInternalRequestId\(\)/u);
  assert.doesNotMatch(instrumentationSource, /x-request-id|x-vercel-id/u);
  assert.match(instrumentationSource, /globalThis\.crypto\.randomUUID\(\)/u);
});

test("reservation stage telemetry uses only fixed codes and a bounded action", () => {
  const logger = reservationRepositorySource.slice(
    reservationRepositorySource.indexOf("function warnMissingReservationDealStage"),
    reservationRepositorySource.indexOf("function isTerminalDealStage"),
  );

  assert.match(logger, /event: "reservation\.deal_stage_sync_skipped"/u);
  assert.match(logger, /reasonCode: "stage_not_configured"/u);
  assert.match(logger, /action: warning\.action/u);
  assert.doesNotMatch(logger, /warning\.(?:projectId|candidates|reason)/u);
  assert.doesNotMatch(logger, /projectId|candidates/u);
});
