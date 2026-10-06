import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const packageManifestUrl = new URL("config/u1-c04-production-source-package-manifest.json", root);
const normalizedTextEditorSha256 = "d14f395bccfaa3988dfdaa8f4b31c69033f21cd05aac149637a23a6ec80abafe";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("the verified U1-C04 package manifest records all recovered sources", async () => {
  const manifest = JSON.parse(await readFile(packageManifestUrl, "utf8"));
  assert.equal(manifest.package, "U1-C04-PRODUCTION-SOURCE-INGEST");
  assert.equal(manifest.productionDeployment.id, "dpl_ESYdRFQruH4CcsMnmrnBhZ5vQqah");
  assert.equal(manifest.sourceManifest.expected, 43);
  assert.equal(manifest.sourceManifest.verified, 43);
  assert.equal(manifest.recovery.status, "COMPLETE");
  assert.equal(manifest.recovery.filesRecoveredExact, 43);
  assert.equal(manifest.files.length, 43);
  assert.equal(new Set(manifest.files.map(({ path }) => path)).size, 43);
  assert.equal(new Set(manifest.files.map(({ fileId }) => fileId)).size, 43);
});

test("every committed source matches the recovered content after Git line normalization", async () => {
  const manifest = JSON.parse(await readFile(packageManifestUrl, "utf8"));
  for (const file of manifest.files) {
    const raw = await readFile(new URL(file.path, root), "utf8");
    const canonical = raw.replace(/\r\n/g, "\n");
    const expected = file.path === "src/components/property-text-editor.tsx"
      ? normalizedTextEditorSha256
      : file.sha256;
    assert.equal(sha256(canonical), expected, file.path);
  }
});
