import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("security headers protect CRM and auth without blocking intentional embeds", async () => {
  const source = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  const proxy = await readFile(new URL("../src/proxy.ts", import.meta.url), "utf8");
  const policy = await readFile(
    new URL("../src/lib/security/content-security-policy.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /poweredByHeader:\s*false/);
  assert.match(source, /X-Content-Type-Options[\s\S]*nosniff/);
  assert.match(source, /Referrer-Policy[\s\S]*strict-origin-when-cross-origin/);
  assert.match(source, /Permissions-Policy/);
  assert.doesNotMatch(source, /Content-Security-Policy-Report-Only/);
  assert.match(source, /createContentSecurityPolicy/);
  assert.match(source, /source:\s*"\/"[\s\S]*source:\s*"\/login\/:path\*"/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(source, /X-Frame-Options[\s\S]*DENY/);
  assert.match(policy, /script-src 'self' 'nonce-\$\{nonce\}' 'strict-dynamic'/);
  assert.match(policy, /script-src-attr 'none'/);
  assert.match(proxy, /requestHeaders\.set\("x-nonce", nonce\)/);
  assert.match(proxy, /response\.headers\.set\("content-security-policy", contentSecurityPolicy\)/);
  assert.match(proxy, /x-content-security-policy-mode/);
  assert.match(proxy, /secure: process\.env\.NODE_ENV === "production"/);
  assert.doesNotMatch(source, /includeSubDomains|preload/);
  assert.match(policy, /embeddedPublicPathPrefixes = \["\/book\/", "\/forms\/", "\/preview\/"\]/);
});
