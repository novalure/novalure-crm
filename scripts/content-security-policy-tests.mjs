#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import { createContentSecurityPolicy } from "../src/lib/security/content-security-policy.ts";

test("production page CSP is nonce-enforced and blocks framing by default", () => {
  const policy = createContentSecurityPolicy({
    development: false,
    nonce: "test-nonce",
    pathName: "/login",
  });

  assert.match(policy, /script-src 'self' 'nonce-test-nonce' 'strict-dynamic'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.match(policy, /script-src-attr 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /upgrade-insecure-requests/);
});

test("only intentional public embed routes omit frame-ancestors", () => {
  for (const pathName of [
    "/forms/workspace/form",
    "/book/workspace/meeting",
    "/preview/funnel-id",
  ]) {
    const policy = createContentSecurityPolicy({
      development: false,
      nonce: "test-nonce",
      pathName,
    });
    assert.doesNotMatch(policy, /frame-ancestors/);
  }

  for (const pathName of ["/", "/privacy", "/api/private"]) {
    assert.match(
      createContentSecurityPolicy({ development: false, nonce: "test-nonce", pathName }),
      /frame-ancestors 'none'/,
    );
  }
});

test("static fallback is fully enforced while development permits required tooling", () => {
  const productionFallback = createContentSecurityPolicy({
    development: false,
    pathName: "/forms/public",
  });
  const development = createContentSecurityPolicy({
    development: true,
    nonce: "dev-nonce",
    pathName: "/",
  });

  assert.match(productionFallback, /default-src 'self'/);
  assert.match(productionFallback, /script-src 'self' 'unsafe-inline'/);
  assert.match(development, /'unsafe-eval'/);
  assert.match(development, /connect-src 'self' https: http: ws: wss:/);
  assert.doesNotMatch(development, /upgrade-insecure-requests/);
});
