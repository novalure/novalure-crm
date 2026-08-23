#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import test from "node:test";

await import("./legal-approval-manifest-tests.mjs");

const appRoot = join(process.cwd(), "src", "app");
const sourceRoot = join(process.cwd(), "src");
const manifestPath = "docs/audit/2026-08-23/release-surface-manifest.json";
const matrixPath = "docs/audit/2026-08-23/release-gate-matrix.json";
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
const {
  launchScopeDecisions,
  launchScopePolicy,
  launchScopePolicyApproval,
  launchScopePolicyVersion,
} = await import("../src/lib/launch-scope.ts");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

function projectPath(path) {
  return relative(process.cwd(), path).split(sep).join("/");
}

function routeFromFile(path, basename) {
  const relativePath = relative(appRoot, path).split(sep).join("/");
  const suffix = `/${basename}`;
  const route = `/${relativePath.slice(0, -suffix.length)}`;
  return route === "/" ? "/" : route.replace(/\/$/u, "");
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicate values`);
}

async function assertPathsExist(paths, label) {
  for (const path of paths) {
    await assert.doesNotReject(access(path), `${label} references missing path ${path}`);
  }
}

const appFiles = await walk(appRoot);
const sourceFiles = await walk(sourceRoot);
const pages = appFiles
  .filter((path) => path.endsWith(`${sep}page.tsx`))
  .map((path) => routeFromFile(path, "page.tsx"))
  .sort();
const handlers = appFiles
  .filter((path) => path.endsWith(`${sep}route.ts`))
  .map((path) => routeFromFile(path, "route.ts"))
  .sort();
const apiRoutes = handlers.filter((route) => route.startsWith("/api/"));
const nonApiRouteHandlers = handlers.filter((route) => !route.startsWith("/api/"));
const cronRoutes = apiRoutes.filter((route) => route.startsWith("/api/cron/"));

test("release surface manifest is an exact filesystem inventory of every routable file", () => {
  assert.deepEqual(manifest.pages, pages);
  assert.deepEqual(manifest.nonApiRouteHandlers, nonApiRouteHandlers);
  assert.deepEqual(manifest.apiRoutes, apiRoutes);
  assert.deepEqual(manifest.cronRoutes, cronRoutes);
  assert.deepEqual(manifest.publicLocales, ["de", "en", "es"]);
  assert.equal(pages.length, 19);
  assert.equal(nonApiRouteHandlers.length, 4);
  assert.equal(apiRoutes.length, 89);
  assert.equal(cronRoutes.length, 4);
});

test("navigation inventory exactly matches the central navigation-entry map", async () => {
  const workspace = await readFile("src/components/crm-workspace.tsx", "utf8");
  const start = workspace.indexOf("const navigationEntries:");
  const end = workspace.indexOf("const restrictedAdminNavigationEntries", start);
  assert.ok(start >= 0 && end > start, "central navigation map could not be located");
  const discovered = [...workspace.slice(start, end).matchAll(/^  ([A-Za-z][A-Za-z0-9]*):/gmu)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(manifest.navigationEntries, discovered);
  assert.equal(discovered.length, 51);
  assertUnique(manifest.navigationEntries, "navigationEntries");
});

test("server-action absence is exhaustively checked and fails closed if a directive is added", async () => {
  const discovery = manifest.serverActionDiscovery;
  assert.equal(discovery.checkedRoot, "src");
  assert.deepEqual(discovery.checkedExtensions, [".js", ".jsx", ".ts", ".tsx"]);
  assert.deepEqual(discovery.directivePatterns, ["\"use server\"", "'use server'"]);
  assert.equal(discovery.result, "VERIFIED_NONE");

  const checkedExtensions = new Set(discovery.checkedExtensions);
  const discovered = [];
  for (const path of sourceFiles.filter((sourceFile) => checkedExtensions.has(extname(sourceFile)))) {
    const source = await readFile(path, "utf8");
    if (/(?:^|\n)\s*["']use server["'];?\s*(?:\r?\n|$)/u.test(source)) {
      discovered.push(projectPath(path));
    }
  }

  assert.deepEqual(manifest.serverActions, discovered.sort());
  assert.deepEqual(manifest.serverActions, []);
});

test("cron inventory exactly matches vercel schedules, routes and worker symbols", async () => {
  const vercel = JSON.parse(await readFile("vercel.json", "utf8"));
  const expected = [...vercel.crons]
    .map(({ path: route, schedule }) => ({ route, schedule }))
    .sort((left, right) => left.route.localeCompare(right.route));
  const actual = manifest.cronJobs
    .map(({ route, schedule }) => ({ route, schedule }))
    .sort((left, right) => left.route.localeCompare(right.route));

  assert.deepEqual(actual, expected);
  assert.deepEqual(sortedUnique(manifest.cronJobs.map((job) => job.route)), manifest.cronRoutes);
  assertUnique(manifest.cronJobs.map((job) => job.id), "cronJobs ids");
  for (const job of manifest.cronJobs) {
    const source = await readFile(job.sourceFile, "utf8");
    assert.match(source, new RegExp(`\\b${job.worker}\\b`, "u"), `${job.id} worker not found in route source`);
  }
});

test("all persisted job tables and queue/background implementations are inventoried", async () => {
  const discoveredJobTables = new Set();
  for (const path of sourceFiles.filter((sourceFile) => [".ts", ".tsx"].includes(extname(sourceFile)))) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/\b(?:from|insert\s+into|update)\s+([a-z][a-z0-9_]*_jobs)\b/giu)) {
      discoveredJobTables.add(match[1]);
    }
  }
  const inventoriedJobTables = manifest.queueAndBackgroundJobs
    .map((job) => job.storageTable)
    .filter((table) => typeof table === "string" && table.endsWith("_jobs"));

  assert.deepEqual(sortedUnique(inventoriedJobTables), [...discoveredJobTables].sort());
  assertUnique(manifest.queueAndBackgroundJobs.map((job) => job.id), "queueAndBackgroundJobs ids");
  for (const job of manifest.queueAndBackgroundJobs) {
    assert.match(job.implementationStatus, /^[A-Z0-9_]+$/u);
    await assertPathsExist([...job.producerFiles, ...job.consumerFiles], `queue ${job.id}`);
  }
  const propertyExport = manifest.queueAndBackgroundJobs.find((job) => job.id === "property-export-queue");
  assert.equal(propertyExport?.implementationStatus, "ENQUEUE_ONLY_NO_CONSUMER_LAUNCH_OFF");
  assert.deepEqual(propertyExport?.consumerFiles, []);
  assert.deepEqual(propertyExport?.triggerRoutes, ["/api/crm/properties"]);
  assert.equal(propertyExport?.launchScopeKey, "propertyExportQueue");
});

test("every direct external-provider fetch implementation is classified", async () => {
  const providerFetchFiles = [];
  for (const path of sourceFiles.filter((sourceFile) => sourceFile.endsWith(".ts"))) {
    const normalized = projectPath(path);
    const isProviderBoundary =
      normalized.startsWith("src/lib/integrations/") ||
      normalized === "src/lib/bots/provider-actions.ts" ||
      normalized === "src/lib/db/google-notification-repositories.ts" ||
      normalized === "src/lib/db/teams-notification-repositories.ts";
    if (!isProviderBoundary) continue;
    const source = await readFile(path, "utf8");
    if (/\bfetch\s*\(/u.test(source)) providerFetchFiles.push(normalized);
  }
  const inventoriedFiles = manifest.providerSideEffects.flatMap((effect) => effect.sourceFiles);

  assert.deepEqual(sortedUnique(inventoriedFiles), sortedUnique(providerFetchFiles));
  assertUnique(manifest.providerSideEffects.map((effect) => effect.id), "providerSideEffects ids");
  for (const effect of manifest.providerSideEffects) {
    await assertPathsExist(effect.sourceFiles, `provider effect ${effect.id}`);
    if (effect.launchScopeKey === null) {
      assert.match(effect.implementationStatus, /WITHOUT_CENTRAL_LAUNCH_SCOPE/u);
    }
  }
  assert.equal(
    manifest.providerSideEffects.find((effect) => effect.id === "bot-model-completion")?.launchScopeKey,
    "authenticatedBotModelProvider",
  );
  assert.equal(
    manifest.providerSideEffects.find((effect) => effect.id === "bot-knowledge-embedding")?.launchScopeKey,
    "externalEmbeddingProvider",
  );
});

test("webhook, public-form/funnel, internal-admin and Blob categories match code-backed boundaries", async () => {
  assert.deepEqual(
    manifest.webhooks.map((entry) => entry.id).sort(),
    ["bot-channel-inbound", "funnel-submission-outbound", "google-chat-outbound", "teams-outbound"],
  );
  assertUnique(manifest.webhooks.map((entry) => entry.id), "webhooks ids");
  for (const webhook of manifest.webhooks) await assertPathsExist(webhook.sourceFiles, `webhook ${webhook.id}`);

  const expectedPublicSurfaces = sortedUnique([
    ...manifest.pages.filter((route) => route.startsWith("/forms/") || route.startsWith("/preview/")),
    ...manifest.nonApiRouteHandlers.filter((route) => route === "/forms/embed"),
    ...manifest.apiRoutes.filter((route) =>
      route === "/api/forms/resolve" ||
      route.startsWith("/api/forms/submission") ||
      (route.startsWith("/api/funnels/") && !route.endsWith("/publish-token/rotate"))),
  ]);
  const actualPublicSurfaces = sortedUnique(manifest.publicFormsAndFunnels.flatMap((entry) => entry.surfaces));
  assert.deepEqual(actualPublicSurfaces, expectedPublicSurfaces);
  assertUnique(manifest.publicFormsAndFunnels.map((entry) => entry.id), "publicFormsAndFunnels ids");

  const workspace = await readFile("src/components/crm-workspace.tsx", "utf8");
  const restrictedBlock = workspace.match(/const restrictedAdminNavigationEntries = new Set<NavigationEntryId>\(\[([\s\S]*?)\]\);/u);
  assert.ok(restrictedBlock, "restricted admin navigation set could not be located");
  const restrictedNavigation = [...restrictedBlock[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/gu)]
    .map((match) => `navigation:${match[1]}`);
  const expectedAdminSurfaces = sortedUnique([
    ...manifest.apiRoutes.filter((route) => route.startsWith("/api/admin/") || route === "/api/system/database"),
    ...manifest.pages.filter((route) => route.startsWith("/visual-qa/")),
    ...restrictedNavigation,
  ]);
  const actualAdminSurfaces = sortedUnique(manifest.internalAdminSurfaces.flatMap((entry) => entry.surfaces));
  assert.deepEqual(actualAdminSurfaces, expectedAdminSurfaces);
  assertUnique(manifest.internalAdminSurfaces.map((entry) => entry.id), "internalAdminSurfaces ids");

  const blobMutationPattern = /\b(?:deleteWorkspaceMedia|publishWorkspaceMedia|revokeWorkspaceMediaPublication|saveWorkspaceFile)\b/u;
  const discoveredBlobMutationFiles = [];
  for (const path of sourceFiles.filter((sourceFile) => [".ts", ".tsx"].includes(extname(sourceFile)))) {
    const source = await readFile(path, "utf8");
    if (blobMutationPattern.test(source)) discoveredBlobMutationFiles.push(projectPath(path));
  }
  const runtimeBlobSources = manifest.blobWriteSurfaces
    .flatMap((entry) => entry.sourceFiles)
    .filter((path) => path.startsWith("src/"));
  assert.deepEqual(sortedUnique(runtimeBlobSources), sortedUnique(discoveredBlobMutationFiles));
  assertUnique(manifest.blobWriteSurfaces.map((entry) => entry.id), "blobWriteSurfaces ids");
  for (const entry of manifest.blobWriteSurfaces) {
    await assertPathsExist(entry.sourceFiles, `Blob surface ${entry.id}`);
    assert.equal(
      entry.launchScopeKey,
      entry.id === "legacy-blob-cutover-cli" ? null : "mediaBlobMutation",
      `${entry.id} has the wrong Blob mutation launch-scope classification`,
    );
  }
});

test("central gap remediations have one stable release-gate decision each", () => {
  const expected = new Map([
    ["authenticatedBotModelProvider", "scope.authenticated-bot-model-provider"],
    ["externalEmbeddingProvider", "provider.embeddings"],
    ["mediaBlobMutation", "api.media"],
    ["propertyExportQueue", "jobs.property-export"],
    ["publicSpanishLocale", "scope.public-spanish-locale"],
  ]);

  for (const [launchScopeKey, surfaceId] of expected) {
    const matches = matrix.surfaces.filter((surface) => surface.launchScopeKey === launchScopeKey);
    assert.equal(matches.length, 1, `${launchScopeKey} must map to exactly one release-gate surface`);
    assert.equal(matches[0].id, surfaceId);
    assert.equal(matches[0].launchScopeNotApplicableReason, null);
    assert.ok(matches[0].tests.includes("scripts/launch-scope-fail-closed-tests.mjs"));
  }
});

test("unsigned inventory and release matrix cannot claim a candidate or signature", () => {
  for (const document of [manifest, matrix]) {
    assert.equal(document.approvalStatus, "PENDING_SIGNATURE");
    assert.equal(document.candidateCommit, null);
    assert.match(document.baselineCommit, /^[a-f0-9]{40}$/u);
  }
  assert.equal(launchScopePolicyApproval, "PENDING_SIGNATURE");
  assert.equal(matrix.launchScopePolicyVersion, launchScopePolicyVersion);
  assert.deepEqual(matrix.signatures, {
    engineering: null,
    operations: null,
    product: null,
    security: null,
  });
  assert.deepEqual(matrix.specialDecisions.unitBuyerDealRelationship, {
    launchScopeKey: "propertyReservationRelationshipSync",
    decision: "OFF",
    status: "PENDING_SIGNATURE",
    decisionDocument: "docs/audit/2026-08-22/unit-buyer-deal-decision.md",
    requiredSignatures: {
      product: null,
      salesOperations: null,
      engineering: null,
      dataCompliance: null,
    },
  });
});

test("release matrix has one complete decision for every launch-scope rule", async () => {
  const desiredByDecision = {
    [launchScopeDecisions.internalOnly]: "INTERNAL",
    [launchScopeDecisions.off]: "OFF",
    [launchScopeDecisions.on]: "ON",
  };
  const scopeSurfaces = matrix.surfaces.filter((surface) => surface.launchScopeKey !== null);
  const scopeKeys = scopeSurfaces.map((surface) => surface.launchScopeKey).sort();

  assert.deepEqual(scopeKeys, Object.keys(launchScopePolicy).sort());
  assertUnique(scopeKeys, "release matrix launchScopeKey values");
  assertUnique(matrix.surfaces.map((surface) => surface.id), "release matrix surface ids");

  for (const surface of matrix.surfaces) {
    assert.match(surface.id, /^[a-z0-9][a-z0-9.-]+$/u);
    assert.ok(surface.function.trim(), `${surface.id} has no function`);
    assert.ok(Array.isArray(surface.routeApiJob) && surface.routeApiJob.length > 0, `${surface.id} has no route/API/job`);
    assert.ok(surface.currentTechnicalStatus.trim(), `${surface.id} has no technical status`);
    assert.ok(["ON", "OFF", "INTERNAL"].includes(surface.desiredLaunchStatus), `${surface.id} has invalid launch status`);
    assert.deepEqual(surface.owners, { technical: "UNASSIGNED", product: "UNASSIGNED", legal: "UNASSIGNED" });
    assert.ok(Array.isArray(surface.tests) && surface.tests.length > 0, `${surface.id} has no test paths`);
    assert.ok(Array.isArray(surface.evidencePaths) && surface.evidencePaths.length > 0, `${surface.id} has no evidence paths`);
    assert.ok(surface.rollbackBehavior.trim(), `${surface.id} has no rollback behavior`);
    assert.ok(Array.isArray(surface.inventorySelectors), `${surface.id} has no inventory selector list`);
    await assertPathsExist(surface.tests, `${surface.id} tests`);
    await assertPathsExist(surface.evidencePaths, `${surface.id} evidence`);

    if (surface.launchScopeKey === null) {
      assert.ok(surface.launchScopeNotApplicableReason?.trim(), `${surface.id} lacks a launch-scope N/A reason`);
    } else {
      assert.equal(surface.launchScopeNotApplicableReason, null);
      assert.equal(
        surface.desiredLaunchStatus,
        desiredByDecision[launchScopePolicy[surface.launchScopeKey].decision],
        `${surface.id} does not match the checked-in launch decision`,
      );
    }
  }
});

test("every manifest item is assigned to exactly one release-matrix surface", () => {
  const categoryValues = {
    publicLocales: manifest.publicLocales,
    pages: manifest.pages,
    nonApiRouteHandlers: manifest.nonApiRouteHandlers,
    apiRoutes: manifest.apiRoutes,
    navigationEntries: manifest.navigationEntries,
    serverActions: manifest.serverActions,
    cronRoutes: manifest.cronRoutes,
    cronJobs: manifest.cronJobs.map((entry) => entry.id),
    queueAndBackgroundJobs: manifest.queueAndBackgroundJobs.map((entry) => entry.id),
    webhooks: manifest.webhooks.map((entry) => entry.id),
    providerSideEffects: manifest.providerSideEffects.map((entry) => entry.id),
    publicFormsAndFunnels: manifest.publicFormsAndFunnels.map((entry) => entry.id),
    internalAdminSurfaces: manifest.internalAdminSurfaces.map((entry) => entry.id),
    blobWriteSurfaces: manifest.blobWriteSurfaces.map((entry) => entry.id),
  };
  const assignments = new Map();

  for (const [category, values] of Object.entries(categoryValues)) {
    assertUnique(values, `${category} inventory`);
    for (const value of values) assignments.set(`${category}:${value}`, []);
  }

  for (const surface of matrix.surfaces) {
    for (const selector of surface.inventorySelectors) {
      const values = categoryValues[selector.category];
      assert.ok(values, `${surface.id} references unknown inventory category ${selector.category}`);
      assert.notEqual(Boolean(selector.values), Boolean(selector.prefix), `${surface.id} selector needs values xor prefix`);
      const matched = selector.values
        ? selector.values
        : values.filter((value) => value.startsWith(selector.prefix));
      assert.ok(matched.length > 0, `${surface.id} selector matches no ${selector.category} values`);
      assertUnique(matched, `${surface.id} ${selector.category} selector`);
      for (const value of matched) {
        const key = `${selector.category}:${value}`;
        assert.ok(assignments.has(key), `${surface.id} assigns unknown inventory value ${key}`);
        assignments.get(key).push(surface.id);
      }
    }
  }

  const invalidAssignments = [...assignments]
    .filter(([, surfaceIds]) => surfaceIds.length !== 1)
    .map(([key, surfaceIds]) => ({ key, surfaceIds }));
  assert.deepEqual(invalidAssignments, []);
});
