import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateDependencyLicensePolicy } from "./dependency-license-policy.mjs";

test("current lockfile has complete explicitly allowed license metadata", () => {
  const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const result = evaluateDependencyLicensePolicy(lockfile);
  assert.deepEqual(result.errors, []);
  assert.ok(result.packages > 500);
  assert.ok(result.licenses > 10);
});

test("license policy fails closed on missing, unknown and linked package metadata", () => {
  for (const entry of [
    { version: "1.0.0" },
    { license: "AGPL-3.0-only", version: "1.0.0" },
    { license: "MIT", link: true, version: "1.0.0" },
  ]) {
    const result = evaluateDependencyLicensePolicy({
      lockfileVersion: 3,
      packages: { "": { name: "private-app" }, "node_modules/example": entry },
    });
    assert.ok(result.errors.length > 0);
  }
});
