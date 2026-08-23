#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(
  await readFile("docs/audit/2026-08-23/legal-content-manifest.json", "utf8"),
);

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

test("legal manifest hashes every frozen source byte-for-byte", async () => {
  assert.equal(await sha256(manifest.sharedFacts.path), manifest.sharedFacts.sha256);
  for (const page of manifest.pages) {
    for (const source of page.sourceFiles) {
      assert.equal(await sha256(source.path), source.sha256, source.path);
    }
  }
});

test("every required route has DE and EN but no fabricated approval", () => {
  const routes = new Set(manifest.pages.map((page) => page.route));
  for (const route of [
    "/imprint",
    "/privacy",
    "/terms",
    "/cookies",
    "/data-deletion",
    "/meta",
    "/unsubscribe"
  ]) {
    assert.ok(routes.has(route), route);
  }
  for (const page of manifest.pages) {
    assert.deepEqual(page.languages, ["de", "en"]);
    assert.equal(page.legalStatus, "PENDING");
    assert.equal(page.legalOwner, null);
    assert.equal(page.approvedAt, null);
    assert.equal(page.renderedContentSha256, null);
  }
  assert.equal(manifest.approvalStatus, "PENDING_LEGAL_REVIEW");
  assert.equal(manifest.candidateCommit, null);
  assert.equal(manifest.testedDeployment, null);
});
