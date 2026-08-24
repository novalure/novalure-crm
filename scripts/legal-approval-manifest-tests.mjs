#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  validateReleaseDocumentCandidateState,
  verifyLegalManifestCandidateSources,
} from "./final-preview-release-attestation-contract.mjs";

const manifest = JSON.parse(
  await readFile("docs/audit/2026-08-23/legal-content-manifest.json", "utf8"),
);
const [finalPreviewAttestation, releaseSurfaceManifest, releaseGateMatrix] = await Promise.all([
  readFile(
    "docs/audit/2026-08-23/final-preview-release-attestation.template.json",
    "utf8",
  ).then(JSON.parse),
  readFile("docs/audit/2026-08-23/release-surface-manifest.json", "utf8").then(JSON.parse),
  readFile("docs/audit/2026-08-23/release-gate-matrix.json", "utf8").then(JSON.parse),
]);

function readGit(args, { encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, { encoding, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr ?? ""));
  return result.stdout;
}

test("legal manifest hashes every candidate Git blob byte-for-byte", async () => {
  const candidateCommit = String(readGit(["rev-parse", "--verify", "HEAD"])).trim();
  const sourceSha256 = (path) => createHash("sha256")
    .update(readGit(["show", `${candidateCommit}:${path}`], { encoding: null }))
    .digest("hex");
  assert.equal(sourceSha256(manifest.sharedFacts.path), manifest.sharedFacts.sha256);
  for (const entry of [...manifest.pages, ...manifest.routeAliases, ...manifest.functionalContracts]) {
    for (const source of entry.sourceFiles) {
      assert.equal(sourceSha256(source.path), source.sha256, source.path);
    }
  }
  assert.deepEqual(
    await verifyLegalManifestCandidateSources({ candidateCommit, legalContentManifest: manifest }),
    { candidateCommit, sourceCount: 11, status: "PASS" },
  );
  const tampered = structuredClone(manifest);
  tampered.pages[0].sourceFiles[0].sha256 = "0".repeat(64);
  await assert.rejects(
    verifyLegalManifestCandidateSources({ candidateCommit, legalContentManifest: tampered }),
    /FINAL_ATTESTATION_LEGAL_SOURCE_DIGEST_MISMATCH/u,
  );
});

test("every required route has independent DE and EN render evidence without fabricated approval", () => {
  assert.equal(manifest.schemaVersion, 2);
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
    assert.deepEqual(page.renderedVariants.map((variant) => variant.language), ["de", "en"]);
    for (const variant of page.renderedVariants) {
      assert.equal(variant.renderedContentSha256, null);
      assert.equal(variant.renderStatus, "PENDING_CAPTURE");
      assert.equal(variant.legalStatus, "PENDING");
      assert.equal(variant.legalOwner, null);
      assert.equal(variant.approvedAt, null);
      assert.equal(variant.testedUrl, null);
      assert.equal(new URL(variant.path, "https://release.invalid").searchParams.get("lang"), variant.language);
    }
  }
  assert.equal(manifest.approvalStatus, "PENDING_LEGAL_REVIEW");
  assert.deepEqual(
    validateReleaseDocumentCandidateState({
      attestation: finalPreviewAttestation,
      legalContentManifest: manifest,
      releaseGateMatrix,
      releaseSurfaceManifest,
    }),
    {
      candidateCommit: finalPreviewAttestation.runtime.candidateCommit,
      status: finalPreviewAttestation.status,
    },
  );
  assert.equal(manifest.testedDeployment, null);
});

test("legacy data-deletion alias and unsubscribe confirmation are explicit unsigned contracts", async () => {
  assert.deepEqual(manifest.routeAliases.map((entry) => entry.route), ["/datadeletion"]);
  const alias = manifest.routeAliases[0];
  assert.equal(alias.canonicalRoute, "/data-deletion");
  assert.equal(alias.technicalStatus, "VERIFIED_ALIAS");
  assert.equal(alias.legalStatus, "PENDING");
  assert.equal(alias.legalOwner, null);
  assert.equal(alias.approvedAt, null);
  assert.match(await readFile(alias.sourceFiles[0].path, "utf8"), /export \{ generateMetadata \} from "\.\.\/data-deletion\/page"/);
  assert.match(await readFile(alias.sourceFiles[0].path, "utf8"), /export \{ default \} from "\.\.\/data-deletion\/page"/);

  assert.deepEqual(manifest.functionalContracts.map((entry) => entry.id), ["unsubscribe-confirm"]);
  const unsubscribe = manifest.functionalContracts[0];
  assert.equal(unsubscribe.route, "/unsubscribe/confirm");
  assert.deepEqual(unsubscribe.methods, ["POST"]);
  assert.equal(unsubscribe.technicalStatus, "VERIFIED_BY_SECURITY_TESTS");
  assert.equal(unsubscribe.legalStatus, "PENDING");
  assert.equal(unsubscribe.legalOwner, null);
  assert.equal(unsubscribe.approvedAt, null);
});

test("approval documents preserve the Preview 078/079 addendum without inventing Production or signatures", async () => {
  const approvalPackage = await readFile("docs/audit/2026-08-23/legal-product-approval-package.md", "utf8");
  const providerRunbook = await readFile("docs/audit/2026-08-22/provider-legal-product-approval-runbook.md", "utf8");

  assert.match(approvalPackage, /Migration 078 und die additive Rollenverschärfung 079 wurden[\s\S]*ausschließlich auf der isolierten Preview-Main-Datenbank angewandt/u);
  assert.match(approvalPackage, /Migration 061, 062 und 065 sowie Production blieben unverändert/u);
  assert.doesNotMatch(approvalPackage, /Migration 078 und .*079 sind noch nicht auf Preview/u);
  assert.match(providerRunbook, /technische Matrix `2026-08-22\.12`/u);
  assert.match(providerRunbook, /Spanische Produktoberfläche[\s\S]*`LAUNCH-OFF`/u);
});
