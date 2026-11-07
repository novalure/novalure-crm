import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";
import configImport from "../next.config.ts";

const { match } = createRequire(import.meta.url)("next/dist/compiled/path-to-regexp");
// The optional tsx runner wraps this CommonJS project export once; native Node does not.
const nextConfig = typeof configImport.headers === "function" ? configImport : configImport.default;

test("security headers protect CRM and auth without blocking intentional embeds", async () => {
  const source = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");

  assert.match(source, /poweredByHeader:\s*false/);
  assert.match(source, /X-Content-Type-Options[\s\S]*nosniff/);
  assert.match(source, /Referrer-Policy[\s\S]*strict-origin-when-cross-origin/);
  assert.match(source, /Permissions-Policy/);
  assert.match(source, /Content-Security-Policy-Report-Only/);
  assert.match(source, /source:\s*"\/"[\s\S]*source:\s*"\/login\/:path\*"/);
  assert.match(source, /frame-ancestors 'none'/);
  assert.match(source, /X-Frame-Options[\s\S]*DENY/);
  assert.doesNotMatch(source, /includeSubDomains|preload/);
  // Privacy headers on a public route must not be mistaken for a frame ban.
  // Resolve the actual ordered Next rules, including generic rules and overrides.
  const rules = await nextConfig.headers();
  const headersFor = (path) => {
    const headers = new Map();
    for (const rule of rules) {
      if (match(rule.source)(path)) {
        for (const header of rule.headers) headers.set(header.key.toLowerCase(), header.value);
      }
    }
    return headers;
  };
  for (const path of ["/", "/login", "/login/reset"]) {
    const headers = headersFor(path);
    assert.equal(headers.get("x-frame-options"), "DENY", path);
    assert.match(headers.get("content-security-policy"), /frame-ancestors 'none'/, path);
  }
  for (const path of ["/forms", "/forms/example", "/book", "/book/example", "/preview", "/preview/example"]) {
    const headers = headersFor(path);
    assert.equal(headers.has("x-frame-options"), false, path);
    assert.doesNotMatch(headers.get("content-security-policy") ?? "", /frame-ancestors/, path);
    assert.equal(headers.get("x-content-type-options"), "nosniff", path);
  }
  const bookingHeaders = headersFor("/book/example");
  assert.match(bookingHeaders.get("cache-control"), /private, no-store/);
  assert.equal(bookingHeaders.get("referrer-policy"), "no-referrer");
  assert.match(bookingHeaders.get("x-robots-tag"), /noindex/);
});
