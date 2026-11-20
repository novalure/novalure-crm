import assert from "node:assert/strict";
import test from "node:test";
import configModule from "../next.config.ts";

test("effective security headers protect CRM and auth without blocking intentional embeds", async () => {
  const config = configModule.default ?? configModule;
  assert.equal(config.poweredByHeader, false);
  const rules = await config.headers();
  const effective = (...sources) => {
    const headers = new Map();
    for (const rule of rules) {
      if (sources.includes(rule.source)) for (const header of rule.headers) headers.set(header.key.toLowerCase(), header.value);
    }
    return headers;
  };
  const baseline = effective("/:path*");
  assert.equal(baseline.get("x-content-type-options"), "nosniff");
  assert.equal(baseline.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.ok(baseline.has("permissions-policy"));
  assert.ok(baseline.has("content-security-policy-report-only"));
  assert.doesNotMatch(baseline.get("strict-transport-security"), /includeSubDomains|preload/i);
  for (const source of ["/", "/login/:path*"]) {
    assert.ok(rules.some(rule => rule.source === source));
    const headers = effective("/:path*", source);
    assert.match(headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(headers.get("x-frame-options"), "DENY");
  }
  for (const source of ["/forms/:path*", "/book/:path*", "/preview/:path*"]) {
    const headers = effective("/:path*", source);
    assert.doesNotMatch(headers.get("content-security-policy"), /frame-ancestors/i);
    assert.equal(headers.has("x-frame-options"), false);
    if (source === "/book/:path*") {
      assert.equal(headers.get("cache-control"), "private, no-store");
      assert.equal(headers.get("referrer-policy"), "no-referrer");
    }
  }
  for (const rule of rules.filter(rule => /^\/(?:forms|book|preview)(?:\/|$)/.test(rule.source))) {
    for (const header of rule.headers) {
      assert.notEqual(header.key.toLowerCase(), "x-frame-options");
      if (header.key.toLowerCase() === "content-security-policy") assert.doesNotMatch(header.value, /frame-ancestors/i);
    }
  }
});
