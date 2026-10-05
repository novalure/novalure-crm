import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function json(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

test("Production source reconciliation manifest is exact and provenance-safe", async () => {
  const manifest = await json("config/u1-c03-production-source-manifest.json");
  assert.equal(manifest.productionDeployment.id, "dpl_ESYdRFQruH4CcsMnmrnBhZ5vQqah");
  assert.equal(manifest.productionDeployment.gitSha, null);
  assert.equal(manifest.productionOnlyCount, 43);
  assert.equal(manifest.productionOnly.length, 43);
  assert.equal(new Set(manifest.productionOnly.map(({ path }) => path)).size, 43);
  assert.equal(new Set(manifest.productionOnly.map(({ fileId }) => fileId)).size, 43);
  assert.equal(manifest.sourceRecovery.status, "BLOCKED_EXTERNAL");
});

test("environment manifest separates expected names from unverified remote parity", async () => {
  const manifest = await json("config/vercel-environment-manifest.json");
  const required = manifest.runtimeRequired.map(({ name }) => name);
  assert.deepEqual(required, [...required].sort());
  assert.equal(new Set(required).size, required.length);
  assert.equal(manifest.valueInspection, "FORBIDDEN");
  assert.equal(manifest.remoteComparison.valuesRead, false);
  assert.equal(manifest.remoteComparison.status, "PARTIAL");
  for (const name of manifest.forbiddenInProduction) {
    assert.ok(
      manifest.previewOnlyOrTestOnly.includes(name) || name === "NOVALURE_BOT_ALLOW_UNSIGNED_WEBHOOKS",
      `${name} must be explicitly classified`,
    );
  }

  const classified = new Set([
    ...manifest.runtimeRequired.map(({ name }) => name),
    ...manifest.runtimeConditional.flatMap(({ names }) => names),
    ...manifest.databaseAliases.pooledAccepted,
    ...manifest.databaseAliases.unpooledAccepted,
    ...manifest.platformProvided,
    ...manifest.ciBuildFallbacks,
    ...manifest.buildGenerated,
    ...manifest.previewOnlyOrTestOnly,
    ...manifest.forbiddenInProduction,
  ]);
  const sourceFiles = (await readdir(new URL("src/", root), { recursive: true }))
    .filter(path => /\.(?:ts|tsx)$/.test(path));
  sourceFiles.push("next.config.ts");
  const directReferences = new Set();
  for (const path of sourceFiles) {
    const source = await readFile(new URL(path === "next.config.ts" ? path : `src/${path}`, root), "utf8");
    for (const match of source.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[['"]([A-Z0-9_]+)['"]\])/g)) {
      directReferences.add(match[1] ?? match[2]);
    }
  }
  assert.deepEqual(
    [...directReferences].filter(name => !classified.has(name)).sort(),
    [],
    "every directly referenced runtime/build variable must be classified",
  );
});
