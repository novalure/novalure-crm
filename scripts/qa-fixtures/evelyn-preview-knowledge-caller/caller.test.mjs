import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { builtinModules } from "node:module";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { assertPinnedContract, createCaller } from "./caller.mjs";
import { buildCaller, bundleCaller } from "./build.mjs";
import { createNodeHandler } from "./handler.mjs";
import contractDraft from "./contract.json" with { type: "json" };

const contract = { ...contractDraft, receiverOrigin: "https://package4-receiver-test.vercel.app" };
const challenge = randomBytes(32).toString("base64url");
const seconds = Math.floor(Date.now() / 1000);
const runtime = { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_PROJECT_ID: contract.callerProjectId,
  ...Object.fromEntries(contract.blankEnvironmentKeys.map((key) => [key, ""])),
  VERCEL_URL: "package4-caller-test.vercel.app", PACKAGE4_QA_CALLER_CHALLENGE: challenge,
  PACKAGE4_QA_CALLER_EXPIRES_AT: String(seconds + 600) };
const request = (options = {}) => new Request(`https://${runtime.VERCEL_URL}${contract.triggerPath}${options.query ?? ""}`, {
  method: options.method ?? "POST", headers: { "x-package4-qa-challenge": options.challenge ?? challenge,
    "x-do-not-forward": "inbound-private-header", ...(options.headers ?? {}) },
  ...(options.body ? { body: options.body } : {}),
});
const context = (changes = {}) => ({ contractVersion: "knowledge-context-v1", answerStatus: "grounded", fallback: null,
  excerpts: [{ text: `${contract.query} 09:00 synthetic private excerpt`, sourceId: contract.expectedSourceId,
    versionId: contract.expectedVersionId, citation: "Synthetic private title", trust: "retrieved_knowledge_data" }], ...changes });
const response = (body, status = 200) => Response.json(body, { status });

function harness(overrides = {}) {
  const minted = new Map([["native-default", { audience: contract.trustedAudience }]]);
  const tokens = [], verifications = [], requests = [];
  const deps = { contract, env: runtime, now: () => seconds * 1000,
    getToken: async (options) => {
      tokens.push(options);
      if (!options) return "native-default";
      const value = `native-custom-${tokens.length}`;
      minted.set(value, options);
      return value;
    },
    verifyToken: async (token, options) => {
      verifications.push({ token, options });
      const mint = minted.get(token);
      assert.ok(mint);
      assert.equal(options.projectId, contract.callerProjectId);
      assert.equal(options.ownerId, contract.ownerId);
      assert.equal(options.environment, "preview");
      assert.equal(options.subject, contract.subject);
      assert.deepEqual(options.algorithms, ["RS256"]);
      return { protectedHeader: { alg: "RS256", typ: "JWT", kid: "synthetic-key" }, payload: {
        iss: contract.issuer, aud: mint.audience, sub: contract.subject,
        project_id: contract.callerProjectId, owner_id: contract.ownerId, environment: "preview",
        iat: seconds - 30, nbf: seconds - 30, exp: seconds + 600, ...(mint.jti ? { jti: mint.jti } : {}),
      } };
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const bearer = options.headers.authorization?.slice(7);
      return !bearer || minted.get(bearer)?.audience !== contract.audience
        ? response({ code: "ASSISTANT_ACCESS_DENIED", error: "private upstream error" }, 401)
        : response(context());
    },
    ...overrides,
  };
  return { call: createCaller(deps), deps, minted, tokens, verifications, requests };
}

test("unfrozen receiver contract and unsafe runtime/trigger/challenge fail before any OIDC or HTTP", async () => {
  assert.throws(() => assertPinnedContract(contractDraft));
  const cases = [
    { env: { ...runtime, VERCEL_ENV: "production" } },
    { env: { ...runtime, VERCEL_PROJECT_ID: "prj_other" } },
    { env: { ...runtime, VERCEL_URL: "www.example.com" } },
    { env: { ...runtime, PACKAGE4_QA_CALLER_CHALLENGE: "" } },
    { env: { ...runtime, PACKAGE4_QA_CALLER_EXPIRES_AT: String(seconds - 1) } },
    { env: { ...runtime, PACKAGE4_QA_CALLER_EXPIRES_AT: String(seconds + 3601) } },
  ];
  for (const override of cases) {
    const h = harness(override);
    assert.equal((await h.call(request())).status, 403);
    assert.equal(h.tokens.length + h.requests.length, 0);
  }
  for (const input of [request({ method: "GET" }), request({ query: "?url=https://example.com" }),
    request({ challenge: "incorrect" }), request({ body: "{}" }),
    new Request("https://other-test.vercel.app/api/package4-machine-proof", { method: "POST" })]) {
    const h = harness();
    assert.ok((await h.call(input)).status >= 400);
    assert.equal(h.tokens.length + h.requests.length, 0);
  }
});

test("fixed native positive/negative matrix uses exactly two targets and never forwards inbound data or exports tokens/excerpts", async () => {
  const h = harness();
  const result = await h.call(request());
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  const body = await result.json();
  assert.equal(body.status, "PASS");
  assert.deepEqual(body.environmentIsolation, { expectedBlankKeyCount: 15, observedBlankKeyCount: 15, allBlank: true });
  assert.equal(contract.trustedAudience, "https://vercel.com/novalure");
  assert.notEqual(contract.trustedAudience, contract.issuer);
  assert.equal(body.results.length, 8);
  assert.equal(h.requests.length, 8);
  assert.deepEqual(new Set(h.requests.map((r) => r.url)), new Set(contract.channels.map((c) => `${contract.receiverOrigin}${c.path}`)));
  assert.equal(h.tokens.length, 5);
  const mints = h.tokens.filter(Boolean);
  assert.equal(new Set(mints.map((m) => m.jti)).size, 4);
  for (const mint of mints) {
    assert.match(mint.jti, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(mint.skipCache, true);
    assert.ok([contract.audience, `${contract.audience}:denied`].includes(mint.audience));
  }
  for (const item of h.requests) {
    assert.equal(item.options.redirect, "error");
    assert.equal(item.options.method, "POST");
    assert.equal(item.options.headers["x-vercel-trusted-oidc-idp-token"], "native-default");
    assert.equal(item.options.headers["x-do-not-forward"], undefined);
    assert.equal(item.options.headers.cookie, undefined);
    assert.equal(item.options.headers.origin, undefined);
    assert.equal(item.options.headers["x-package4-qa-challenge"], undefined);
    assert.deepEqual(JSON.parse(item.options.body), { query: contract.query,
      maxResults: item.url.endsWith("/voice") ? 3 : 5 });
  }
  for (const scenario of ["missing-bearer", "default-audience", "wrong-audience"]) {
    assert.equal(body.results.filter((r) => r.scenario === scenario && r.expectedDenialMatched).length, 2);
  }
  const serialized = JSON.stringify(body);
  for (const forbidden of [challenge, "native-default", "native-custom", "private upstream error",
    "synthetic private excerpt", "Synthetic private title", "inbound-private-header", "branch", "deploymentId"]) {
    assert.ok(!serialized.includes(forbidden));
  }
});

test("environment isolation rejects inherited or missing credentials before minting and exposes only counts", async () => {
  for (const value of ["synthetic inherited credential never returned", undefined]) {
    const env = { ...runtime, EVELYN_EVM04B_WEBHOOK_SECRET: value };
    const h = harness({ env });
    const result = await h.call(request());
    assert.equal(result.status, 403);
    const body = await result.json();
    assert.equal(body.code, "QA_CALLER_ENVIRONMENT_ISOLATION_DENIED");
    assert.deepEqual(body.environmentIsolation, { expectedBlankKeyCount: 15, observedBlankKeyCount: 14, allBlank: false });
    assert.equal(h.tokens.length + h.verifications.length + h.requests.length, 0);
    assert.ok(!JSON.stringify(body).includes("synthetic inherited credential"));
    assert.ok(!JSON.stringify(body).includes("EVELYN_EVM04B_WEBHOOK_SECRET"));
  }
  for (const blankEnvironmentKeys of [contract.blankEnvironmentKeys.slice(1), [], [...contract.blankEnvironmentKeys, "VERCEL_OIDC_TOKEN"]]) {
    const h = harness({ contract: { ...contract, blankEnvironmentKeys } });
    assert.ok((await h.call(request())).status >= 400);
    assert.equal(h.tokens.length + h.requests.length, 0);
  }
});

test("wrong signed workload identity fails closed before CRM requests", async () => {
  const h = harness();
  const nativeVerify = h.deps.verifyToken;
  h.call = createCaller({ ...h.deps, verifyToken: async (...args) => {
    const verified = await nativeVerify(...args);
    return { ...verified, payload: { ...verified.payload, project_id: "prj_other" } };
  } });
  const result = await h.call(request());
  assert.equal(result.status, 403);
  assert.equal((await result.json()).code, "QA_CALLER_WORKLOAD_DENIED");
  assert.equal(h.requests.length, 0);
});

test("published evidence rejects wrong source/version, draft content, missing marker and excessive excerpts", async () => {
  const first = context().excerpts[0];
  for (const excerpt of [{ ...first, sourceId: randomBytes(16).toString("hex") },
    { ...first, versionId: "00000000-0000-4000-8000-000000000000" },
    { ...first, text: `${contract.query} 09:00 11:00 private draft` },
    { ...first, text: "09:00 without exact unique marker" }, { ...first, trust: "untrusted" }]) {
    const h = harness({ fetchImpl: async () => response(context({ excerpts: [excerpt] })) });
    const body = await (await h.call(request())).json();
    assert.equal(body.status, "FAIL");
    assert.equal(body.results.length, 8);
    assert.equal(body.results[0].matched, false);
    assert.ok(!JSON.stringify(body).includes(excerpt.text));
  }
  const h = harness({ fetchImpl: async () => response(context({ excerpts: Array(6).fill(first) })) });
  assert.equal((await (await h.call(request())).json()).results[0].schemaValid, false);
});

test("Vercel protection HTML, redirect, or unrelated 401 never count as application denial", async () => {
  for (const upstream of [new Response("private protection HTML", { status: 403 }),
    response({ code: "UNRELATED_ERROR" }, 401), response({ code: "ASSISTANT_ACCESS_DENIED" }, 200),
    new Response(null, { status: 307, headers: { location: "https://example.com" } })]) {
    let requests = 0;
    const h = harness({ fetchImpl: async () => ++requests === 1 ? response(context()) : upstream });
    const body = await (await h.call(request())).json();
    assert.equal(body.status, "FAIL");
    assert.equal(body.results.length, 8);
    assert.equal(body.results[1].scenario, "missing-bearer");
    assert.equal(body.results[1].matched, false);
    assert.equal(requests, 8);
    assert.ok(!JSON.stringify(body).includes("private protection HTML"));
  }
});

test("response byte cap cancels the upstream stream and hides content", async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16_385)); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json" } });
  const h = harness({ fetchImpl: async () => upstream });
  const body = await (await h.call(request())).json();
  assert.equal(body.results[0].code, "QA_CALLER_RESPONSE_TOO_LARGE");
  assert.equal(cancelled, true);
});

test("deadline bounds a stalled SDK, late completion cannot start CRM work, and raw failures remain private", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const h = harness({ getToken: () => pending, timeoutMs: 10 });
  const result = await h.call(request());
  assert.equal(result.status, 504);
  assert.equal((await result.json()).code, "QA_CALLER_DEADLINE");
  finish("late-native-token");
  await new Promise(setImmediate);
  assert.equal(h.requests.length + h.verifications.length, 0);
  const failed = harness({ getToken: async () => { throw new Error("sensitive token-like provider detail"); } });
  const body = await (await failed.call(request())).json();
  assert.equal(body.code, "QA_CALLER_FAILED");
  assert.ok(!JSON.stringify(body).includes("sensitive"));
});

test("deadline aborts an in-flight CRM request and prevents any later request", async () => {
  let aborted = false, calls = 0;
  const h = harness({ timeoutMs: 10, fetchImpl: async (_, options) => {
    calls++;
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("synthetic private abort detail", "AbortError"));
    }, { once: true }));
  } });
  const result = await h.call(request());
  assert.equal(result.status, 504);
  assert.equal((await result.json()).code, "QA_CALLER_DEADLINE");
  assert.equal(aborted, true);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
});

test("Node adapter rejects noncanonical raw paths, nonempty or chunked bodies and host mismatch before delegation", async () => {
  const handler = createNodeHandler({ env: runtime, call: async () => { assert.fail("unsafe request delegated"); } });
  for (const req of [
    { method: "GET", url: contract.triggerPath, headers: {} },
    { method: "POST", url: "/api/%70ackage4-machine-proof", headers: {} },
    { method: "POST", url: `${contract.triggerPath}?url=https://example.com`, headers: {} },
    { method: "POST", url: contract.triggerPath, headers: { host: "different.vercel.app" } },
    { method: "POST", url: contract.triggerPath, headers: { "content-length": "2" } },
    { method: "POST", url: contract.triggerPath, headers: { "transfer-encoding": "chunked" } },
  ]) {
    let status, body;
    await handler(req, { writeHead(code) { status = code; }, end(value) { body = value; } });
    assert.equal(status, 400);
    assert.equal(JSON.parse(body).code, "QA_CALLER_TRIGGER_DENIED");
  }
});

test("Node adapter inspects actual and parsed body bytes even without Content-Length", async () => {
  let delegated = 0;
  const handler = createNodeHandler({ env: runtime, bodyTimeoutMs: 10,
    call: async () => { delegated++; return response({ status: "PASS" }); } });
  for (const input of [{ chunks: [Buffer.from("hidden HTTP/2 body")] }, { chunks: [], parsed: {} },
    { chunks: [], parsed: Buffer.from("parsed bytes") }, { chunks: [], stall: true }]) {
    const req = input.stall ? new Readable({ read() {} }) : Readable.from(input.chunks);
    Object.assign(req, { method: "POST", url: contract.triggerPath,
      headers: { host: runtime.VERCEL_URL }, ...(input.parsed ? { body: input.parsed } : {}) });
    let status;
    await handler(req, { writeHead(code) { status = code; }, end() {} });
    assert.equal(status, 400);
    req.destroy();
  }
  assert.equal(delegated, 0);
  const req = Readable.from([]);
  Object.assign(req, { method: "POST", url: contract.triggerPath, headers: { host: runtime.VERCEL_URL } });
  let status;
  await handler(req, { writeHead(code) { status = code; }, end() {} });
  assert.equal(status, 200);
  assert.equal(delegated, 1);
});

test("a revoked voice grant retains all safe per-case proof while webchat remains grounded", async () => {
  const h = harness();
  const nativeFetch = h.deps.fetchImpl;
  h.call = createCaller({ ...h.deps, fetchImpl: async (url, options) => url.endsWith("/voice")
    ? response({ code: "ASSISTANT_ACCESS_DENIED", error: "private binding details" }, 403)
    : nativeFetch(url, options) });
  const result = await h.call(request());
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.status, "FAIL");
  assert.equal(body.results.length, 8);
  assert.equal(body.results[0].matched, true);
  assert.equal(body.results[4].matched, false);
  assert.equal(body.results[4].httpStatus, 403);
  assert.equal(body.results[4].applicationCode, "ASSISTANT_ACCESS_DENIED");
  assert.equal(body.results[4].excerptCount, 0);
  assert.equal(body.results[4].sourceVersionSha256, null);
  assert.ok(body.results.slice(5).every((entry) => entry.expectedDenialMatched));
  assert.ok(!JSON.stringify(body).includes("private binding details"));
});

test("local build bundles pinned SDK/dependencies with only Node builtins external and refuses an unpinned receiver before writing", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "package4-caller-build-test-"));
  const stage = path.join(parent, "stage");
  try {
    await assert.rejects(buildCaller(stage));
    await assert.rejects(access(stage));
    const bundled = await bundleCaller();
    assert.equal(bundled.sdk.version, "3.8.8");
    assert.match(bundled.sdk.lockIntegrity, /^sha512-/);
    assert.ok(bundled.code.includes(Buffer.from("getVercelOidcToken")));
    assert.ok(bundled.inputs.some((input) => input.path.includes("@vercel/oidc/dist/")));
    assert.ok(bundled.inputs.every((input) => !path.isAbsolute(input.path) && !input.path.startsWith("../")));
    assert.ok(builtinModules.length > 0);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
