import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.doesNotMatch(source, /source:\s*"\/(?:forms|book|preview)/);
});
