#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  productionLaunchActivationFlagKey,
  productionLaunchActivationFlagsEnvironment,
  productionLaunchActivationVercelProjectId,
  readProductionLaunchActivationFlag,
  validateProductionLaunchActivationFlagRead,
} from "../src/lib/launch-activation-flag.server.ts";

const metrics = Object.freeze({
  cacheStatus: "MISS",
  connectionState: "disconnected",
  mode: "offline",
  readMs: 1,
  source: "remote",
});

function datafile(overrides = {}) {
  return {
    configUpdatedAt: 1_777_000_000_000,
    definitions: {},
    environment: productionLaunchActivationFlagsEnvironment,
    metrics,
    projectId: productionLaunchActivationVercelProjectId,
    revision: 42,
    segments: {},
    ...overrides,
  };
}

function remoteDatafile(value, revision) {
  return {
    configUpdatedAt: 1_777_000_000_000 + revision,
    definitions: {
      [productionLaunchActivationFlagKey]: {
        environments: {
          [productionLaunchActivationFlagsEnvironment]: 0,
        },
        variants: [value],
      },
    },
    environment: productionLaunchActivationFlagsEnvironment,
    projectId: productionLaunchActivationVercelProjectId,
    revision,
    segments: {},
  };
}

function evaluation(overrides = {}) {
  return {
    outcomeType: "value",
    reason: "fallthrough",
    value: "OFF",
    variantId: "variant_off",
    ...overrides,
  };
}

test("a request-free Core read accepts only a one-shot remote Production MISS", () => {
  assert.deepEqual(
    validateProductionLaunchActivationFlagRead({
      datafile: datafile(),
      result: evaluation(),
    }),
    {
      configUpdatedAtEpochMs: 1_777_000_000_000,
      environment: "production",
      revision: 42,
      value: "OFF",
    },
  );
});

test("cached, streamed, embedded and evaluation-error observations fail closed", () => {
  for (const overrides of [
    { cacheStatus: "HIT" },
    { cacheStatus: "STALE" },
    { connectionState: "connected" },
    { mode: "streaming" },
    { source: "embedded" },
    { source: "in-memory" },
  ]) {
    assert.throws(
      () => validateProductionLaunchActivationFlagRead({
        datafile: datafile({ metrics: { ...metrics, ...overrides } }),
        result: evaluation(),
      }),
      /LAUNCH_FLAGS_REMOTE_FRESHNESS_UNPROVEN/u,
    );
  }
  assert.throws(
    () => validateProductionLaunchActivationFlagRead({
      datafile: datafile(),
      result: evaluation({ reason: "error", value: "OFF" }),
    }),
    /LAUNCH_FLAGS_EVALUATION_ERROR/u,
  );
});

test("project, exact Production environment, revision and timestamp are independently pinned", () => {
  for (const [candidate, expected] of [
    [datafile({ projectId: "prj_wrongcontrolplane" }), /LAUNCH_FLAGS_PROJECT_MISMATCH/u],
    [datafile({ environment: "preview" }), /LAUNCH_FLAGS_ENVIRONMENT_MISMATCH/u],
    [datafile({ revision: 0 }), /LAUNCH_FLAGS_REVISION_INVALID/u],
    [datafile({ configUpdatedAt: "invalid" }), /LAUNCH_FLAGS_CONFIG_TIMESTAMP_INVALID/u],
  ]) {
    assert.throws(
      () => validateProductionLaunchActivationFlagRead({
        datafile: candidate,
        result: evaluation(),
      }),
      expected,
    );
  }
});

test("every refresh creates a new one-shot request and sees GO to OFF without SDK cache replay", async () => {
  const values = ["GO-CAPABILITY", "OFF"];
  let requestCount = 0;
  const fetchImplementation = async (input, init) => {
    assert.match(String(input), /^https:\/\/flags\.vercel\.com\/v1\/datafile$/u);
    assert.ok(init?.signal);
    assert.equal(init?.cache, "no-store");
    const value = values[requestCount];
    requestCount += 1;
    return new Response(JSON.stringify(remoteDatafile(value, 50 + requestCount)), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };
  const environment = { FLAGS: "vf_server_test_sdk_key_20260824" };
  const first = await readProductionLaunchActivationFlag(environment, fetchImplementation);
  const second = await readProductionLaunchActivationFlag(environment, fetchImplementation);
  assert.equal(requestCount, 2);
  assert.equal(first.value, "GO-CAPABILITY");
  assert.equal(second.value, "OFF");
  assert.equal(first.revision, 51);
  assert.equal(second.revision, 52);
});

test("a stalled control-plane request is actively aborted before channel expiry", async () => {
  let abortObserved = false;
  const startedAt = performance.now();
  const stalledFetch = (_input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal);
    const rejectOnAbort = () => {
      abortObserved = true;
      reject(signal.reason ?? new Error("ABORTED"));
    };
    if (signal.aborted) rejectOnAbort();
    else signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  await assert.rejects(
    readProductionLaunchActivationFlag(
      { FLAGS: "vf_server_test_sdk_key_timeout_20260824" },
      stalledFetch,
    ),
    /No flag definitions available/u,
  );
  assert.equal(abortObserved, true);
  assert.ok(performance.now() - startedAt < 4_000);
});
