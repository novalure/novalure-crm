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
  // A route can have privacy headers while remaining embeddable. Test the
  // effective configured header values instead of forbidding route entries.
  const { default: config } = await import("../next.config.ts");
  const { getPathMatch } = await import("next/dist/shared/lib/router/utils/path-match.js");
  const rules = await config.headers();
  for (const path of ["/forms", "/forms/example", "/book", "/book/example", "/preview", "/preview/example"]) {
    const effective = new Map();
    for (const rule of rules) if (getPathMatch(rule.source)(path) !== false) {
      for (const header of rule.headers) effective.set(header.key.toLowerCase(), header.value);
    }
    assert.equal(effective.has("x-frame-options"), false, `${path} must remain embeddable`);
    const csp = effective.get("content-security-policy") || "";
    const frameDirective = csp.split(";").map(item => item.trim()).find(item => /^frame-ancestors(?:\s|$)/i.test(item));
    assert.ok(!frameDirective || /^frame-ancestors\s+\*$/i.test(frameDirective), `${path} must remain embeddable`);
  }
});
